import { normaliseEmail, type AccessGrant, type Role } from '@domain/identity/player.ts';
import { canAdminister, type Session } from '@domain/identity/session.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { AccessDirectoryPort } from '../ports/access-directory.port.ts';
import type { LoggerPort } from '../ports/logger.port.ts';

/**
 * Handing out and taking back access.
 *
 * The guard here is a courtesy to the UI, not the security boundary — a
 * determined visitor can call the database directly, so the same rule is
 * written again in the Firestore rules that ship in `firebase/`. Both, or
 * neither.
 */
export class AccessAdminService {
  constructor(
    private readonly directory: AccessDirectoryPort,
    private readonly logger: LoggerPort,
  ) {}

  async list(session: Session): Promise<Result<readonly AccessGrant[]>> {
    const gate = requireAdmin(session);
    if (!gate.ok) return gate;
    return this.directory.list();
  }

  async invite(
    session: Session,
    input: { email: string; role: Role; note: string | null },
  ): Promise<Result<AccessGrant>> {
    const gate = requireAdmin(session);
    if (!gate.ok) return gate;

    const email = normaliseEmail(input.email);
    if (!looksLikeAnEmail(email)) {
      return fail(failure('access-denied', `"${input.email}" is not an email address.`));
    }

    this.logger.log('info', 'granting access', { email, role: input.role });
    return this.directory.grant({ email, role: input.role, note: input.note });
  }

  async revoke(session: Session, email: string): Promise<Result<void>> {
    const gate = requireAdmin(session);
    if (!gate.ok) return gate;

    const target = normaliseEmail(email);
    // Removing your own admin row locks the owner out of their own arcade.
    if (session.player.email && normaliseEmail(session.player.email) === target) {
      return fail(failure('access-denied', 'You cannot remove your own access.'));
    }
    return this.directory.revoke(target);
  }
}

function requireAdmin(session: Session): Result<Session> {
  if (!canAdminister(session)) {
    return fail(failure('not-an-admin', 'Only an arcade admin can change the admin list.'));
  }
  return ok(session);
}

/**
 * Deliberately loose. The authoritative check is whether Google hands back
 * this exact address at sign-in; this only catches a slip of the keyboard.
 */
const looksLikeAnEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
