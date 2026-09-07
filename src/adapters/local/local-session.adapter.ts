import type { AccessGrant, Player, Role } from '@domain/identity/player.ts';
import { asPlayerId } from '@domain/shared/ids.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { AccessDirectoryPort } from '@app/ports/access-directory.port.ts';
import type { AuthPort } from '@app/ports/auth.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';

const STORAGE_KEY = 'arcade.localPlayer';

/**
 * The address a local guest is given.
 *
 * Not a real one, and it never leaves the browser — but access is looked up
 * by email, so the guest needs one to be grantable at all.
 */
const LOCAL_GUEST_EMAIL = 'guest@localhost';

/**
 * A stand-in for Firebase Auth when no project is configured.
 *
 * This exists so the repository is runnable the moment it is cloned: `npm run
 * dev`, press play, and the solo games work. It signs you in
 * as a guest whose identity lives in this browser only. It grants nothing that
 * needs a server, and invite links are unavailable — the store says so rather
 * than failing mysteriously.
 */
export class LocalGuestAuth implements AuthPort {
  private player: Player | null = null;
  private readonly listeners = new Set<Listener<Player | null>>();

  constructor() {
    this.player = readStored();
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
    /* nothing to restore beyond what the constructor read */
  }

  async signInWithGoogle(): Promise<Result<Player>> {
    // Deliberately not pretending to be Google. This is a local guest.
    const player: Player = this.player ?? {
      id: asPlayerId(`guest-${randomSuffix()}`),
      displayName: 'Guest',
      // A local address rather than null. Access is resolved *by email*, so a
      // guest without one can never be granted anything and would sit on the
      // "not on the list" screen forever — which made the whole no-Firebase
      // mode unreachable. That screen is gone now, but the address still has
      // to be here: it is what an admin grant would be looked up by.
      email: LOCAL_GUEST_EMAIL,
      avatarUrl: null,
    };
    this.player = player;
    writeStored(player);
    for (const listener of this.listeners) listener(player);
    return ok(player);
  }

  async signOut(): Promise<void> {
    this.player = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* private browsing */
    }
    for (const listener of this.listeners) listener(null);
  }
}

/**
 * Grants everyone who gets this far, because "everyone" is one person on one
 * device. The real allowlist is `FirestoreAccessDirectory`.
 */
export class OpenAccessDirectory implements AccessDirectoryPort {
  async find(email: string): Promise<Result<AccessGrant | null>> {
    return ok(localGrant(email, 'player'));
  }

  async list(): Promise<Result<readonly AccessGrant[]>> {
    return fail(
      failure('unavailable', 'The admin list needs a Firebase project. See README.md.'),
    );
  }

  async grant(): Promise<Result<AccessGrant>> {
    return fail(
      failure('unavailable', 'Inviting players needs a Firebase project. See README.md.'),
    );
  }

  async revoke(): Promise<Result<void>> {
    return fail(
      failure('unavailable', 'Inviting players needs a Firebase project. See README.md.'),
    );
  }
}

const localGrant = (email: string, role: Role): AccessGrant => ({
  email,
  role,
  note: 'Local guest — no Firebase project configured',
  grantedAt: Date.now(),
});

function readStored(): Player | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { id, displayName } = parsed as Record<string, unknown>;
    if (typeof id !== 'string') return null;
    return {
      id: asPlayerId(id),
      displayName: typeof displayName === 'string' ? displayName : 'Guest',
      email: LOCAL_GUEST_EMAIL,
      avatarUrl: null,
    };
  } catch {
    return null;
  }
}

function writeStored(player: Player): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: player.id, displayName: player.displayName }));
  } catch {
    /* private browsing: the guest simply will not persist */
  }
}

function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
