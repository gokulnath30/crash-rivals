import { seatsOf } from '@domain/catalog/game-definition.ts';
import { canPlay, type Session } from '@domain/identity/session.ts';
import {
  generateInviteCode,
  parseInviteCode,
  type InviteCode,
} from '@domain/lobby/invite-code.ts';
import {
  abandonMatch,
  beginMatch,
  finishMatch,
  joinMatch,
  openMatch,
  seatOf,
  type Match,
  type Seat,
  type SeatIndex,
} from '@domain/lobby/match.ts';
import { displayNameFor } from '@domain/identity/player.ts';
import { asMatchId, type GameId } from '@domain/shared/ids.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { ClockPort } from '../ports/clock.port.ts';
import type { GameCatalogPort } from '../ports/game-catalog.port.ts';
import type { LoggerPort } from '../ports/logger.port.ts';
import type { MatchRepositoryPort } from '../ports/match-repository.port.ts';
import type { SharePort, ShareOutcome } from '../ports/share.port.ts';
import type { Listener, Unsubscribe } from '../ports/types.ts';

/**
 * How many times to retry when a freshly generated invite code turns out to
 * already be in use. Four characters is a million codes; three collisions in a
 * row means something is wrong, not unlucky.
 */
const CODE_ATTEMPTS = 5;

/**
 * Creating rooms and getting into them.
 *
 * Every method takes the caller's `Session` rather than reading an ambient
 * "current user", so a use case cannot accidentally act as the wrong player —
 * and the access check is impossible to forget, because there is nowhere else
 * for the player to come from.
 */
export class LobbyService {
  constructor(
    private readonly matches: MatchRepositoryPort,
    private readonly catalog: GameCatalogPort,
    private readonly clock: ClockPort,
    private readonly share: SharePort,
    private readonly logger: LoggerPort,
    /** Injected so tests can pin the codes. */
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Opens a room for a game and reserves a code nobody else holds.
   */
  async host(input: { session: Session; gameId: GameId }): Promise<Result<Match>> {
    const gate = requireAccess(input.session);
    if (!gate.ok) return gate;

    const game = this.catalog.find(input.gameId);
    if (!game) {
      return fail(failure('game-not-found', 'That game is not on the shelf.'));
    }

    const host = seatFor(input.session);
    let lastError = failure('unavailable', 'Could not open a room. Try again.');

    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const code = generateInviteCode(this.random);
      const match = openMatch({
        // The invite code *is* the room's identity: it makes "is this code
        // taken?" a single document read rather than a query, and it makes
        // reserving one atomic without a transaction of our own.
        id: asMatchId(code),
        code,
        gameId: input.gameId,
        host,
        // The game decides how wide its own room is; the lobby just asks.
        seats: seatsOf(game),
        now: this.clock.now(),
      });

      const created = await this.matches.create(match);
      if (created.ok) return created;

      // Only a collision is worth another roll. A database that is down will
      // still be down on the fifth attempt, and the player deserves to hear
      // about it now rather than five round trips from now.
      if (created.error.code !== 'code-taken') return created;
      lastError = created.error;
      this.logger.log('debug', 'invite code collided, generating another', { code: match.code });
    }

    return fail(lastError);
  }

  /**
   * Takes the second seat in a room, by code.
   *
   * Idempotent: re-joining a room this player already sits in succeeds and
   * changes nothing, which is what makes a page reload or a dropped
   * connection recoverable rather than fatal.
   */
  async join(input: { session: Session; code: string }): Promise<Result<Match>> {
    const gate = requireAccess(input.session);
    if (!gate.ok) return gate;

    const parsed = parseInviteCode(input.code);
    if (!parsed.ok) return parsed;

    const found = await this.matches.findByCode(parsed.value);
    if (!found.ok) return found;
    if (!found.value) {
      return fail(failure('match-not-found', `No room is open on ${parsed.value}.`));
    }

    const joined = joinMatch(found.value, seatFor(input.session), this.clock.now());
    if (!joined.ok) return joined;
    // The domain returns the same object when nothing changed, so an
    // idempotent re-join costs no write.
    if (joined.value === found.value) return ok(found.value);

    return this.matches.save(joined.value);
  }

  /** Both peers are wired up; flip the room to live. */
  async start(match: Match): Promise<Result<Match>> {
    const begun = beginMatch(match, this.clock.now());
    if (!begun.ok) return begun;
    if (begun.value === match) return ok(match);
    return this.matches.save(begun.value);
  }

  async finish(input: { match: Match; winner: SeatIndex | null }): Promise<Result<Match>> {
    const finished = finishMatch(input.match, input.winner, this.clock.now());
    if (!finished.ok) return finished;
    return this.matches.save(finished.value);
  }

  /** Closes the room so its code stops being joinable. */
  async leave(input: { session: Session; match: Match }): Promise<Result<Match>> {
    const abandoned = abandonMatch(input.match, input.session.player.id, this.clock.now());
    if (!abandoned.ok) return abandoned;
    return this.matches.save(abandoned.value);
  }

  observe(match: Match, listener: Listener<Match | null>): Unsubscribe {
    return this.matches.observe(match.id, listener);
  }

  /** Which seat this session is playing, or null if it is not in the room. */
  seatFor(session: Session, match: Match): SeatIndex | null {
    return seatOf(match, session.player.id);
  }

  /**
   * The link a friend opens to join. Built from the page's own address so it
   * keeps working under a project subpath on a static host.
   */
  inviteUrl(match: Match, base: URL): string {
    const url = new URL(base.href);
    url.hash = '';
    url.search = `?join=${match.code}`;
    return url.href;
  }

  async shareInvite(match: Match, base: URL): Promise<ShareOutcome> {
    const game = this.catalog.find(match.gameId);
    const title = game?.title ?? 'A game';
    return this.share.share({
      title,
      text: `Fight me on ${title} — room ${match.code}`,
      url: this.inviteUrl(match, base),
    });
  }

  /** Reads an invite code out of an opened link, if there is one. */
  static codeFromUrl(url: URL): InviteCode | null {
    const raw = url.searchParams.get('join') ?? url.searchParams.get('room');
    if (!raw) return null;
    const parsed = parseInviteCode(raw);
    return parsed.ok ? parsed.value : null;
  }
}

function seatFor(session: Session): Seat {
  return {
    playerId: session.player.id,
    displayName: displayNameFor(session.player),
    avatarUrl: session.player.avatarUrl,
  };
}

/**
 * The one gate on opening or joining a room.
 *
 * Being signed in is now the whole requirement, so in practice this always
 * passes — every caller already holds a `Session`. It stays because it is the
 * named place the rule lives: deleting it would scatter the policy back into
 * whatever each call site happened to assume, and the security rules have a
 * matching check that has to agree with something.
 */
function requireAccess(session: Session): Result<Session> {
  if (!canPlay(session)) {
    return fail(failure('access-denied', 'Sign in with Google to play.'));
  }
  return ok(session);
}
