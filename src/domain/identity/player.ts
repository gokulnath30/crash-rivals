import type { PlayerId } from '../shared/ids.ts';

/** Someone signed in and able to appear in a lobby. */
export interface Player {
  readonly id: PlayerId;
  readonly displayName: string;
  readonly email: string | null;
  readonly avatarUrl: string | null;
}

/** What a signed-in person is allowed to do in the store. */
export type Role = 'player' | 'admin';

/**
 * A row in the owner's allowlist. Sign-in alone does not grant entry; the
 * owner hands out access by adding an entry here.
 */
export interface AccessGrant {
  readonly email: string;
  readonly role: Role;
  readonly note: string | null;
  readonly grantedAt: number;
}

export const isAdmin = (grant: AccessGrant | null): boolean => grant?.role === 'admin';

/**
 * Emails are compared case-insensitively and trimmed, because an allowlist
 * that misses `Sam@Example.com` when the owner typed `sam@example.com` is a
 * support ticket waiting to happen.
 */
export const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/** A friendly, non-empty label for a player, whatever the provider gave us. */
export function displayNameFor(player: Pick<Player, 'displayName' | 'email'>): string {
  const given = player.displayName.trim();
  if (given) return given;
  const local = player.email?.split('@')[0]?.trim();
  return local && local.length > 0 ? local : 'Player';
}

/** First initials, for the avatar fallback chip. */
export function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
