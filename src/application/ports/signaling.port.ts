import type { SeatIndex } from '@domain/lobby/match.ts';
import type { MatchId } from '@domain/shared/ids.ts';
import type { Result } from '@domain/shared/result.ts';
import type { Listener, Unsubscribe } from './types.ts';

/**
 * The handshake, and only the handshake.
 *
 * WebRTC needs two browsers to swap one description each plus a handful of ICE
 * candidates before they can talk directly. That exchange needs a server; the
 * gameplay that follows does not. This port is that server-shaped hole, kept as
 * small as possible so nothing else leaks through it.
 *
 * Every call names a `seat`: the seat of the *guest* in the pair being
 * connected. A four-player room is a star with the host at the centre, so the
 * host runs three of these handshakes at once, and they must not tread on each
 * other — one shared `offer` document would mean three hosts overwriting the
 * same description and nobody connecting.
 */
export interface SignalingPort {
  /** Publishes the host's offer to one guest. */
  publishOffer(input: {
    matchId: MatchId;
    seat: SeatIndex;
    description: SessionDescription;
  }): Promise<Result<void>>;

  publishAnswer(input: {
    matchId: MatchId;
    seat: SeatIndex;
    description: SessionDescription;
  }): Promise<Result<void>>;

  /** Fires with the offer once the host has posted one for this seat. */
  observeOffer(
    input: { matchId: MatchId; seat: SeatIndex },
    listener: Listener<SessionDescription>,
  ): Unsubscribe;

  observeAnswer(
    input: { matchId: MatchId; seat: SeatIndex },
    listener: Listener<SessionDescription>,
  ): Unsubscribe;

  /** Candidates trickle in over time, so these are streams, not promises. */
  addCandidate(input: {
    matchId: MatchId;
    seat: SeatIndex;
    from: SignalRole;
    candidate: IceCandidate;
  }): Promise<void>;

  observeCandidates(
    input: { matchId: MatchId; seat: SeatIndex; from: SignalRole },
    listener: Listener<IceCandidate>,
  ): Unsubscribe;

  /** Tidies up one pair's handshake once those two peers are talking directly. */
  clear(input: { matchId: MatchId; seat: SeatIndex }): Promise<void>;
}

/** Which end of one pair. The host is always seat 0; the guest is `seat`. */
export type SignalRole = 'host' | 'guest';

/** Plain data, so the port does not depend on browser WebRTC types. */
export interface SessionDescription {
  readonly type: 'offer' | 'answer';
  readonly sdp: string;
}

export interface IceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
}
