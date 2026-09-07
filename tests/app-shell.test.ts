// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { GameId } from '@domain/shared/ids.ts';
import { ok, type Result } from '@domain/shared/result.ts';
import type { GameRegistryPort, GameRuntime, GameContext, GameHandle } from '@app/ports/game-runtime.port.ts';
import { AccessAdminService } from '@app/usecases/access-admin.usecase.ts';
import { LobbyService } from '@app/usecases/lobby.usecase.ts';
import { PairingService } from '@app/usecases/pairing.usecase.ts';
import { SessionService } from '@app/usecases/session.usecase.ts';
import type { AudioPort } from '@app/ports/audio.port.ts';
import { SilentAudioAdapter } from '@adapters/audio/silent-audio.adapter.ts';
import { App } from '@ui/app.ts';
import {
  FakeAccessDirectory,
  FakeAudio,
  FakeAuth,
  FakeCatalog,
  FakeClock,
  FakeMatchRepository,
  FakeShare,
  SilentLogger,
  TEST_GAME,
} from './support/fakes.ts';

/**
 * A smoke test for the shell, in jsdom.
 *
 * The point is not to test the DOM in detail — it is to prove the composition
 * actually composes. A typecheck cannot tell you that the sign-in button is
 * wired to the sign-in use case, or that a signed-in player with a grant ends
 * up looking at the shelf. This walks that path with every port faked.
 */

/** A game runtime that mounts nothing and records that it was asked to. */
function stubRegistry(): { registry: GameRegistryPort; launched: GameContext[] } {
  const launched: GameContext[] = [];
  const runtime: GameRuntime = {
    id: TEST_GAME.id,
    async launch(context: GameContext): Promise<Result<GameHandle>> {
      launched.push(context);
      return ok({
        stop(): void {
          /* nothing mounted */
        },
      });
    },
  };
  return {
    launched,
    registry: {
      async load(_id: GameId): Promise<Result<GameRuntime>> {
        return ok(runtime);
      },
    },
  };
}

function build(options: { invited?: boolean; audio?: AudioPort } = {}) {
  const auth = new FakeAuth();
  const directory = new FakeAccessDirectory();
  if (options.invited !== false) directory.allow('ada@example.com');

  const logger = new SilentLogger();
  const clock = new FakeClock();
  const matches = new FakeMatchRepository();
  const catalog = new FakeCatalog();
  const audio = options.audio ?? new SilentAudioAdapter();
  const share = new FakeShare();
  const lobby = new LobbyService(matches, catalog, clock, share, logger, () => 0);
  const { registry, launched } = stubRegistry();

  const app = new App({
    session: new SessionService(auth, directory, logger),
    lobby,
    pairing: new PairingService(
      () => {
        throw new Error('the shell should not open a peer link in this test');
      },
      lobby,
      logger,
    ),
    access: new AccessAdminService(directory, logger),
    share,
    catalog,
    registry,
    audio,
    clock,
    logger,
    cloudConfigured: true,
    missingSettings: [],
  });

  const root = document.createElement('div');
  document.body.append(root);
  return { app, root, auth, directory, audio, share, launched };
}

/** Lets the microtask queue drain, since the session resolves asynchronously. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

const buttonLabelled = (root: HTMLElement, label: string): HTMLButtonElement | null =>
  [...root.querySelectorAll('button')].find((node) => node.textContent === label) ?? null;

describe('the app shell', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.history.replaceState(null, '', '/');
  });

  it('opens on the sign-in screen', () => {
    const { app, root } = build();
    app.mount(root);
    expect(root.textContent).toContain('The Arcade');
    expect(buttonLabelled(root, 'Sign in with Google')).not.toBeNull();
    app.dispose();
  });

  it('shows the shelf once an invited player signs in', async () => {
    const { app, root } = build();
    app.mount(root);

    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();

    expect(root.textContent).toContain('Pick a game');
    expect(root.textContent).toContain(TEST_GAME.title);
    app.dispose();
  });

  it('takes a player on no list straight to the shelf', async () => {
    // There used to be a "Not on the list" screen here, with a "Check again"
    // button to press once the owner had added you. Both are gone: signing in
    // with Google is the whole entry requirement.
    const { app, root } = build({ invited: false });
    app.mount(root);

    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();

    expect(root.textContent).toContain('Pick a game');
    expect(root.textContent).not.toContain('Not on the list');
    app.dispose();
  });

  it('gives a player with no grant a name and a way out', async () => {
    // The header used to be drawn only for a player who held a grant, which
    // was harmless when a grant was the price of entry and is not now: it
    // left an ordinary player signed in with no visible identity and no
    // sign-out button.
    const { app, root } = build({ invited: false });
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();

    expect(root.textContent).toContain('Ada');
    expect(buttonLabelled(root, 'Sign out')).not.toBeNull();
    app.dispose();
  });

  it('keeps the admin list out of reach of a player who is not an admin', async () => {
    // Opening the doors to players must not open them to administration.
    const { app, root } = build({ invited: false });
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();

    expect(buttonLabelled(root, 'Admins')).toBeNull();
    app.dispose();
  });

  it('opens a game page from the shelf and offers its modes', async () => {
    const { app, root } = build();
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();

    buttonLabelled(root, 'Open')?.click();
    await settle();

    expect(root.textContent).toContain(TEST_GAME.blurb);
    expect(buttonLabelled(root, 'Solo vs the machine')).not.toBeNull();
    expect(buttonLabelled(root, 'Invite a friend')).not.toBeNull();
    app.dispose();
  });

  it('launches a game and hands it a mount to draw into', async () => {
    const { app, root, launched } = build();
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();
    buttonLabelled(root, 'Open')?.click();
    await settle();

    buttonLabelled(root, 'Solo vs the machine')?.click();
    await settle();

    expect(launched).toHaveLength(1);
    expect(launched[0]?.mode).toBe('solo');
    expect(launched[0]?.labels.opponent).toBe('ROBOT');
    expect(launched[0]?.online).toBeNull();
    app.dispose();
  });

  it('hides the store shell while a game is running, and brings it back', async () => {
    const { app, root, launched } = build();
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();
    buttonLabelled(root, 'Open')?.click();
    await settle();
    buttonLabelled(root, 'Solo vs the machine')?.click();
    await settle();

    const shell = root.querySelector('.shell');
    expect(shell?.hasAttribute('hidden')).toBe(true);

    // The game asks to leave, the way its own back button does.
    launched[0]?.exit();
    await settle();

    expect(shell?.hasAttribute('hidden')).toBe(false);
    expect(root.textContent).toContain('Pick a game');
    app.dispose();
  });

  it('tears the game down when the player signs out mid-game', async () => {
    // Otherwise the shell stays hidden and the player is left staring at a
    // live match with no way back into the store.
    const { app, root, auth, launched } = build();
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();
    buttonLabelled(root, 'Open')?.click();
    await settle();
    buttonLabelled(root, 'Solo vs the machine')?.click();
    await settle();

    const shell = root.querySelector('.shell');
    const mount = root.querySelector('.game-mount');
    expect(shell?.hasAttribute('hidden')).toBe(true);
    expect(launched).toHaveLength(1);

    await auth.signOut();
    await settle();

    expect(shell?.hasAttribute('hidden')).toBe(false);
    expect(mount?.hasAttribute('hidden')).toBe(true);
    expect(root.textContent).toContain('The Arcade');
    app.dispose();
  });

  it('copies the invite instead of opening a share sheet', async () => {
    // A button labelled "Copy the link" that opens a share sheet is a button
    // that lied.
    const { app, root, share } = build();
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();
    buttonLabelled(root, 'Open')?.click();
    await settle();
    buttonLabelled(root, 'Invite a friend')?.click();
    await settle();

    buttonLabelled(root, 'Copy the link')?.click();
    await settle();

    expect(share.copied).toHaveLength(1);
    expect(share.copied[0]).toContain('join=');
    expect(share.shared).toHaveLength(0);
    app.dispose();
  });

  it('still uses the share sheet for "Send the link"', async () => {
    const { app, root, share } = build();
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();
    buttonLabelled(root, 'Open')?.click();
    await settle();
    buttonLabelled(root, 'Invite a friend')?.click();
    await settle();

    buttonLabelled(root, 'Send the link')?.click();
    await settle();

    expect(share.shared).toHaveLength(1);
    app.dispose();
  });

  it('labels the sound button by what pressing it does', async () => {
    const { app, root } = build({ audio: new FakeAudio() });
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();

    // Not "Sound off", which reads as a state that has already been applied.
    expect(buttonLabelled(root, 'Mute')).not.toBeNull();
    buttonLabelled(root, 'Mute')?.click();
    await settle();
    expect(buttonLabelled(root, 'Unmute')).not.toBeNull();
    app.dispose();
  });

  it('shows the admin list to an admin', async () => {
    const { app, root, directory } = build({ invited: false });
    directory.allow('ada@example.com', 'admin');
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();

    const link = buttonLabelled(root, 'Admins');
    expect(link).not.toBeNull();
    link?.click();
    await settle();
    expect(root.textContent).toContain('Add someone');
    app.dispose();
  });

  it('does not offer the admin list to an ordinary player', async () => {
    const { app, root } = build();
    app.mount(root);
    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();
    expect(buttonLabelled(root, 'Admins')).toBeNull();
    app.dispose();
  });

  it('greys out online play when there is no project behind it', async () => {
    const auth = new FakeAuth();
    const directory = new FakeAccessDirectory();
    directory.allow('ada@example.com');
    const logger = new SilentLogger();
    const clock = new FakeClock();
    const catalog = new FakeCatalog();
    const share = new FakeShare();
    const lobby = new LobbyService(new FakeMatchRepository(), catalog, clock, share, logger, () => 0);
    const app = new App({
      session: new SessionService(auth, directory, logger),
      lobby,
      pairing: new PairingService(
        () => {
          throw new Error('unused');
        },
        lobby,
        logger,
      ),
      access: new AccessAdminService(directory, logger),
      share,
      catalog,
      registry: stubRegistry().registry,
      audio: new SilentAudioAdapter(),
      clock,
      logger,
      cloudConfigured: false,
      missingSettings: ['VITE_FIREBASE_API_KEY'],
    });

    const root = document.createElement('div');
    document.body.append(root);
    app.mount(root);

    // The sign-in screen says what is missing rather than failing silently.
    expect(root.textContent).toContain('No Firebase project configured');
    expect(root.textContent).toContain('VITE_FIREBASE_API_KEY');

    buttonLabelled(root, 'Play as a local guest')?.click();
    await settle();
    buttonLabelled(root, 'Open')?.click();
    await settle();

    expect(buttonLabelled(root, 'Invite a friend')?.disabled).toBe(true);
    expect(root.textContent).toContain('Invite links need a Firebase project');
    app.dispose();
  });

  it('carries an invite code from the URL into a join attempt', async () => {
    window.history.replaceState(null, '', '/?join=0000');
    const { app, root } = build();
    app.mount(root);

    buttonLabelled(root, 'Sign in with Google')?.click();
    await settle();

    // No room exists on that code, so the joining screen explains itself —
    // the point is that the code was picked up and acted on at all.
    expect(root.textContent).toContain('0000');
    app.dispose();
  });
});
