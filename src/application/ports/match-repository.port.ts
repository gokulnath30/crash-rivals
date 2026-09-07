import type { InviteCode } from '@domain/lobby/invite-code.ts';
import type { Match } from '@domain/lobby/match.ts';
import type { MatchId } from '@domain/shared/ids.ts';
import type { Result } from '@domain/shared/result.ts';
import type { Listener, Unsubscribe } from './types.ts';

/**
 * Where rooms live between two browsers.
 *
 * `create` must be atomic on the invite code: two players hitting "create a
 * room" at the same moment must not end up sharing one. It is allowed — and
 * expected — to take over a code whose previous room is finished, abandoned or
 * stale, so that a million four-character codes do not leak away one dead
 * lobby at a time.
 */
export interface MatchRepositoryPort {
  /** Reserves a room. Fails with `unavailable` if the code is already taken. */
  create(match: Match): Promise<Result<Match>>;
  find(id: MatchId): Promise<Result<Match | null>>;
  findByCode(code: InviteCode): Promise<Result<Match | null>>;
  /** Persists a state transition the domain has already validated. */
  save(match: Match): Promise<Result<Match>>;
  /** Live updates for the lobby screen, and for noticing the other side leave. */
  observe(id: MatchId, listener: Listener<Match | null>): Unsubscribe;
}
