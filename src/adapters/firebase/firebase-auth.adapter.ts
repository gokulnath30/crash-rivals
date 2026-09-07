import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import { asPlayerId } from '@domain/shared/ids.ts';
import type { Player } from '@domain/identity/player.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { AuthPort } from '@app/ports/auth.port.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import { authDomainIsCrossOrigin } from '@config/env.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';
import { browserFacts, prefersRedirect } from './sign-in-flow.ts';

/**
 * Google sign-in via Firebase Auth.
 *
 * Popup where a popup works, redirect where it does not — and which is which
 * is decided up front by `prefersRedirect`, not discovered from an error.
 *
 * It used to be popup-always with a redirect fallback on `auth/popup-blocked`.
 * That reads sensibly and fails badly on an iPhone: the popup is not blocked,
 * it opens, Google accepts the login, and then the credential cannot get back
 * to the app. No error is thrown for the fallback to catch. The player is
 * returned to a page that still thinks nobody is signed in, and trying again
 * does the same thing.
 *
 * `ready()` collects the redirect result on load, which is what turns a
 * returning redirect into an auth state change.
 */
export class FirebaseAuthAdapter implements AuthPort {
  private player: Player | null = null;
  private readonly listeners = new Set<Listener<Player | null>>();
  private readonly restored: Promise<void>;
  private readonly log: LoggerPort;

  constructor(
    private readonly auth: Auth,
    logger: LoggerPort,
  ) {
    this.log = logger.scoped('auth');

    this.restored = new Promise<void>((resolve) => {
      let settled = false;
      onAuthStateChanged(
        this.auth,
        (user) => {
          this.player = user ? toPlayer(user) : null;
          for (const listener of this.listeners) listener(this.player);
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        (error: unknown) => {
          this.log.log('error', 'auth state listener failed', error);
          if (!settled) {
            settled = true;
            resolve();
          }
        },
      );
    });

    /*
     * A redirect sign-in lands back here; collecting the result is what turns
     * it into an auth state change.
     *
     * An error here is not always nothing. "No pending redirect" is the
     * ordinary case on every normal page load, but this is also where a
     * cross-origin `authDomain` fails — the credential cannot be read back —
     * and that presents as signing in doing nothing at all. So it is logged as
     * a warning with the likely cause attached, rather than as a debug line
     * nobody reads.
     */
    void getRedirectResult(this.auth).catch((error: unknown) => {
      this.log.log('warn', 'could not complete a redirect sign-in', {
        error,
        authDomain: this.auth.config.authDomain,
        crossOrigin: authDomainIsCrossOrigin(),
      });
    });
  }

  current(): Player | null {
    return this.player;
  }

  observe(listener: Listener<Player | null>): Unsubscribe {
    this.listeners.add(listener);
    listener(this.player);
    return () => this.listeners.delete(listener);
  }

  async ready(): Promise<void> {
    await this.restored;
  }

  async signInWithGoogle(): Promise<Result<Player>> {
    const provider = new GoogleAuthProvider();
    // Always ask which account, rather than silently reusing the one the
    // browser happens to be signed into.
    provider.setCustomParameters({ prompt: 'select_account' });

    if (prefersRedirect(browserFacts())) {
      this.log.log('info', 'using a redirect sign-in for this browser');
      return this.redirect(provider);
    }

    try {
      const credential = await signInWithPopup(this.auth, provider);
      return ok(toPlayer(credential.user));
    } catch (error: unknown) {
      const code = errorCodeOf(error);

      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return fail(failure('sign-in-cancelled', 'Sign-in was cancelled.'));
      }

      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        // Still worth keeping: a popup blocker is a real thing on desktop too.
        this.log.log('info', 'popup blocked; falling back to a redirect');
        return this.redirect(provider);
      }

      if (code === 'auth/unauthorized-domain') {
        return fail(
          failure(
            'sign-in-failed',
            'This domain is not authorised in your Firebase project. Add it under Authentication → Settings → Authorised domains.',
          ),
        );
      }

      if (code === 'auth/configuration-not-found' || code === 'auth/operation-not-allowed') {
        return fail(
          failure(
            'sign-in-failed',
            'Google sign-in is not switched on in this Firebase project. Enable it under Authentication → Sign-in method.',
          ),
        );
      }

      if (code === 'auth/network-request-failed') {
        return fail(failure('unavailable', 'No connection to Google. Check the network and retry.'));
      }

      this.log.log('error', 'sign-in failed', error);
      return fail(failure('sign-in-failed', 'Google sign-in did not go through. Try again.'));
    }
  }

  /**
   * Hands the page over to Google.
   *
   * Returns a failure because there is no success to return: the browser is
   * navigating away, and the outcome arrives on the next load through
   * `getRedirectResult`. The message is worded as progress rather than a
   * problem, because that is what the player is about to see for the moment
   * before the page goes.
   */
  private async redirect(provider: GoogleAuthProvider): Promise<Result<Player>> {
    try {
      await signInWithRedirect(this.auth, provider);
      return fail(failure('sign-in-failed', 'Taking you to Google…'));
    } catch (error: unknown) {
      this.log.log('error', 'redirect sign-in failed', error);
      return fail(failure('sign-in-failed', 'Could not open Google sign-in.'));
    }
  }

  async signOut(): Promise<void> {
    try {
      await signOut(this.auth);
    } catch (error: unknown) {
      this.log.log('warn', 'sign-out failed', error);
    }
  }
}

function toPlayer(user: User): Player {
  return {
    id: asPlayerId(user.uid),
    displayName: user.displayName ?? '',
    email: user.email,
    avatarUrl: user.photoURL,
  };
}

/** Firebase throws `FirebaseError`, but only structurally — read it defensively. */
function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'unknown';
}
