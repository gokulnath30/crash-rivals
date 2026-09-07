import { describe, expect, it } from 'vitest';
import type { InviteCode } from '@domain/lobby/invite-code.ts';
import {
  beginMatch,
  canBegin,
  capacityOf,
  guestSeatsOf,
  hostOf,
  isFull,
  isJoinable,
  joinMatch,
  MAX_SEATS,
  MIN_TO_BEGIN,
  occupantsOf,
  openMatch,
  opponentsOf,
  seatAt,
  seatOf,
  type Match,
  type Seat,
} from '@domain/lobby/match.ts';
import { asGameId, asMatchId, asPlayerId } from '@domain/shared/ids.ts';
import { expect as unwrap } from '@domain/shared/result.ts';

const CODE = 'R4CE' as InviteCode;
const NOW = 1_700_000_000_000;

const seat = (id: string): Seat => ({
  playerId: asPlayerId(id),
  displayName: id.toUpperCase(),
  avatarUrl: null,
});

const room = (seats: number, now = NOW): Match =>
  openMatch({
    id: asMatchId(CODE),
    code: CODE,
    gameId: asGameId('crash-rivals'),
    host: seat('host'),
    seats,
    now,
  });

/** Seats `count` guests, named guest1, guest2, … */
const fill = (match: Match, count: number): Match => {
  let current = match;
  for (let index = 1; index <= count; index += 1) {
    current = unwrap(joinMatch(current, seat(`guest${index}`), NOW));
  }
  return current;
};

describe('a room wider than two', () => {
  it('opens with the host seated and the rest empty', () => {
    const match = room(4);
    expect(capacityOf(match)).toBe(4);
    expect(hostOf(match).playerId).toBe('host');
    expect(occupantsOf(match)).toHaveLength(1);
    expect(match.seats.slice(1)).toEqual([null, null, null]);
  });

  it('seats each arrival in the next free seat', () => {
    const match = fill(room(4), 3);
    expect(match.seats.map((s) => s?.playerId ?? null)).toEqual([
      'host',
      'guest1',
      'guest2',
      'guest3',
    ]);
  });

  it('stays joinable after it is startable, until it is actually full', () => {
    // The distinction the whole four-player lobby rests on. A room that could
    // begin is not a room that must stop admitting people — closing the door
    // the moment two players are in would make a four-seat race impossible to
    // assemble.
    const two = fill(room(4), 1);
    expect(two.status).toBe('ready');
    expect(canBegin(two)).toBe(true);
    expect(isJoinable(two, NOW)).toBe(true);
    expect(isFull(two)).toBe(false);

    const four = fill(room(4), 3);
    expect(canBegin(four)).toBe(true);
    expect(isJoinable(four, NOW)).toBe(false);
    expect(isFull(four)).toBe(true);
  });

  it('turns away the fifth player', () => {
    const full = fill(room(4), 3);
    const late = joinMatch(full, seat('guest4'), NOW);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe('match-full');
  });

  it('will not start with only the host in it', () => {
    const alone = room(4);
    expect(canBegin(alone)).toBe(false);
    expect(beginMatch(alone, NOW).ok).toBe(false);
  });

  it('starts with empty seats left over', () => {
    // Two humans and two empty chairs is a legitimate race; the game fills the
    // rest with machines.
    const two = fill(room(4), 1);
    const live = unwrap(beginMatch(two, NOW));
    expect(live.status).toBe('live');
    expect(occupantsOf(live)).toHaveLength(2);
  });

  it('refuses a latecomer once the race is running', () => {
    const live = unwrap(beginMatch(fill(room(4), 1), NOW));
    const late = joinMatch(live, seat('guest3'), NOW);
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error.code).toBe('match-already-started');
  });

  it('treats a re-join as the same seat, not a new one', () => {
    // A page reload and a dropped connection both look exactly like a second
    // join. Handing out a fresh seat for one would fill the room with ghosts.
    const three = fill(room(4), 2);
    const again = unwrap(joinMatch(three, seat('guest1'), NOW + 5));
    expect(occupantsOf(again)).toHaveLength(3);
    expect(seatOf(again, asPlayerId('guest1'))).toBe(1);
  });

  it('knows who the host must dial, and who each player is up against', () => {
    const four = fill(room(4), 3);
    expect(guestSeatsOf(four)).toEqual([1, 2, 3]);
    expect(opponentsOf(four, 2)).toEqual([0, 1, 3]);
    // Empty seats are nobody's opponent.
    expect(opponentsOf(fill(room(4), 1), 0)).toEqual([1]);
  });

  it('reads a seat by index and reports an empty one as empty', () => {
    const two = fill(room(4), 1);
    expect(seatAt(two, 1)?.playerId).toBe('guest1');
    expect(seatAt(two, 3)).toBeNull();
    expect(seatAt(two, 99)).toBeNull();
  });
});

describe('room capacity', () => {
  it('clamps a game asking for more seats than a room holds', () => {
    expect(capacityOf(room(9))).toBe(MAX_SEATS);
  });

  it('clamps a game asking for fewer players than it takes to play', () => {
    // Training Space declares one seat because it is a single-player scene.
    // Should anyone ever open a *room* for it, a room of one has nobody to
    // wait for and could never begin.
    expect(capacityOf(room(1))).toBe(MIN_TO_BEGIN);
  });

  it('rounds a fractional capacity down rather than making a hole', () => {
    expect(capacityOf(room(3.7))).toBe(3);
  });
});
