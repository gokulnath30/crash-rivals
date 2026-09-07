import type { Player } from '@domain/identity/player.ts';
import type { Result } from '@domain/shared/result.ts';
import type { Listener, Unsubscribe } from './types.ts';

/**
 * Sign-in, as the application sees it: a current player or nobody, and a way
 * to be told when that changes. Nothing about Google, tokens or redirects
 * appears here — that is the adapter's business.
 */
export interface AuthPort {
  /** The player signed in right now, or null. Null while still restoring. */
  current(): Player | null;
  /** Fires immediately with the current value, then on every change. */
  observe(listener: Listener<Player | null>): Unsubscribe;
  signInWithGoogle(): Promise<Result<Player>>;
  signOut(): Promise<void>;
  /** Resolves once the provider has finished restoring any existing session. */
  ready(): Promise<void>;
}
