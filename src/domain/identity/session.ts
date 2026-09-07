import { isAdmin, type AccessGrant, type Player } from './player.ts';

/**
 * Who is here and what they may do.
 *
 * Two separate facts, deliberately: Google tells us *who* someone is, and the
 * owner's list says whether they run the place. Those are different questions
 * and one does not imply the other.
 */
export interface Session {
  readonly player: Player;
  /**
   * An explicitly recorded role, or null for the great majority who have none.
   *
   * This used to be the gate on playing at all — the arcade was invitation
   * only, and a signed-in player without a grant got a "not on the list"
   * screen. It no longer decides that. The list now records *admins* only, so
   * a null grant is the ordinary case rather than a locked door.
   */
  readonly grant: AccessGrant | null;
}

/**
 * Anyone signed in may play.
 *
 * Signing in with Google is the whole entry requirement: no list to be added
 * to, no wait for the owner. Worth being clear about what that means — the
 * arcade is open to anybody on the internet with a Google account, and every
 * room they open is a document in the owner's Firestore project.
 *
 * Kept as a named function rather than inlined at the two call sites, because
 * "who may play" is a policy and policies change; when this one does, it
 * changes here.
 */
export const canPlay = (session: Session | null): boolean => session != null;

/** Administering is still by invitation, and still by grant. */
export const canAdminister = (session: Session | null): boolean =>
  session != null && isAdmin(session.grant);
