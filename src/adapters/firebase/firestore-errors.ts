import { failure, type DomainFailure } from '@domain/shared/result.ts';

/**
 * Turns a Firestore exception into a failure with a sentence a player can act
 * on. Doing this in one place means every adapter reports the same way, and
 * that "permission-denied" never reaches the screen as "permission-denied".
 */
export function describeFirestoreError(error: unknown, attempting: string): DomainFailure {
  switch (codeOf(error)) {
    case 'permission-denied':
      return failure('access-denied', `You do not have permission to ${attempting}.`);
    case 'unauthenticated':
      return failure('not-signed-in', 'Your session expired. Sign in again.');
    case 'not-found':
      return failure('match-not-found', 'That is no longer there.');
    case 'already-exists':
      return failure('unavailable', 'Something already holds that place.');
    case 'unavailable':
    case 'deadline-exceeded':
      return failure('unavailable', `Could not reach the server to ${attempting}. Check the network.`);
    case 'failed-precondition':
      return failure(
        'unavailable',
        `Could not ${attempting}. The database may not be set up yet — create a Firestore database and deploy the rules.`,
      );
    case 'resource-exhausted':
      return failure('unavailable', 'The project has hit its Firestore quota for today.');
    default:
      return failure('unavailable', `Could not ${attempting}.`);
  }
}

function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    // FirebaseError codes arrive as "firestore/permission-denied"; the part
    // after the slash is the bit worth switching on.
    const { code } = error;
    const slash = code.lastIndexOf('/');
    return slash >= 0 ? code.slice(slash + 1) : code;
  }
  return 'unknown';
}
