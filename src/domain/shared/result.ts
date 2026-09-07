/**
 * A success-or-failure value, so use cases can report expected problems
 * ("that room is full") without throwing. Thrown errors stay reserved for
 * genuine defects.
 */
export type Result<T, E = DomainFailure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

export interface DomainFailure {
  /** Stable, machine-readable reason. Safe to branch on. */
  readonly code: FailureCode;
  /** Sentence shown to the player. Written for a human, not a log file. */
  readonly message: string;
}

export type FailureCode =
  | 'invalid-invite-code'
  | 'match-not-found'
  /** The generated invite code is already held by a live room. Retryable. */
  | 'code-taken'
  | 'match-full'
  | 'match-abandoned'
  | 'match-already-started'
  | 'not-your-match'
  | 'game-not-found'
  | 'access-denied'
  | 'sign-in-failed'
  | 'sign-in-cancelled'
  | 'not-signed-in'
  | 'not-an-admin'
  | 'transport-failed'
  | 'unavailable';

export const failure = (code: FailureCode, message: string): DomainFailure => ({ code, message });

/** Narrowing helpers, so callers read as prose. */
export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isFail = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

/** Unwrap a result that the caller has already proven cannot fail. */
export function expect<T, E extends DomainFailure>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`expected a successful result, got ${r.error.code}: ${r.error.message}`);
}
