import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { normaliseEmail, type AccessGrant, type Role } from '@domain/identity/player.ts';
import { fail, ok, type Result } from '@domain/shared/result.ts';
import type { AccessDirectoryPort } from '@app/ports/access-directory.port.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import { COLLECTIONS } from './firebase-app.ts';
import { describeFirestoreError } from './firestore-errors.ts';

/**
 * The allowlist, stored one document per invited email.
 *
 * Keying documents by the lower-cased email means "is this person invited?" is
 * a single document read the security rules can authorise by id — no query, no
 * index, and no way for a signed-in visitor to enumerate the whole admin list.
 */
export class FirestoreAccessDirectory implements AccessDirectoryPort {
  private readonly log: LoggerPort;

  constructor(
    private readonly db: Firestore,
    logger: LoggerPort,
  ) {
    this.log = logger.scoped('access');
  }

  async find(email: string): Promise<Result<AccessGrant | null>> {
    const id = normaliseEmail(email);
    try {
      const snapshot = await getDoc(doc(this.db, COLLECTIONS.allowedPlayers, id));
      if (!snapshot.exists()) return ok(null);
      return ok(toGrant(id, snapshot.data()));
    } catch (error: unknown) {
      // A denied read here is the expected answer for someone with no row,
      // not a fault: report "no grant" and let the locked screen explain.
      const described = describeFirestoreError(error, 'check the guest list');
      if (described.code === 'access-denied') return ok(null);
      this.log.log('warn', 'allowlist lookup failed', error);
      return fail(described);
    }
  }

  async list(): Promise<Result<readonly AccessGrant[]>> {
    try {
      const snapshot = await getDocs(collection(this.db, COLLECTIONS.allowedPlayers));
      const grants = snapshot.docs
        .map((entry) => toGrant(entry.id, entry.data()))
        .sort((a, b) => b.grantedAt - a.grantedAt);
      return ok(grants);
    } catch (error: unknown) {
      this.log.log('warn', 'could not list the guest list', error);
      return fail(describeFirestoreError(error, 'read the guest list'));
    }
  }

  async grant(input: { email: string; role: Role; note: string | null }): Promise<Result<AccessGrant>> {
    const id = normaliseEmail(input.email);
    try {
      await setDoc(
        doc(this.db, COLLECTIONS.allowedPlayers, id),
        {
          email: id,
          role: input.role,
          note: input.note,
          grantedAt: serverTimestamp(),
        },
        // Merge, so re-inviting somebody promotes their role instead of
        // wiping the note that says who they are.
        { merge: true },
      );
      return ok({ email: id, role: input.role, note: input.note, grantedAt: Date.now() });
    } catch (error: unknown) {
      this.log.log('warn', 'could not grant access', error);
      return fail(describeFirestoreError(error, 'add someone to the guest list'));
    }
  }

  async revoke(email: string): Promise<Result<void>> {
    try {
      await deleteDoc(doc(this.db, COLLECTIONS.allowedPlayers, normaliseEmail(email)));
      return ok(undefined);
    } catch (error: unknown) {
      this.log.log('warn', 'could not revoke access', error);
      return fail(describeFirestoreError(error, 'remove someone from the guest list'));
    }
  }
}

function toGrant(id: string, data: DocumentData): AccessGrant {
  const role: Role = data['role'] === 'admin' ? 'admin' : 'player';
  const note = typeof data['note'] === 'string' ? data['note'] : null;
  return { email: id, role, note, grantedAt: readMillis(data['grantedAt']) };
}

/**
 * `serverTimestamp()` reads back as a Firestore `Timestamp`, but is null for a
 * moment on the writing client before the server confirms it.
 */
function readMillis(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const timestamp = value as { toMillis?: () => number };
    if (typeof timestamp.toMillis === 'function') return timestamp.toMillis();
  }
  // The writing client sees null until the server fills the timestamp in.
  return Date.now();
}
