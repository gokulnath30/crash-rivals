import type { Match } from '@domain/lobby/match.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import type {
  Channel,
  LinkDiagnostics,
  LinkState,
  PeerLinkPort,
  PeerPayload,
} from '@app/ports/peer-link.port.ts';
import type { SeatIndex } from '@domain/lobby/match.ts';
import type { IceCandidate, SignalRole, SignalingPort } from '@app/ports/signaling.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';
import type { IceSettings } from '@config/env.ts';

/**
 * The direct browser-to-browser link.
 *
 * Two data channels, because the two kinds of traffic want opposite
 * guarantees:
 *
 *   'fast' — unordered, `maxRetransmits: 0`. Pose frames. A frame that has to
 *            be resent arrives after the frame that superseded it, so
 *            retransmitting one actively makes the fight worse. Dropping it is
 *            the correct behaviour.
 *   'sure' — ordered and reliable. Hits, knockouts, round changes. Losing one
 *            of these desynchronises the two screens permanently.
 */
export class WebRtcPeerLink implements PeerLinkPort {
  state: LinkState = 'idle';
  role: SignalRole | null = null;
  latencyMs: number | null = null;

  private connection: RTCPeerConnection | null = null;
  private fast: RTCDataChannel | null = null;
  private sure: RTCDataChannel | null = null;

  /**
   * Reserved up front, before the offer is made, so media can be added later
   * without renegotiating.
   *
   * The camera is not asked for until the player starts the game, which is
   * well after the handshake. Adding a track to a live connection normally
   * means a fresh offer and answer — and by then the signalling documents have
   * been deleted, so there is nowhere to exchange one. Declaring the media
   * sections in the *original* offer and swapping tracks into them with
   * `replaceTrack` sidesteps that entirely.
   */
  private videoSender: RTCRtpSender | null = null;
  private audioSender: RTCRtpSender | null = null;
  /**
   * Built on the first arriving track rather than up front: a link that never
   * carries media should not conjure a MediaStream, and not every environment
   * this class is constructed in even has one.
   */
  private remote: MediaStream | null = null;
  private readonly mediaListeners = new Set<Listener<MediaStream>>();

  private readonly dataListeners = new Set<Listener<PeerPayload>>();
  private readonly stateListeners = new Set<Listener<LinkState>>();
  private readonly teardown: Unsubscribe[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Remembered so the handshake documents can be tidied once we are direct. */
  private matchId: Match['id'] | null = null;
  /**
   * The guest seat of the pair this link connects.
   *
   * A link is one edge of the star, not the whole room: the host holds one per
   * guest, and every signalling document is named after this seat so those
   * handshakes stay out of each other's way.
   */
  private pairSeat: SeatIndex = 0;

  /**
   * Remote ICE candidates that arrived before we had a remote description to
   * attach them to. See `acceptCandidate` — this queue is the difference
   * between a match that connects and one that does not.
   */
  private readonly earlyCandidates: IceCandidate[] = [];
  private remoteDescriptionSet = false;

  /**
   * The handshake is applied exactly once. `signalingState` cannot be used to
   * decide this: it reads 'stable' both before an offer is applied and again
   * after the handshake completes, so a re-delivered snapshot would look
   * indistinguishable from a fresh one and renegotiate a live connection.
   */
  private offerApplied = false;
  private answerApplied = false;

  /** Runs while ICE is disconnected, to see whether it comes back. */
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Evidence for `diagnostics`, gathered as the handshake proceeds. */
  private readonly localTypes = new Set<string>();
  private remoteCandidateCount = 0;

  private readonly log: LoggerPort;

  constructor(
    private readonly signaling: SignalingPort,
    private readonly ice: IceSettings,
    logger: LoggerPort,
  ) {
    this.log = logger.scoped('webrtc');
  }

  async openAsHost(match: Match, seat: SeatIndex): Promise<Result<void>> {
    if (this.state !== 'idle') {
      return fail(failure('transport-failed', 'This link has already been used.'));
    }
    this.role = 'host';
    this.pairSeat = seat;
    this.moveTo('connecting');

    const connection = this.createConnection(match, 'host');

    // The host creates both channels; the guest receives them via ondatachannel.
    this.attach('fast', connection.createDataChannel('fast', FAST_CHANNEL));
    this.attach('sure', connection.createDataChannel('sure', SURE_CHANNEL));

    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (!offer.sdp) {
        return fail(failure('transport-failed', 'The browser produced an empty offer.'));
      }

      const published = await this.signaling.publishOffer({
        matchId: match.id,
        seat,
        description: { type: 'offer', sdp: offer.sdp },
      });
      if (!published.ok) return published;

      this.teardown.push(
        this.signaling.observeAnswer({ matchId: match.id, seat }, (description) => {
          // Firestore re-delivers a document on reconnect. Applying the answer
          // a second time would renegotiate a working connection, so the guard
          // is a one-shot flag rather than a look at `signalingState`.
          if (this.answerApplied) return;
          this.answerApplied = true;
          void connection
            .setRemoteDescription({ type: 'answer', sdp: description.sdp })
            .then(() => this.flushCandidates())
            .catch((error: unknown) => {
              this.answerApplied = false;
              this.log.log('warn', 'could not apply the answer', error);
            });
        }),
      );

      return ok(undefined);
    } catch (error: unknown) {
      this.log.log('error', 'host handshake failed', error);
      this.moveTo('failed');
      return fail(failure('transport-failed', 'Could not start the connection.'));
    }
  }

  async openAsGuest(match: Match, seat: SeatIndex): Promise<Result<void>> {
    if (this.state !== 'idle') {
      return fail(failure('transport-failed', 'This link has already been used.'));
    }
    this.role = 'guest';
    // A guest's own seat names its pair with the host.
    this.pairSeat = seat;
    this.moveTo('connecting');

    const connection = this.createConnection(match, 'guest');

    // The guest does not create channels; it adopts the host's.
    connection.ondatachannel = (event) => {
      const label = event.channel.label;
      if (label === 'fast' || label === 'sure') this.attach(label, event.channel);
    };

    return new Promise<Result<void>>((resolve) => {
      let settled = false;
      const settle = (result: Result<void>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      this.teardown.push(
        this.signaling.observeOffer({ matchId: match.id, seat }, (description) => {
          // One-shot for the same reason as the answer above.
          if (this.offerApplied) return;
          this.offerApplied = true;
          void this.answer(connection, match, description.sdp).then(settle);
        }),
      );

      // If the host's offer never turns up, the pairing service's own timeout
      // is what surfaces it; this promise simply resolves once we have replied.
    });
  }

  send(channel: Channel, data: ArrayBuffer | string): void {
    const target = channel === 'fast' ? this.fast : this.sure;
    if (!target || target.readyState !== 'open') return;
    try {
      // `send` is overloaded per payload type rather than taking a union, so
      // the branch is required even though both arms read identically.
      if (typeof data === 'string') target.send(data);
      else target.send(data);
    } catch (error: unknown) {
      this.log.log('debug', 'send failed', error);
    }
  }

  onData(listener: Listener<PeerPayload>): Unsubscribe {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onStateChange(listener: Listener<LinkState>): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  attachLocalMedia(stream: MediaStream): void {
    const video = stream.getVideoTracks()[0] ?? null;
    const audio = stream.getAudioTracks()[0] ?? null;

    // `replaceTrack` on a sender that already has a media section needs no
    // renegotiation, which is the entire reason the transceivers exist.
    void this.videoSender?.replaceTrack(video).catch((error: unknown) => {
      this.log.log('warn', 'could not send the camera', error);
    });
    void this.audioSender?.replaceTrack(audio).catch((error: unknown) => {
      this.log.log('warn', 'could not send the microphone', error);
    });

    if (video) this.limitVideoBitrate();
  }

  onRemoteMedia(listener: Listener<MediaStream>): Unsubscribe {
    this.mediaListeners.add(listener);
    // A track may already have arrived before anyone asked to hear about it.
    if (this.remote) listener(this.remote);
    return () => this.mediaListeners.delete(listener);
  }

  setMicrophoneMuted(muted: boolean): void {
    const track = this.audioSender?.track;
    if (track) track.enabled = !muted;
  }

  setCameraMuted(muted: boolean): void {
    // Only the outgoing copy. Pose tracking reads the camera locally and is
    // unaffected, so muting the picture does not stop you fighting.
    const track = this.videoSender?.track;
    if (track) track.enabled = !muted;
  }

  /**
   * Keeps the video to a small share of the connection.
   *
   * It is a thumbnail beside the game, not the game — and the pose frames
   * that decide the fight are on the same connection. Left uncapped, the
   * encoder will happily take a couple of megabits and starve them.
   */
  private limitVideoBitrate(): void {
    const sender = this.videoSender;
    if (!sender) return;
    try {
      const parameters = sender.getParameters();
      parameters.encodings = [
        { maxBitrate: VIDEO_MAX_BITRATE, maxFramerate: VIDEO_MAX_FPS, scaleResolutionDownBy: 2 },
      ];
      void sender.setParameters(parameters).catch((error: unknown) => {
        this.log.log('debug', 'could not cap the video bitrate', error);
      });
    } catch (error: unknown) {
      this.log.log('debug', 'video parameters unavailable', error);
    }
  }

  close(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.cancelDisconnectTimer();
    this.earlyCandidates.length = 0;
    for (const stop of this.teardown.splice(0)) stop();
    this.fast?.close();
    this.sure?.close();
    this.fast = null;
    this.sure = null;
    for (const track of this.remote?.getTracks() ?? []) this.remote?.removeTrack(track);
    this.remote = null;
    this.mediaListeners.clear();
    this.videoSender = null;
    this.audioSender = null;
    if (this.connection) {
      this.connection.onicecandidate = null;
      this.connection.ondatachannel = null;
      this.connection.onconnectionstatechange = null;
      this.connection.ontrack = null;
      this.connection.close();
      this.connection = null;
    }
    if (this.state !== 'failed') this.moveTo('closed');
    this.dataListeners.clear();
    this.stateListeners.clear();
  }

  private async answer(
    connection: RTCPeerConnection,
    match: Match,
    offerSdp: string,
  ): Promise<Result<void>> {
    try {
      await connection.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      // The host has been publishing candidates since it called
      // setLocalDescription, so some are already queued. They can be added now.
      await this.flushCandidates();
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      if (!answer.sdp) {
        return fail(failure('transport-failed', 'The browser produced an empty answer.'));
      }
      // Awaited inside the try, so a rejection is caught here rather than
      // escaping to the caller.
      return await this.signaling.publishAnswer({
        matchId: match.id,
        seat: this.pairSeat,
        description: { type: 'answer', sdp: answer.sdp },
      });
    } catch (error: unknown) {
      this.offerApplied = false;
      this.log.log('error', 'guest handshake failed', error);
      this.moveTo('failed');
      return fail(failure('transport-failed', 'Could not answer the connection.'));
    }
  }

  private createConnection(match: Match, role: SignalRole): RTCPeerConnection {
    const iceServers: RTCIceServer[] = [{ urls: [...this.ice.stunUrls] }];
    if (this.ice.turn) {
      iceServers.push({
        urls: this.ice.turn.url,
        username: this.ice.turn.username,
        credential: this.ice.turn.credential,
      });
    }

    const connection = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 4 });
    this.connection = connection;
    this.matchId = match.id;

    // Both sides add these, in this order, so the two descriptions line up.
    this.videoSender = connection.addTransceiver('video', { direction: 'sendrecv' }).sender;
    this.audioSender = connection.addTransceiver('audio', { direction: 'sendrecv' }).sender;

    connection.ontrack = (event) => {
      const stream = (this.remote ??= new MediaStream());
      stream.addTrack(event.track);
      // Fires per track, so listeners see the stream twice — once with video,
      // once with both. They are expected to just re-attach it.
      for (const listener of this.mediaListeners) listener(stream);
    };

    connection.onicecandidate = (event) => {
      if (!event.candidate) {
        // A null candidate means gathering has finished. What we ended up with
        // is the single most useful fact when a connection fails.
        this.log.log('info', `ICE gathering complete: ${this.gatheredSummary()}`);
        return;
      }
      const type = candidateType(event.candidate.candidate);
      if (type) this.localTypes.add(type);
      void this.signaling.addCandidate({
        matchId: match.id,
        seat: this.pairSeat,
        from: role,
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        },
      });
    };

    const theirRole: SignalRole = role === 'host' ? 'guest' : 'host';
    this.teardown.push(
      this.signaling.observeCandidates(
        { matchId: match.id, seat: this.pairSeat, from: theirRole },
        (candidate) => {
          this.remoteCandidateCount += 1;
          this.acceptCandidate(candidate);
        },
      ),
    );

    connection.onconnectionstatechange = () => {
      switch (connection.connectionState) {
        case 'connected':
          // Back on its feet — cancel any pending give-up. The channels
          // themselves are what decide 'open'; 'connected' is not yet sendable.
          this.cancelDisconnectTimer();
          break;

        case 'disconnected':
          // Transient. ICE reports 'disconnected' for an ordinary network
          // hiccup — a Wi-Fi roam, a phone changing cell — and usually
          // recovers on its own within a few seconds. Tearing the match down
          // here is what makes a playable connection look like a dropped one.
          this.startDisconnectTimer();
          break;

        case 'failed':
          this.cancelDisconnectTimer();
          this.log.log(
            'warn',
            `ICE failed. Gathered locally: ${this.gatheredSummary()}. ` +
              `Remote candidates received: ${this.remoteCandidateCount}. ` +
              `TURN configured: ${this.ice.turn !== null}.`,
          );
          this.moveTo('failed');
          break;

        case 'closed':
          this.cancelDisconnectTimer();
          this.moveTo('closed');
          break;

        default:
          break;
      }
    };

    return connection;
  }

  private attach(name: Channel, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    if (name === 'fast') this.fast = channel;
    else this.sure = channel;

    channel.onopen = () => {
      // Open only once *both* channels are, so a game never starts able to
      // send poses but not hits.
      if (this.fast?.readyState === 'open' && this.sure?.readyState === 'open') {
        this.moveTo('open');
        this.startPinging();
        this.tidyHandshakeLater();
      }
    };
    channel.onclose = () => {
      if (this.state === 'open') this.moveTo('closed');
    };
    channel.onerror = (event) => {
      this.log.log('warn', `data channel ${name} errored`, event);
    };
    channel.onmessage = (event) => {
      const data: unknown = event.data;
      if (name === 'sure' && typeof data === 'string' && this.handlePing(data)) return;
      if (typeof data === 'string' || data instanceof ArrayBuffer) {
        for (const listener of this.dataListeners) listener({ channel: name, data });
      }
    };
  }

  /**
   * Round-trip time, measured on the reliable channel. Shown in the HUD so a
   * player can see whether the fight is laggy or they are simply losing.
   */
  private startPinging(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = setInterval(() => {
      this.send('sure', `${PING_PREFIX}${Date.now()}`);
    }, PING_INTERVAL_MS);
  }

  private handlePing(message: string): boolean {
    if (message.startsWith(PING_PREFIX)) {
      this.send('sure', `${PONG_PREFIX}${message.slice(PING_PREFIX.length)}`);
      return true;
    }
    if (message.startsWith(PONG_PREFIX)) {
      const sentAt = Number(message.slice(PONG_PREFIX.length));
      if (Number.isFinite(sentAt)) this.latencyMs = Date.now() - sentAt;
      return true;
    }
    return false;
  }

  /**
   * Takes a remote ICE candidate, holding it back if there is nowhere to put
   * it yet.
   *
   * This queue is load-bearing. Both peers subscribe to the other's candidates
   * before they have a remote description: the host starts emitting candidates
   * the moment it calls `setLocalDescription`, which is *before* it publishes
   * the offer, and those two writes then race through the database. A
   * candidate handed to `addIceCandidate` too early does not get retried — it
   * throws and is gone for good. Lose the reflexive candidate that way and ICE
   * never finds a path, which surfaces as a connection that drops instead of
   * one that connects.
   */
  private acceptCandidate(candidate: IceCandidate): void {
    if (!this.remoteDescriptionSet) {
      this.earlyCandidates.push(candidate);
      return;
    }
    void this.addCandidate(candidate);
  }

  /** Called once the remote description lands, to drain the queue in order. */
  private async flushCandidates(): Promise<void> {
    this.remoteDescriptionSet = true;
    const queued = this.earlyCandidates.splice(0);
    if (queued.length > 0) {
      this.log.log('debug', `applying ${queued.length} buffered ICE candidate(s)`);
    }
    for (const candidate of queued) await this.addCandidate(candidate);
  }

  private async addCandidate(candidate: IceCandidate): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    try {
      await connection.addIceCandidate(candidate);
    } catch (error: unknown) {
      // A single rejected candidate costs one route, not the connection.
      this.log.log('debug', 'a remote ICE candidate was rejected', error);
    }
  }

  /**
   * Gives a disconnected connection a chance to come back before declaring the
   * match over.
   */
  private startDisconnectTimer(): void {
    if (this.disconnectTimer !== null) return;
    this.log.log('debug', 'ICE disconnected; waiting to see if it recovers');
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = null;
      if (this.connection?.connectionState === 'connected') return;
      this.log.log('info', 'ICE did not recover; closing the link');
      this.moveTo('closed');
    }, DISCONNECT_GRACE_MS);
  }

  private cancelDisconnectTimer(): void {
    if (this.disconnectTimer === null) return;
    clearTimeout(this.disconnectTimer);
    this.disconnectTimer = null;
  }

  /**
   * Deletes the offer, answer and candidate documents once they are spent.
   *
   * Only the host does it, and not immediately: the two peers open their
   * channels at slightly different moments, and deleting the candidate
   * documents while the other side is still reading them would throw away the
   * very paths that just succeeded.
   */
  private tidyHandshakeLater(): void {
    if (this.role !== 'host' || !this.matchId) return;
    const matchId = this.matchId;
    setTimeout(() => {
      void this.signaling.clear({ matchId, seat: this.pairSeat });
    }, HANDSHAKE_TIDY_DELAY_MS);
  }

  get diagnostics(): LinkDiagnostics {
    return {
      localCandidateTypes: [...this.localTypes],
      remoteCandidates: this.remoteCandidateCount,
      turnConfigured: this.ice.turn !== null,
      gotRemoteDescription: this.remoteDescriptionSet,
      iceConnectionState: this.connection?.iceConnectionState ?? null,
    };
  }

  private gatheredSummary(): string {
    const types = [...this.localTypes];
    return types.length > 0 ? types.join(', ') : 'nothing usable';
  }

  private moveTo(state: LinkState): void {
    if (this.state === state) return;
    this.state = state;
    this.log.log('debug', `link ${state}`);
    for (const listener of this.stateListeners) listener(state);
  }
}

/** Pose frames: never resend, never wait for order. */
const FAST_CHANNEL: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 };
/** Everything that must not be lost. */
const SURE_CHANNEL: RTCDataChannelInit = { ordered: true };

/**
 * How long ICE may sit in 'disconnected' before the match is given up on.
 * Long enough to ride out a Wi-Fi roam, short enough that a genuinely dead
 * connection does not leave someone shadow-boxing.
 */
const DISCONNECT_GRACE_MS = 8000;

/** Grace before the host deletes the spent handshake documents. */
const HANDSHAKE_TIDY_DELAY_MS = 5000;

/**
 * Pulls the type out of an ICE candidate line, which looks like
 * `candidate:842... 1 udp 16777... 1.2.3.4 54321 typ srflx raddr ...`.
 * The type is what says whether STUN and TURN actually worked.
 */
function candidateType(candidate: string): string | null {
  // Split rather than match: an SDP candidate line is whitespace-separated,
  // and the token after 'typ' is the type. Cheaper to read than a regex, and
  // no escaping to get wrong.
  const parts = candidate.split(' ');
  const marker = parts.indexOf('typ');
  return marker >= 0 ? (parts[marker + 1] ?? null) : null;
}

/**
 * A thumbnail's worth of video, no more. The pose frames that decide the
 * fight share this connection and matter more than the picture.
 */
const VIDEO_MAX_BITRATE = 320_000;
const VIDEO_MAX_FPS = 20;

const PING_PREFIX = 'p:';
const PONG_PREFIX = 'q:';
const PING_INTERVAL_MS = 2000;
