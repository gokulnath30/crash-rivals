import { describe, expect, it } from 'vitest';
import { canAdminister, canPlay, type Session } from '@domain/identity/session.ts';
import { AccessAdminService } from '@app/usecases/access-admin.usecase.ts';
import { SessionService } from '@app/usecases/session.usecase.ts';
import { LocalGuestAuth, OpenAccessDirectory } from '@adapters/local/local-session.adapter.ts';
import { FakeAccessDirectory, FakeAuth, SilentLogger, testPlayer } from './support/fakes.ts';

const session = (role: 'player' | 'admin' | null, email = 'ada@example.com'): Session => ({
  player: testPlayer({ email }),
  grant: role ? { email, role, note: null, grantedAt: 0 } : null,
});

describe('signing in', () => {
  function build() {
    const auth = new FakeAuth();
    const directory = new FakeAccessDirectory();
    return { auth, directory, service: new SessionService(auth, directory, new SilentLogger()) };
  }

  it('pairs an invited player with their grant', async () => {
    const { directory, service } = build();
    directory.allow('ada@example.com');

    const result = await service.signIn();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(canPlay(result.value)).toBe(true);
  });

  it('lets a player with no grant straight through to the games', async () => {
    // Identity is established and that is now the whole requirement. The
    // grant is still resolved — it is what decides admin — but a null one is
    // the ordinary case rather than a locked door.
    const { service } = build();
    const result = await service.signIn();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.player.email).toBe('ada@example.com');
    expect(result.value.grant).toBeNull();
    expect(canPlay(result.value)).toBe(true);
    expect(canAdminister(result.value)).toBe(false);
  });

  it('matches the allowlist regardless of how the address was capitalised', async () => {
    const { auth, directory } = build();
    directory.allow('ADA@Example.COM');
    const service = new SessionService(auth, directory, new SilentLogger());

    const result = await service.signIn();
    expect(result.ok && canPlay(result.value)).toBe(true);
  });

  it('reports a cancelled sign-in as cancelled, not as a failure', async () => {
    const { auth, service } = build();
    auth.failWith = 'cancelled';
    const result = await service.signIn();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('sign-in-cancelled');
  });

  it('treats an unreachable allowlist as no access rather than crashing', async () => {
    // Failing closed is both the safe choice and the honest one: the player
    // gets the locked screen with a retry.
    const { directory, service } = build();
    directory.allow('ada@example.com');
    directory.unreachable = true;

    const result = await service.signIn();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.grant).toBeNull();
  });

  it('grants no access to an account with no email to check', async () => {
    const auth = new FakeAuth(testPlayer({ email: null }));
    const directory = new FakeAccessDirectory();
    const service = new SessionService(auth, directory, new SilentLogger());

    const result = await service.signIn();
    expect(result.ok && result.value.grant).toBeNull();
  });

  describe('observing', () => {
    it('emits null when nobody is signed in, then a session once they are', async () => {
      const { auth, directory, service } = build();
      directory.allow('ada@example.com');

      const seen: (string | null)[] = [];
      service.observe((value) => {
        seen.push(value?.grant?.role ?? (value ? 'no-grant' : null));
      });

      await auth.signInWithGoogle();
      // The allowlist lookup is async, so let it settle.
      await Promise.resolve();
      await Promise.resolve();

      expect(seen[0]).toBeNull();
      expect(seen).toContain('player');
    });

    it('emits null again on sign-out', async () => {
      const { auth, directory, service } = build();
      directory.allow('ada@example.com');
      await auth.signInWithGoogle();

      const seen: (string | null)[] = [];
      service.observe((value) => {
        seen.push(value ? 'session' : null);
      });
      await auth.signOut();

      expect(seen.at(-1)).toBeNull();
    });
  });

  it('re-reads the allowlist on refresh, so a new invite takes effect', async () => {
    const { auth, directory, service } = build();
    await auth.signInWithGoogle();

    const before = await service.refresh();
    expect(before.ok && before.value.grant).toBeNull();

    // The owner adds them while the locked screen is open.
    directory.allow('ada@example.com');
    const after = await service.refresh();
    expect(after.ok && canPlay(after.value)).toBe(true);
  });

  it('cannot refresh when nobody is signed in', async () => {
    const { service } = build();
    const result = await service.refresh();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-signed-in');
  });
});

describe('running with no Firebase project', () => {
  it('lets a local guest through to the games', async () => {
    // This was broken and invisible: the local guest was created with a null
    // email, access is resolved *by* email, so the guest could never be
    // granted anything and sat on the "not on the list" screen forever —
    // making the entire no-Firebase mode unreachable.
    const service = new SessionService(
      new LocalGuestAuth(),
      new OpenAccessDirectory(),
      new SilentLogger(),
    );

    const result = await service.signIn();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(canPlay(result.value)).toBe(true);
  });

  it('gives the guest an email to be granted against', async () => {
    const service = new SessionService(
      new LocalGuestAuth(),
      new OpenAccessDirectory(),
      new SilentLogger(),
    );
    const result = await service.signIn();
    expect(result.ok && result.value.player.email).toBeTruthy();
  });
});

describe('managing the guest list', () => {
  function build() {
    const directory = new FakeAccessDirectory();
    return { directory, service: new AccessAdminService(directory, new SilentLogger()) };
  }

  it('lets an admin invite someone', async () => {
    const { directory, service } = build();
    const result = await service.invite(session('admin'), {
      email: 'Grace@Example.com',
      role: 'player',
      note: 'from the lab',
    });
    expect(result.ok).toBe(true);
    // Stored lower-cased, so the sign-in lookup will find it.
    expect(directory.grants.has('grace@example.com')).toBe(true);
  });

  it('refuses a plain player', async () => {
    const { directory, service } = build();
    const result = await service.invite(session('player'), {
      email: 'grace@example.com',
      role: 'admin',
      note: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-an-admin');
    expect(directory.grants.size).toBe(0);
  });

  it('refuses someone with no grant at all', async () => {
    const { service } = build();
    const result = await service.list(session(null));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-an-admin');
  });

  it('rejects something that is not an email address', async () => {
    const { service } = build();
    const result = await service.invite(session('admin'), {
      email: 'not an email',
      role: 'player',
      note: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('access-denied');
  });

  it('lets an admin revoke someone else', async () => {
    const { directory, service } = build();
    directory.allow('grace@example.com');
    const result = await service.revoke(session('admin'), 'grace@example.com');
    expect(result.ok).toBe(true);
    expect(directory.grants.size).toBe(0);
  });

  it('will not let an admin remove their own access', async () => {
    // One careless tap should not lock the owner out of their own arcade.
    const { directory, service } = build();
    directory.allow('ada@example.com', 'admin');
    const result = await service.revoke(session('admin'), 'ADA@example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('access-denied');
    expect(directory.grants.has('ada@example.com')).toBe(true);
  });
});

describe('session predicates', () => {
  it('sorts out who may play and who may administer', () => {
    // Playing needs a session and nothing more; administering needs a grant
    // that says admin. These are deliberately different questions.
    expect(canPlay(null)).toBe(false);
    expect(canPlay(session(null))).toBe(true);
    expect(canPlay(session('player'))).toBe(true);
    expect(canPlay(session('admin'))).toBe(true);

    expect(canAdminister(null)).toBe(false);
    expect(canAdminister(session('player'))).toBe(false);
    expect(canAdminister(session('admin'))).toBe(true);
  });
});
