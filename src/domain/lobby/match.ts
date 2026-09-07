import type { GameId, MatchId, PlayerId } from '../shared/ids.ts';
import { fail, failure, ok, type Result } from '../shared/result.ts';
import type { InviteCode } from './invite-code.ts';

/**
 * A match is the thing an invite link points at: one game, a row of seats, and
 * a status that only ever moves forward.
 *
 *   open ──join──▶ ready ──begin──▶ live ──finish──▶ finished
 *     └───────────────┴──────────────┴────abandon──▶ abandoned
 *
 * `open` means nobody but the host is here yet; `ready` means enough players
 * have arrived to start. Both are still joinable while a seat is free, because
 * a four-seat room should not stop admitting people the moment it *could*
 * begin.
 */
export type MatchStatus = 'open' | 'ready' | 'live' | 'finished' | 'abandoned';

/**
 * Which seat, counting from the host at zero.
 *
 * A plain number rather than a `0 | 1` union. The union was genuinely useful
 * while every game was a duel — it made an unhandled seat a compile error —
 * but it cannot express "as many seats as this game wants", and widening it to
 * `0 | 1 | 2 | 3` only moves the same wall three places to the right.
 */
export type SeatIndex = number;

/** 0 is always the host — the player who created the room, and the authority. */
export const HOST_SEAT: SeatIndex = 0;

/** Rooms hold at least a duel and at most this many. */
export const MAX_SEATS = 4;

/**
 * How many players it takes to start.
 *
 * Below this there is nobody to play against, so the host waits. Above it the
 * host may start whenever they like and the empty seats are the game's problem
 * — Crash Rivals fills them with machines, which is why a room of two humans
 * and two machines works without the lobby knowing anything about cars.
 */
export const MIN_TO_BEGIN = 2;

export interface Seat {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly avatarUrl: string | null;
}

export interface Match {
  readonly id: MatchId;
  readonly code: InviteCode;
  readonly gameId: GameId;
  /**
   * One entry per seat, `null` where nobody is sitting. Index 0 is the host
   * and is never null.
   *
   * The room's capacity is this array's length rather than a field of its own,
   * so the two can never disagree — a stored `capacity: 4` sitting next to
   * three seats is a bug waiting for someone to trust the wrong one.
   */
  readonly seats: readonly (Seat | null)[];
  readonly status: MatchStatus;
  readonly winner: SeatIndex | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * An untouched room stops being joinable after this long. Without it, an
 * abandoned tab holds a four-character code hostage forever.
 */
export const MATCH_STALE_AFTER_MS = 30 * 60 * 1000;

export function openMatch(input: {
  id: MatchId;
  code: InviteCode;
  gameId: GameId;
  host: Seat;
  /** How many can play at once. Clamped to something a room can actually hold. */
  seats: number;
  now: number;
}): Match {
  const capacity = Math.max(MIN_TO_BEGIN, Math.min(MAX_SEATS, Math.floor(input.seats)));
  const seats: (Seat | null)[] = new Array<Seat | null>(capacity).fill(null);
  seats[HOST_SEAT] = input.host;
  return {
    id: input.id,
    code: input.code,
    gameId: input.gameId,
    seats,
    status: 'open',
    winner: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Seats a player in the first free seat.
 *
 * Re-joining as a player who already holds a seat is allowed and changes
 * nothing, because a dropped connection and a page reload both look exactly
 * like another join.
 */
export function joinMatch(match: Match, player: Seat, now: number): Result<Match> {
  if (match.status === 'abandoned') {
    return fail(failure('match-abandoned', 'That room was closed. Ask for a fresh link.'));
  }
  if (match.status === 'finished') {
    return fail(failure('match-abandoned', 'That match has already finished.'));
  }
  const held = seatOf(match, player.playerId);
  if (held === HOST_SEAT) {
    return fail(
      failure('not-your-match', 'You created this room — open the link on your friend’s device.'),
    );
  }
  if (held !== null) return ok(match);

  if (match.status === 'live') {
    // Latecomers are turned away rather than dropped into a running race,
    // where they would start a lap behind with no way to catch up.
    return fail(failure('match-already-started', 'That race has already started.'));
  }
  if (isStale(match, now)) {
    return fail(failure('match-abandoned', 'That room went quiet and expired. Ask for a new link.'));
  }

  const free = match.seats.indexOf(null);
  if (free === -1) {
    return fail(failure('match-full', 'Every seat in that room is taken.'));
  }

  const seats = [...match.seats];
  seats[free] = player;
  const filled = seats.filter((seat) => seat !== null).length;
  return ok({
    ...match,
    seats,
    status: filled >= MIN_TO_BEGIN ? 'ready' : 'open',
    updatedAt: now,
  });
}

/** Enough players are seated and the peers are wired up; the game may run. */
export function beginMatch(match: Match, now: number): Result<Match> {
  if (match.status === 'live') return ok(match);
  if (match.status !== 'ready') {
    return fail(failure('match-already-started', 'That match is not ready to start.'));
  }
  return ok({ ...match, status: 'live', updatedAt: now });
}

export function finishMatch(match: Match, winner: SeatIndex | null, now: number): Result<Match> {
  if (match.status !== 'live' && match.status !== 'ready') {
    return fail(failure('match-already-started', 'That match is not running.'));
  }
  return ok({ ...match, status: 'finished', winner, updatedAt: now });
}

/** Only a player holding a seat may close the room. */
export function abandonMatch(match: Match, by: PlayerId, now: number): Result<Match> {
  if (!isParticipant(match, by)) {
    return fail(failure('not-your-match', 'That room is not yours to close.'));
  }
  if (match.status === 'abandoned') return ok(match);
  return ok({ ...match, status: 'abandoned', updatedAt: now });
}

export function seatOf(match: Match, playerId: PlayerId): SeatIndex | null {
  const index = match.seats.findIndex((seat) => seat?.playerId === playerId);
  return index === -1 ? null : index;
}

export const isParticipant = (match: Match, playerId: PlayerId): boolean =>
  seatOf(match, playerId) !== null;

export const isStale = (match: Match, now: number): boolean =>
  now - match.updatedAt > MATCH_STALE_AFTER_MS;

/** How many seats this room has, occupied or not. */
export const capacityOf = (match: Match): number => match.seats.length;

/** Everyone actually sitting down, in seat order. */
export const occupantsOf = (match: Match): readonly Seat[] =>
  match.seats.filter((seat): seat is Seat => seat !== null);

export const isFull = (match: Match): boolean => !match.seats.includes(null);

/** Joinable means: a free seat, still fresh, and not started or shut down. */
export const isJoinable = (match: Match, now: number): boolean =>
  (match.status === 'open' || match.status === 'ready') && !isFull(match) && !isStale(match, now);

/** Whether the host may start the game now. */
export const canBegin = (match: Match): boolean =>
  match.status === 'ready' && occupantsOf(match).length >= MIN_TO_BEGIN;

export function hostOf(match: Match): Seat {
  const host = match.seats[HOST_SEAT];
  if (!host) {
    // Unreachable through the constructors above, which always seat the host.
    throw new Error('A match was built with no host in seat 0.');
  }
  return host;
}

export function seatAt(match: Match, seat: SeatIndex): Seat | null {
  return match.seats[seat] ?? null;
}

/** The seats of everyone except the given player, occupied only. */
export function opponentsOf(match: Match, seat: SeatIndex): readonly SeatIndex[] {
  const others: SeatIndex[] = [];
  match.seats.forEach((occupant, index) => {
    if (occupant && index !== seat) others.push(index);
  });
  return others;
}

/** Seats a host must dial out to: everyone else who is seated. */
export const guestSeatsOf = (match: Match): readonly SeatIndex[] => opponentsOf(match, HOST_SEAT);
