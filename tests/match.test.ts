import { describe, expect, it } from 'vitest';
import { parseInviteCode, type InviteCode } from '@domain/lobby/invite-code.ts';
import {
  abandonMatch,
  beginMatch,
  finishMatch,
  isJoinable,
  isStale,
  joinMatch,
  MATCH_STALE_AFTER_MS,
  openMatch,
  seatOf,
  type Match,
  type Seat,
} from '@domain/lobby/match.ts';
import { asGameId, asMatchId, asPlayerId } from '@domain/shared/ids.ts';
import { expect as unwrap } from '@domain/shared/result.ts';

const CODE = (parseInviteCode('7K2M') as { ok: true; value: InviteCode }).value;
const NOW = 1_700_000_000_000;

const seat = (id: string, name = id): Seat => ({
  playerId: asPlayerId(id),
  displayName: name,
  avatarUrl: null,
});

const room = (now = NOW, seats = 2): Match =>
  openMatch({
    id: asMatchId(CODE),
    code: CODE,
    gameId: asGameId('ashen-ring'),
    host: seat('host'),
    seats,
    now,
  });

describe('a match', () => {
  it('opens with one seat taken and one free', () => {
    const match = room();
    expect(match.status).toBe('open');
    expect(match.seats).toHaveLength(2);
    expect(match.seats[1]).toBeNull();
    expect(isJoinable(match, NOW)).toBe(true);
  });

  it('becomes ready when the second player arrives', () => {
    const joined = unwrap(joinMatch(room(), seat('guest'), NOW + 1000));
    expect(joined.status).toBe('ready');
    expect(joined.seats[1]?.playerId).toBe('guest');
    expect(joined.updatedAt).toBe(NOW + 1000);
  });

  it('refuses a player beyond the last seat', () => {
    const joined = unwrap(joinMatch(room(), seat('guest'), NOW));
    const gatecrasher = joinMatch(joined, seat('someone-else'), NOW);
    expect(gatecrasher.ok).toBe(false);
    if (!gatecrasher.ok) expect(gatecrasher.error.code).toBe('match-full');
  });

  it('will not let the host join their own room as the guest', () => {
    // This is the mistake of opening your own invite link, and it deserves an
    // explanation rather than a second seat.
    const result = joinMatch(room(), seat('host'), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-your-match');
  });

  it('treats a re-join by the seated guest as a no-op', () => {
    // A page reload and a dropped connection both look exactly like a second
    // join, so this has to be safe — and cost no write.
    const joined = unwrap(joinMatch(room(), seat('guest'), NOW));
    const again = joinMatch(joined, seat('guest'), NOW + 5000);
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.value).toBe(joined);
  });

  it('refuses a join to an abandoned room', () => {
    const closed = unwrap(abandonMatch(room(), asPlayerId('host'), NOW));
    const result = joinMatch(closed, seat('guest'), NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('match-abandoned');
  });

  it('refuses a join to a room that went quiet', () => {
    const late = NOW + MATCH_STALE_AFTER_MS + 1;
    expect(isStale(room(), late)).toBe(true);
    const result = joinMatch(room(), seat('guest'), late);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('match-abandoned');
  });

  describe('starting', () => {
    it('goes live once both seats are filled', () => {
      const ready = unwrap(joinMatch(room(), seat('guest'), NOW));
      expect(unwrap(beginMatch(ready, NOW)).status).toBe('live');
    });

    it('will not start with an empty seat', () => {
      const result = beginMatch(room(), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('match-already-started');
    });

    it('is idempotent once live', () => {
      const live = unwrap(beginMatch(unwrap(joinMatch(room(), seat('guest'), NOW)), NOW));
      const again = beginMatch(live, NOW + 100);
      expect(again.ok && again.value).toBe(live);
    });
  });

  describe('closing', () => {
    it('lets a player in the room close it', () => {
      const closed = abandonMatch(room(), asPlayerId('host'), NOW);
      expect(closed.ok && closed.value.status).toBe('abandoned');
    });

    it('does not let a stranger close it', () => {
      const result = abandonMatch(room(), asPlayerId('nobody'), NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('not-your-match');
    });

    it('records a winner when it finishes', () => {
      const live = unwrap(beginMatch(unwrap(joinMatch(room(), seat('guest'), NOW)), NOW));
      const done = unwrap(finishMatch(live, 1, NOW));
      expect(done.status).toBe('finished');
      expect(done.winner).toBe(1);
    });
  });

  describe('the stale window', () => {
    it('is 30 minutes, matching firebase/firestore.rules', () => {
      // The security rules re-implement this threshold in `staleAfterMs()`,
      // because they have to decide whether a host may reclaim a dead code
      // without being able to import from here. If this number changes, that
      // function has to change with it — hence this guard.
      expect(MATCH_STALE_AFTER_MS).toBe(30 * 60 * 1000);
    });
  });

  describe('seats', () => {
    it('reports which seat a player holds', () => {
      const joined = unwrap(joinMatch(room(), seat('guest'), NOW));
      expect(seatOf(joined, asPlayerId('host'))).toBe(0);
      expect(seatOf(joined, asPlayerId('guest'))).toBe(1);
      expect(seatOf(joined, asPlayerId('stranger'))).toBeNull();
    });
  });
});
