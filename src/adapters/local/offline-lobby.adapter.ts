import type { InviteCode } from '@domain/lobby/invite-code.ts';
import type { Match } from '@domain/lobby/match.ts';
import type { MatchId } from '@domain/shared/ids.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { MatchRepositoryPort } from '@app/ports/match-repository.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';

const NEEDS_CLOUD = failure(
  'unavailable',
  'Invite links need a Firebase project. Add one to .env and reload — see README.md. Solo play against the machine works without it.',
);

/**
 * The match repository when there is nowhere to put a match.
 *
 * It refuses cleanly rather than throwing, which is what lets the store show
 * "invite a friend" greyed out with a reason instead of crashing the moment
 * somebody presses it.
 */
export class OfflineMatchRepository implements MatchRepositoryPort {
  async create(_match: Match): Promise<Result<Match>> {
    return fail(NEEDS_CLOUD);
  }

  async find(_id: MatchId): Promise<Result<Match | null>> {
    return ok(null);
  }

  async findByCode(_code: InviteCode): Promise<Result<Match | null>> {
    return ok(null);
  }

  async save(_match: Match): Promise<Result<Match>> {
    return fail(NEEDS_CLOUD);
  }

  observe(_id: MatchId, listener: Listener<Match | null>): Unsubscribe {
    listener(null);
    return () => undefined;
  }
}
