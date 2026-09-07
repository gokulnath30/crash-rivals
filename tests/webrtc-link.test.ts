import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asGameId, asMatchId, asPlayerId, type MatchId } from '@domain/shared/ids.ts';
import type { InviteCode } from '@domain/lobby/invite-code.ts';
import type { Match } from '@domain/lobby/match.ts';
import { ok, type Result } from '@domain/shared/result.ts';
import type {
  IceCandidate,
  SessionDescription,
  SignalRole,
  SignalingPort,
} from '@app/ports/signaling.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';
import { WebRtcPeerLink } from '@adapters/webrtc/webrtc-peer-link.adapter.ts';
import { SilentLogger } from './support/fakes.ts';

/**
 * The handshake, against a peer connection that behaves like a real one.
 *
 * The bug these cover: both peers subscribe to the other's ICE candidates
 * before they have a remote description to attach them to, because the host
 * starts emitting candidates at `setLocalDescription` — before it publishes
 * the offer. Those two writes then race. A candidate handed to
 * `addIceCandidate` with no remote description set does not get retried by the
 * browser; it throws and is gone. Lose the reflexive candidate that way and
 * ICE never finds a path, which looks to a player like a connection that
 * drops rather than one that connects.
 */

const CODE = '7K2M' as InviteCode;

const MATCH: Match = {
  id: asMatchId(CODE),
  code: CODE,
  gameId: asGameId('ashen-ring'),
  seats: [
    { playerId: asPlayerId('host'), displayName: 'Host', avatarUrl: null },
    { playerId: asPlayerId('guest'), displayName: 'Guest', avatarUrl: null },
  ],
  status: 'ready',
  winner: null,
  createdAt: 0,
  updatedAt: 0,
};

/** The seat on the far end of the link under test. */
const GUEST = 1;

const candidate = (name: string): IceCandidate => ({
  candidate: name,
  sdpMid: '0',
  sdpMLineIndex: 0,
});

/** A signaling port the test drives by hand. */
class ScriptedSignaling implements SignalingPort {
  readonly published: SessionDescription[] = [];
  readonly cleared: MatchId[] = [];
  /** Every seat this port was asked about, in call order. */
  readonly seatsSeen: number[] = [];
  private offerListeners: Listener<SessionDescription>[] = [];
  private answerListeners: Listener<SessionDescription>[] = [];
  private candidateListeners = new Map<SignalRole, Listener<IceCandidate>[]>();

  async publishOffer(input: {
    seat: number;
    description: SessionDescription;
  }): Promise<Result<void>> {
    this.seatsSeen.push(input.seat);
    this.published.push(input.description);
    return ok(undefined);
  }

  async publishAnswer(input: {
    seat: number;
    description: SessionDescription;
  }): Promise<Result<void>> {
    this.seatsSeen.push(input.seat);
    this.published.push(input.description);
    return ok(undefined);
  }

  observeOffer(
    input: { matchId: MatchId; seat: number },
    listener: Listener<SessionDescription>,
  ): Unsubscribe {
    this.seatsSeen.push(input.seat);
    this.offerListeners.push(listener);
    return () => {
      this.offerListeners = this.offerListeners.filter((l) => l !== listener);
    };
  }

  observeAnswer(
    input: { matchId: MatchId; seat: number },
    listener: Listener<SessionDescription>,
  ): Unsubscribe {
    this.seatsSeen.push(input.seat);
    this.answerListeners.push(listener);
    return () => {
      this.answerListeners = this.answerListeners.filter((l) => l !== listener);
    };
  }

  async addCandidate(input: { seat: number }): Promise<void> {
    /* the test asserts on what arrives, not what is sent — but the seat matters */
    this.seatsSeen.push(input.seat);
  }

  observeCandidates(
    input: { matchId: MatchId; seat: number; from: SignalRole },
    listener: Listener<IceCandidate>,
  ): Unsubscribe {
    this.seatsSeen.push(input.seat);
    const existing = this.candidateListeners.get(input.from) ?? [];
    existing.push(listener);
    this.candidateListeners.set(input.from, existing);
    return () => {
      this.candidateListeners.set(
        input.from,
        (this.candidateListeners.get(input.from) ?? []).filter((l) => l !== listener),
      );
    };
  }

  async clear(input: { matchId: MatchId; seat: number }): Promise<void> {
    this.seatsSeen.push(input.seat);
    this.cleared.push(input.matchId);
  }

  // --- what the test drives ---
  emitOffer(sdp = 'OFFER'): void {
    for (const listener of [...this.offerListeners]) listener({ type: 'offer', sdp });
  }

  emitAnswer(sdp = 'ANSWER'): void {
    for (const listener of [...this.answerListeners]) listener({ type: 'answer', sdp });
  }

  emitCandidate(from: SignalRole, value: IceCandidate): void {
    for (const listener of [...(this.candidateListeners.get(from) ?? [])]) listener(value);
  }
}

class FakeChannel {
  readyState = 'connecting';
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];

  constructor(readonly label: string) {}

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 'closed';
  }

  open(): void {
    this.readyState = 'open';
    this.onopen?.();
  }
}

/**
 * Reproduces the one browser behaviour that matters here: `addIceCandidate`
 * throws when there is no remote description, and the candidate is lost.
 */
class FakePeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  remoteDescription: unknown = null;
  localDescription: unknown = null;

  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  readonly added: IceCandidate[] = [];
  readonly rejected: IceCandidate[] = [];
  readonly channels: FakeChannel[] = [];
  remoteDescriptionsApplied = 0;

  static last: FakePeerConnection | null = null;

  constructor() {
    FakePeerConnection.last = this;
  }

  /** Reserved before the offer, so media can be swapped in without a renegotiation. */
  readonly transceivers: { kind: string; sender: { track: unknown; replaceTrack: (t: unknown) => Promise<void>; getParameters: () => { encodings: unknown[] }; setParameters: (p: unknown) => Promise<void> } }[] = [];
  ontrack: ((event: { track: unknown }) => void) | null = null;

  addTransceiver(kind: string, _options: unknown) {
    const sender = {
      track: null as unknown,
      replaceTrack: async (track: unknown): Promise<void> => {
        sender.track = track;
      },
      getParameters: () => ({ encodings: [] as unknown[] }),
      setParameters: async (_p: unknown): Promise<void> => undefined,
    };
    const transceiver = { kind, sender };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  createDataChannel(label: string): FakeChannel {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }

  async createOffer(): Promise<{ type: string; sdp: string }> {
    return { type: 'offer', sdp: 'OFFER' };
  }

  async createAnswer(): Promise<{ type: string; sdp: string }> {
    return { type: 'answer', sdp: 'ANSWER' };
  }

  async setLocalDescription(description: unknown): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(description: unknown): Promise<void> {
    this.remoteDescription = description;
    this.remoteDescriptionsApplied += 1;
    this.signalingState = 'stable';
  }

  async addIceCandidate(value: IceCandidate): Promise<void> {
    if (!this.remoteDescription) {
      this.rejected.push(value);
      throw new Error('InvalidStateError: remote description is null');
    }
    this.added.push(value);
  }

  close(): void {
    this.connectionState = 'closed';
  }

  /** Drives a connection state change the way the browser would. */
  moveTo(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

/** Just enough MediaStream for the call: a bag of tracks. */
class FakeMediaStream {
  private tracks: unknown[] = [];

  addTrack(track: unknown): void {
    this.tracks.push(track);
  }

  removeTrack(track: unknown): void {
    this.tracks = this.tracks.filter((one) => one !== track);
  }

  getTracks(): unknown[] {
    return this.tracks;
  }
}

const ICE = { stunUrls: ['stun:example:19302'], turn: null };

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('the WebRTC link', () => {
  let signaling: ScriptedSignaling;
  let link: WebRtcPeerLink;

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.last = null;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection;
    // Neither node nor jsdom implements MediaStream, and the call needs one.
    (globalThis as unknown as { MediaStream: unknown }).MediaStream = FakeMediaStream;
    signaling = new ScriptedSignaling();
    link = new WebRtcPeerLink(signaling, ICE, new SilentLogger());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('ICE candidates that arrive before the description', () => {
    it('applies host candidates that raced ahead of the offer', async () => {
      void link.openAsGuest(MATCH, GUEST);
      await flush();

      // The host publishes candidates from setLocalDescription onward, which is
      // before it publishes the offer. These arrive first.
      signaling.emitCandidate('host', candidate('early-1'));
      signaling.emitCandidate('host', candidate('early-2'));
      await flush();

      const connection = FakePeerConnection.last;
      expect(connection).not.toBeNull();
      // Nothing applied yet — there is no remote description to attach to.
      expect(connection?.added).toHaveLength(0);
      // And crucially, nothing thrown away either.
      expect(connection?.rejected).toHaveLength(0);

      signaling.emitOffer();
      await flush();

      // Once the offer lands, the queue drains, in order.
      expect(connection?.added.map((c) => c.candidate)).toEqual(['early-1', 'early-2']);
    });

    it('applies candidates that arrive after the description directly', async () => {
      void link.openAsGuest(MATCH, GUEST);
      await flush();
      signaling.emitOffer();
      await flush();

      signaling.emitCandidate('host', candidate('late-1'));
      await flush();

      expect(FakePeerConnection.last?.added.map((c) => c.candidate)).toEqual(['late-1']);
    });

    it('buffers on the host side too, until the answer lands', async () => {
      // The host has the same race: it subscribes to guest candidates when the
      // connection is built, but only applies the answer later.
      await link.openAsHost(MATCH, GUEST);
      await flush();

      signaling.emitCandidate('guest', candidate('guest-early'));
      await flush();
      const connection = FakePeerConnection.last;
      expect(connection?.added).toHaveLength(0);
      expect(connection?.rejected).toHaveLength(0);

      signaling.emitAnswer();
      await flush();

      expect(connection?.added.map((c) => c.candidate)).toEqual(['guest-early']);
    });
  });

  describe('re-delivered handshake documents', () => {
    it('applies the offer only once', async () => {
      void link.openAsGuest(MATCH, GUEST);
      await flush();

      signaling.emitOffer();
      await flush();
      // A reconnecting listener re-delivers the same document. Applying it
      // again would renegotiate a working connection.
      signaling.emitOffer();
      await flush();

      expect(FakePeerConnection.last?.remoteDescriptionsApplied).toBe(1);
    });

    it('applies the answer only once', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();

      signaling.emitAnswer();
      await flush();
      signaling.emitAnswer();
      await flush();

      expect(FakePeerConnection.last?.remoteDescriptionsApplied).toBe(1);
    });
  });

  describe('a wobbly connection', () => {
    it('does not give up the moment ICE reports disconnected', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();
      const states: string[] = [];
      link.onStateChange((state) => states.push(state));

      FakePeerConnection.last?.moveTo('disconnected');
      await flush();

      // A Wi-Fi roam should not end the match.
      expect(states).not.toContain('closed');
    });

    it('recovers silently if ICE comes back', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();
      const states: string[] = [];
      link.onStateChange((state) => states.push(state));

      FakePeerConnection.last?.moveTo('disconnected');
      await vi.advanceTimersByTimeAsync(3000);
      FakePeerConnection.last?.moveTo('connected');
      await vi.advanceTimersByTimeAsync(30000);

      expect(states).not.toContain('closed');
    });

    it('gives up if ICE stays down', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();
      const states: string[] = [];
      link.onStateChange((state) => states.push(state));

      FakePeerConnection.last?.moveTo('disconnected');
      await vi.advanceTimersByTimeAsync(30000);

      expect(states).toContain('closed');
    });

    it('closes immediately when ICE actually fails', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();
      const states: string[] = [];
      link.onStateChange((state) => states.push(state));

      FakePeerConnection.last?.moveTo('failed');
      await flush();

      expect(states).toContain('failed');
    });
  });

  describe('tidying the handshake', () => {
    it('waits before deleting the signalling documents, and only the host does', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();
      signaling.emitAnswer();
      await flush();

      const connection = FakePeerConnection.last;
      for (const channel of connection?.channels ?? []) channel.open();
      await flush();

      // Not straight away — the guest may still be reading the candidates.
      expect(signaling.cleared).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(10000);
      expect(signaling.cleared).toEqual([MATCH.id]);
    });
  });

  describe('the call', () => {
    it('reserves a video and an audio section before the offer', async () => {
      // This is what makes it possible to add the camera later: the camera is
      // not asked for until the player starts the game, long after the
      // handshake, and by then there is nowhere left to renegotiate.
      await link.openAsHost(MATCH, GUEST);
      await flush();
      expect(FakePeerConnection.last?.transceivers.map((t) => t.kind)).toEqual(['video', 'audio']);
    });

    it('swaps tracks into those sections rather than renegotiating', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();

      const video = { kind: 'video', enabled: true } as unknown as MediaStreamTrack;
      const audio = { kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
      link.attachLocalMedia({
        getVideoTracks: () => [video],
        getAudioTracks: () => [audio],
      } as unknown as MediaStream);
      await flush();

      const [videoT, audioT] = FakePeerConnection.last?.transceivers ?? [];
      expect(videoT?.sender.track).toBe(video);
      expect(audioT?.sender.track).toBe(audio);
      // No second offer was published.
      expect(signaling.published.filter((d) => d.type === 'offer')).toHaveLength(1);
    });

    it('mutes a track without removing it', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();
      const audio = { kind: 'audio', enabled: true } as unknown as MediaStreamTrack;
      link.attachLocalMedia({
        getVideoTracks: () => [],
        getAudioTracks: () => [audio],
      } as unknown as MediaStream);
      await flush();

      link.setMicrophoneMuted(true);
      expect(audio.enabled).toBe(false);
      // Still attached, so unmuting needs no renegotiation either.
      link.setMicrophoneMuted(false);
      expect(audio.enabled).toBe(true);
    });

    it('hands out the remote stream as tracks arrive', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();

      const seen: MediaStream[] = [];
      link.onRemoteMedia((stream) => seen.push(stream));

      FakePeerConnection.last?.ontrack?.({ track: { kind: 'video' } });
      FakePeerConnection.last?.ontrack?.({ track: { kind: 'audio' } });
      await flush();

      // One notification per track, both carrying the same accumulating stream.
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(seen[1]);
    });

    it('survives media being attached when there is nothing to attach', async () => {
      await link.openAsHost(MATCH, GUEST);
      await flush();
      expect(() => {
        link.attachLocalMedia({
          getVideoTracks: () => [],
          getAudioTracks: () => [],
        } as unknown as MediaStream);
      }).not.toThrow();
    });
  });

  /*
   * A four-player room is a star: the host runs three handshakes at once. They
   * are only safe because every signalling document is named after the guest's
   * seat. Lose that and all three share one `offer` and one `answer` — three
   * hosts overwriting each other's description, and an answer meant for seat 1
   * applied to the connection for seat 3.
   *
   * Nothing else in the suite would notice: a two-player room has exactly one
   * pair, so the shared and the namespaced versions behave identically.
   */
  describe('one room, several handshakes', () => {
    it('names every document after the seat it belongs to', async () => {
      await link.openAsHost(MATCH, 3);
      await flush();
      // Publishing the offer, watching for the answer, and watching for the
      // far end's candidates all have to agree on the seat.
      expect(new Set(signaling.seatsSeen)).toEqual(new Set([3]));
    });

    it('keeps a guest on its own seat rather than the host seat', async () => {
      // Not awaited: a guest's open does not resolve until an offer turns up.
      void link.openAsGuest(MATCH, 2);
      await flush();
      signaling.emitOffer();
      await flush();
      expect(signaling.seatsSeen.length).toBeGreaterThan(0);
      expect(signaling.seatsSeen.every((seat) => seat === 2)).toBe(true);
    });

    it('gives two links to two guests two separate namespaces', async () => {
      const other = new WebRtcPeerLink(signaling, ICE, new SilentLogger());
      await link.openAsHost(MATCH, 1);
      await other.openAsHost(MATCH, 2);
      await flush();

      // Both seats appear, and neither link ever touched the other's.
      expect(new Set(signaling.seatsSeen)).toEqual(new Set([1, 2]));
    });

    it('clears only its own pair when tidying up', async () => {
      await link.openAsHost(MATCH, 2);
      await flush();
      signaling.seatsSeen.length = 0;
      signaling.emitAnswer();
      await flush();
      // The host tidies the handshake on a timer once the peers are talking.
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();

      // Whatever was cleared, it was seat 2's — a host that cleared the shared
      // documents would wipe the other guests' handshakes mid-flight.
      expect(signaling.seatsSeen.every((seat) => seat === 2)).toBe(true);
    });
  });
});
