import { normaliseEmail, type Player } from '@domain/identity/player.ts';
import type { Session } from '@domain/identity/session.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { AccessDirectoryPort } from '../ports/access-directory.port.ts';
import type { AuthPort } from '../ports/auth.port.ts';
import type { LoggerPort } from '../ports/logger.port.ts';
import type { Listener, Unsubscribe } from '../ports/types.ts';

/**
 * Signing in, and staying signed in.
 *
 * Two steps that are easy to conflate and shouldn't be: Google establishes
 * *identity*, the allowlist establishes *access*. This use case runs both and
 * hands back a `Session` that says which of the two succeeded, so the UI can
 * tell "sign in failed" apart from "signed in, with no admin grant".
 */
export class SessionService {
  constructor(
    private readonly auth: AuthPort,
    private readonly directory: AccessDirectoryPort,
    private readonly logger: LoggerPort,
  ) {}

  async signIn(): Promise<Result<Session>> {
    const signedIn = await this.auth.signInWithGoogle();
    if (!signedIn.ok) return signedIn;
    return ok(await this.resolve(signedIn.value));
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
  }

  /**
   * Watches identity and re-checks access whenever it changes.
   *
   * Emits `null` for "nobody is signed in", and a session with a null `grant`
   * for "signed in, but not invited".
   */
  observe(listener: Listener<Session | null>): Unsubscribe {
    // A slow allowlist lookup that resolves after the player has already
    // signed out again must not be allowed to push a stale session through.
    let generation = 0;

    return this.auth.observe((player) => {
      const mine = ++generation;
      if (!player) {
        listener(null);
        return;
      }
      void this.resolve(player).then((session) => {
        if (mine === generation) listener(session);
      });
    });
  }

  /** Re-reads the allowlist for the player already signed in. */
  async refresh(): Promise<Result<Session>> {
    const player = this.auth.current();
    if (!player) {
      return fail(failure('not-signed-in', 'Sign in first.'));
    }
    return ok(await this.resolve(player));
  }

  /**
   * Pairs a player with their access grant.
   *
   * A directory that is unreachable is treated as "no grant" rather than
   * throwing: the player sees the locked screen with a retry, which is both
   * honest and the safe way to fail.
   */
  private async resolve(player: Player): Promise<Session> {
    if (!player.email) {
      this.logger.log('warn', 'signed-in player has no email; cannot check the allowlist', {
        id: player.id,
      });
      return { player, grant: null } satisfies Session;
    }
    const found = await this.directory.find(normaliseEmail(player.email));
    if (!found.ok) {
      this.logger.log('warn', 'could not read the allowlist', found.error);
      return { player, grant: null } satisfies Session;
    }
    return { player, grant: found.value } satisfies Session;
  }
}
