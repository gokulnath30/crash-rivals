import type { Match, SeatIndex } from '@domain/lobby/match.ts';
import type { Result } from '@domain/shared/result.ts';
import type { SignalRole } from './signaling.port.ts';
import type { Listener, Unsubscribe } from './types.ts';

export type LinkState = 'idle' | 'connecting' | 'open' | 'closed' | 'failed';

/**
 * Two channels, because a fighting game wants two different guarantees:
 *
 *  - `fast` is unreliable and unordered. Pose frames go here: a dropped frame
 *    is irrelevant a sixteenth of a second later, whereas a *delayed* one
 *    ruins the fight. Never resend these.
 *  - `sure` is reliable and ordered. Hits, knockouts and round changes go
 *    here, because losing one desynchronises the match.
 */
export type Channel = 'fast' | 'sure';

/**
 * What the connection attempt actually managed to do.
 *
 * When a handshake fails there is nothing on screen to distinguish "the
 * network blocked STUN", "both sides are behind a NAT that needs a relay" and
 * "the other player closed the tab". These are the facts needed to tell them
 * apart, so the failure can name its own cause instead of shrugging.
 */
export interface LinkDiagnostics {
  /** ICE candidate types this browser managed to gather: host, srflx, relay. */
  readonly localCandidateTypes: readonly string[];
  /** How many candidates the other side sent us. */
  readonly remoteCandidates: number;
  /** Whether a TURN relay was configured at all. */
  readonly turnConfigured: boolean;
  /** True once the remote description has been applied. */
  readonly gotRemoteDescription: boolean;
  readonly iceConnectionState: string | null;
}

export interface PeerPayload {
  readonly channel: Channel;
  readonly data: ArrayBuffer | string;
}

/**
 * A direct link between two players' browsers. Once this is open, no server
 * sits in the path.
 *
 * One link is one edge, not one room. A four-player room is a star centred on
 * the host, so the host holds three of these and each guest holds one; `seat`
 * is what tells them apart, both here and in the signalling documents.
 */
export interface PeerLinkPort {
  readonly state: LinkState;
  readonly role: SignalRole | null;
  /** Round-trip time in milliseconds, or null before the first measurement. */
  readonly latencyMs: number | null;
  /** Evidence about why a connection did or did not happen. */
  readonly diagnostics: LinkDiagnostics;

  /**
    * Opens the data channels and offers them to one joining player.
    *
    * @param seat which guest this link is for. Names the handshake documents,
    *   so the host's simultaneous handshakes do not overwrite each other.
    */
  openAsHost(match: Match, seat: SeatIndex): Promise<Result<void>>;
  /** Answers the host's offer. `seat` is this browser's own seat. */
  openAsGuest(match: Match, seat: SeatIndex): Promise<Result<void>>;

  send(channel: Channel, data: ArrayBuffer | string): void;
  onData(listener: Listener<PeerPayload>): Unsubscribe;
  onStateChange(listener: Listener<LinkState>): Unsubscribe;

  // ------------------------------------------------------------ the call
  //
  // The same connection carries camera and microphone, so the two players can
  // see and hear each other while they fight. Media is attached *after* the
  // connection is up, because the camera is not asked for until the player
  // starts the game — so the link reserves room for it in advance rather than
  // renegotiating later.

  /**
   * Starts sending these tracks to the other player. Safe to call once the
   * link is open, and safe to call again to swap the tracks.
   */
  attachLocalMedia(stream: MediaStream): void;

  /** The other player's camera and microphone, once they arrive. */
  onRemoteMedia(listener: Listener<MediaStream>): Unsubscribe;

  /** Stops sending the microphone, without tearing anything down. */
  setMicrophoneMuted(muted: boolean): void;

  /** Stops sending the camera. Pose tracking is unaffected — that is local. */
  setCameraMuted(muted: boolean): void;

  close(): void;
}

/**
 * A link is single-use: one connection, one match. The composition root hands
 * out a factory so a rematch gets a clean RTCPeerConnection rather than a
 * reused one in a half-closed state.
 */
export type PeerLinkFactory = () => PeerLinkPort;
