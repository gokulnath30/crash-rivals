import type { AccessGrant, Role } from '@domain/identity/player.ts';
import type { Result } from '@domain/shared/result.ts';

/**
 * The owner's allowlist. Signing in with Google proves who someone is; this
 * port answers whether they were invited.
 */
export interface AccessDirectoryPort {
  /** The grant for an email, or null if they are not on the list. */
  find(email: string): Promise<Result<AccessGrant | null>>;
  /** Admin only, and enforced again by the database's own rules. */
  list(): Promise<Result<readonly AccessGrant[]>>;
  grant(input: { email: string; role: Role; note: string | null }): Promise<Result<AccessGrant>>;
  revoke(email: string): Promise<Result<void>>;
}
