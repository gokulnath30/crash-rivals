import type { GameDefinition, GameMode } from '@domain/catalog/game-definition.ts';
import { displayNameFor, initialsFor, normaliseEmail, type AccessGrant, type Role } from '@domain/identity/player.ts';
import { canAdminister, type Session } from '@domain/identity/session.ts';
import { opponentsOf, seatAt, type Match } from '@domain/lobby/match.ts';
import type { AudioPort } from '@app/ports/audio.port.ts';
import type { ClockPort } from '@app/ports/clock.port.ts';
import type { GameCatalogPort } from '@app/ports/game-catalog.port.ts';
import type { GameHandle, GameRegistryPort, OnlineSession } from '@app/ports/game-runtime.port.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import type { SharePort } from '@app/ports/share.port.ts';
import type { Unsubscribe } from '@app/ports/types.ts';
import type { AccessAdminService } from '@app/usecases/access-admin.usecase.ts';
import { LobbyService } from '@app/usecases/lobby.usecase.ts';
import type { PairingService } from '@app/usecases/pairing.usecase.ts';
import type { SessionService } from '@app/usecases/session.usecase.ts';
import { avatar, button, clear, el } from './dom.ts';
import { renderAdmin } from './screens/admin.screen.ts';
import { renderGame } from './screens/game.screen.ts';
import type { PairingHandle, PairingStage, RosterEntry } from '@app/usecases/pairing.usecase.ts';
import { renderJoining, renderLobby } from './screens/lobby.screen.ts';
import { renderSignIn } from './screens/sign-in.screen.ts';
import { canFullscreen, isFullscreen, onFullscreenChange, toggleFullscreen } from './fullscreen.ts';
import { renderStore } from './screens/store.screen.ts';

export interface AppDependencies {
  readonly session: SessionService;
  readonly lobby: LobbyService;
  readonly pairing: PairingService;
  readonly access: AccessAdminService;
  readonly share: SharePort;
  readonly catalog: GameCatalogPort;
  readonly registry: GameRegistryPort;
  readonly audio: AudioPort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  /** False when no Firebase project is configured; online play is then off. */
  readonly cloudConfigured: boolean;
  readonly missingSettings: readonly string[];
}

type View =
  | { readonly kind: 'loading' }
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'store' }
  | { readonly kind: 'game'; readonly game: GameDefinition }
  | {
      readonly kind: 'lobby';
      readonly game: GameDefinition;
      readonly match: Match;
      /** Who is in the room, as the pairing service last reported it. */
      readonly roster: readonly RosterEntry[];
      readonly capacity: number;
      readonly canStart: boolean;
      readonly note: string;
      readonly failed: boolean;
      readonly isHost: boolean;
    }
  | {
      readonly kind: 'joining';
      readonly code: string;
      readonly message: string;
      readonly failed: boolean;
    }
  | { readonly kind: 'playing'; readonly game: GameDefinition }
  | { readonly kind: 'admin' };

const ONLINE_UNAVAILABLE =
  'Invite links need a Firebase project. Add one to .env and reload — solo play against the machine works without it.';

/**
 * The store shell.
 *
 * Holds the view state, calls use cases, and re-renders. It is the only place
 * that knows what screen is on, which is what keeps every screen a plain
 * function of its props.
 *
 * The one thing that does *not* re-render is a running game: the game owns a
 * WebGL context, a camera stream and an animation loop, and tearing that down
 * because a header label changed would be absurd. So the game mount is a
 * sibling of the shell, and the shell simply hides itself while a game runs.
 */
export class App {
  private view: View = { kind: 'loading' };
  private session: Session | null = null;
  private busy = false;
  private error: string | null = null;

  private activeTag: string | null = null;
  private playMode: GameMode | null = null;
  private shareNote: string | null = null;

  private grants: readonly AccessGrant[] = [];
  private grantsLoading = false;
  private adminNote: string | null = null;

  /** An invite code from the URL, held until somebody is signed in to use it. */
  private pendingCode: string | null = null;

  private shell!: HTMLElement;
  private stopFullscreenWatch: (() => void) | null = null;
  private installPrompt: InstallPromptEvent | null = null;
  private main!: HTMLElement;
  private gameMount!: HTMLElement;
  private header!: HTMLElement;

  private activeGame: GameHandle | null = null;
  /** The online session of the game currently running, if any. */
  private activeOnline: OnlineSession | null = null;
  /**
   * The room currently being filled, host or guest.
   *
   * Held rather than just its canceller, because the lobby now has a button
   * that reaches back into it: the host decides when a partly-full room
   * starts.
   */
  private pairing: PairingHandle | null = null;
  private stopWatchingSession: Unsubscribe | null = null;
  private watchingMatch: Unsubscribe | null = null;

  constructor(private readonly deps: AppDependencies) {}

  mount(root: HTMLElement): void {
    this.pendingCode = LobbyService.codeFromUrl(new URL(window.location.href));

    this.header = el('header', { className: 'topbar' });
    this.main = el('main', { className: 'wrap' });
    this.shell = el('div', { className: 'shell' }, [this.header, this.main]);
    this.gameMount = el('div', { className: 'game-mount', attrs: { hidden: '' } });
    this.gameMount.hidden = true;

    root.append(this.shell, this.gameMount);

    // Repaint the header when fullscreen changes, so the button matches the
    // state even when the player left with Escape rather than the button.
    this.stopFullscreenWatch = onFullscreenChange(() => {
      this.render();
    });

    // The browser's install offer arrives whenever it decides the app
    // qualifies, which may be after this render. Held rather than acted on:
    // `prompt()` needs a user gesture, so it waits for the button.
    window.addEventListener('beforeinstallprompt', (event) => {
      // Preventing the default suppresses Chrome's own mini-infobar, which
      // is what lets the offer live in the header instead.
      event.preventDefault();
      this.installPrompt = event as InstallPromptEvent;
      this.render();
    });
    window.addEventListener('appinstalled', () => {
      this.installPrompt = null;
      this.render();
    });

    this.stopWatchingSession = this.deps.session.observe((session) => {
      this.onSession(session);
    });
    this.render();
  }

  dispose(): void {
    this.stopFullscreenWatch?.();
    this.stopWatchingSession?.();
    this.pairing?.cancel();
    this.watchingMatch?.();
    this.activeGame?.stop();
    this.deps.audio.dispose();
  }

  // -------------------------------------------------------------- session

  private onSession(session: Session | null): void {
    const wasSignedIn = this.session !== null;
    this.session = session;

    if (!session) {
      // Signing out while a game is running: stop it, or the player is left
      // staring at a live match with the store hidden behind it.
      this.closeActiveGame();
      this.activeOnline = null;
      this.go({ kind: 'sign-in' });
      return;
    }
    // Only redirect on the transition into a usable session; re-resolving the
    // session mid-game must not throw the player out of a fight.
    if (!wasSignedIn || this.view.kind === 'sign-in') {
      const code = this.pendingCode;
      if (code) {
        this.pendingCode = null;
        this.clearCodeFromUrl();
        void this.joinByCode(code);
        return;
      }
      this.go({ kind: 'store' });
      this.deps.audio.startMusic('menu');
    }
  }

  private async signIn(): Promise<void> {
    this.busy = true;
    this.error = null;
    this.render();
    // The click that got us here is the gesture the browser wanted.
    await this.deps.audio.unlock();

    const result = await this.deps.session.signIn();
    this.busy = false;
    if (!result.ok) {
      // A cancelled sign-in is not worth an error message.
      this.error = result.error.code === 'sign-in-cancelled' ? null : result.error.message;
      if (this.error) this.deps.audio.play('ui-error');
    }
    this.render();
  }

  // ---------------------------------------------------------------- playing

  private async play(game: GameDefinition, mode: GameMode): Promise<void> {
    this.deps.audio.play('ui-confirm');
    if (mode !== 'online-versus') {
      await this.launch(game, mode, null);
      return;
    }
    await this.host(game);
  }

  /** Opens a room and waits for the other player. */
  private async host(game: GameDefinition): Promise<void> {
    const session = this.session;
    if (!session) return;

    this.playMode = 'online-versus';
    this.error = null;
    this.render();

    const opened = await this.deps.lobby.host({ session, gameId: game.id });
    this.playMode = null;
    if (!opened.ok) {
      this.error = opened.error.message;
      this.deps.audio.play('ui-error');
      this.render();
      return;
    }

    const match = opened.value;
    this.pairing = this.deps.pairing.hostRoom({
      session,
      match,
      onStage: (stage) => {
        this.showPairingStage(game, match, stage, true);
      },
    });
  }

  /**
   * Paints one report from the pairing service. Shared by both sides of the
   * room, because from here hosting and joining differ only in who may start.
   */
  private showPairingStage(
    game: GameDefinition,
    match: Match,
    stage: PairingStage,
    isHost: boolean,
  ): void {
    switch (stage.kind) {
      case 'waiting': {
        const known = this.view.kind === 'lobby' ? this.view.roster.length : 0;
        // A chime when the room grows, not on every report — the roster is
        // re-announced whenever any connection changes state.
        if (stage.roster.length > known) this.deps.audio.play('peer-joined');
        this.go({
          kind: 'lobby',
          game,
          match,
          roster: stage.roster,
          capacity: stage.capacity,
          canStart: stage.canStart,
          note: stage.note,
          failed: false,
          isHost,
        });
        break;
      }
      case 'connected':
        this.pairing = null;
        void this.launch(game, 'online-versus', stage.session);
        break;
      case 'failed':
        this.pairing = null;
        this.deps.audio.play('ui-error');
        this.go({
          kind: 'lobby',
          game,
          match,
          roster: this.view.kind === 'lobby' ? this.view.roster : [],
          capacity: this.view.kind === 'lobby' ? this.view.capacity : 2,
          canStart: false,
          note: stage.message,
          failed: true,
          isHost,
        });
        break;
    }
  }

  /** Takes a free seat in someone else's room. */
  private async joinByCode(rawCode: string): Promise<void> {
    const session = this.session;
    if (!session) {
      // Hold the code and let sign-in come back to it.
      this.pendingCode = rawCode;
      this.go({ kind: 'sign-in' });
      return;
    }

    this.go({ kind: 'joining', code: rawCode.toUpperCase(), message: 'Finding the room…', failed: false });

    const joined = await this.deps.lobby.join({ session, code: rawCode });
    if (!joined.ok) {
      this.deps.audio.play('ui-error');
      this.go({
        kind: 'joining',
        code: rawCode.toUpperCase(),
        message: joined.error.message,
        failed: true,
      });
      return;
    }

    const match = joined.value;
    const game = this.deps.catalog.find(match.gameId);
    if (!game) {
      this.go({
        kind: 'joining',
        code: match.code,
        message: 'That room is for a game this arcade does not have.',
        failed: true,
      });
      return;
    }

    this.go({ kind: 'joining', code: match.code, message: 'Connecting to the host…', failed: false });

    this.pairing = this.deps.pairing.joinRoom({
      session,
      match,
      onStage: (stage) => {
        this.showPairingStage(game, match, stage, false);
      },
    });
  }

  /** Loads a game's code and hands it the screen. */
  private async launch(
    game: GameDefinition,
    mode: GameMode,
    online: OnlineSession | null,
  ): Promise<void> {
    this.playMode = mode;
    this.render();

    const loaded = await this.deps.registry.load(game.id);
    this.playMode = null;
    if (!loaded.ok) {
      this.error = loaded.error.message;
      this.go({ kind: 'game', game });
      return;
    }

    clear(this.gameMount);
    this.gameMount.hidden = false;
    this.shell.hidden = true;
    this.view = { kind: 'playing', game };

    const labels = this.labelsFor(game, online);
    const launched = await loaded.value.launch({
      mode,
      mount: this.gameMount,
      audio: this.deps.audio,
      clock: this.deps.clock,
      logger: this.deps.logger.scoped(game.id),
      online,
      labels,
      exit: () => {
        this.leaveGame();
      },
    });

    if (!launched.ok) {
      this.error = launched.error.message;
      this.activeOnline = online;
      this.leaveGame();
      return;
    }
    this.activeGame = launched.value;
    this.activeOnline = online;

    // If the other player closes the room, don't leave someone fighting a
    // ghost — the game's own link listener also notices, but the room
    // document is the authoritative "this is over".
    if (online) {
      this.watchingMatch = this.deps.lobby.observe(online.match, (updated) => {
        if (updated === null || updated.status === 'abandoned') {
          this.deps.logger.log('info', 'the room closed while a game was running');
        }
      });
    }
  }

  /**
   * Stops whatever is running and gives the screen back to the store.
   *
   * Separate from `leaveGame` because signing out has to do exactly this and
   * nothing else: there is no longer a session to close a room with, and
   * leaving the shell hidden would strand the player looking at a game with
   * no way out of it.
   */
  private closeActiveGame(): void {
    if (!this.activeGame) return;
    this.activeGame.stop();
    this.activeGame = null;
    this.watchingMatch?.();
    this.watchingMatch = null;
    // Every link, not one: the host holds one per guest.
    for (const link of this.activeOnline?.links.values() ?? []) link.close();

    clear(this.gameMount);
    this.gameMount.hidden = true;
    this.shell.hidden = false;
  }

  /** The player asked to leave: tear down, close the room, back to the shelf. */
  private leaveGame(): void {
    const online = this.activeOnline;
    const session = this.session;
    this.closeActiveGame();
    this.activeOnline = null;

    if (online && session) {
      void this.deps.lobby.leave({ session, match: online.match });
    }

    this.deps.audio.startMusic('menu');
    this.go({ kind: 'store' });
  }

  private labelsFor(
    game: GameDefinition,
    online: OnlineSession | null,
  ): { self: string; opponent: string } {
    if (!online) {
      const me = this.session ? displayNameFor(this.session.player) : 'You';
      return {
        self: me.toUpperCase(),
        // Solo faces the game's own opponent, named by the catalogue.
        opponent: (game.soloOpponent ?? 'PLAYER 2').toUpperCase(),
      };
    }
    const mine = seatAt(online.match, online.seat);
    const others = opponentsOf(online.match, online.seat)
      .map((seat) => seatAt(online.match, seat)?.displayName)
      .filter((name): name is string => Boolean(name));
    return {
      self: (mine?.displayName ?? 'You').toUpperCase(),
      // The first rival by seat. These two labels go on a pair of health bars,
      // so a roomful of four has nowhere to put the other names — the games
      // that seat four draw their own gauges per car instead.
      opponent: (others[0] ?? 'Rival').toUpperCase(),
    };
  }

  private cancelRoom(match: Match): void {
    this.pairing?.cancel();
    this.pairing = null;
    const session = this.session;
    if (session) void this.deps.lobby.leave({ session, match });
    this.deps.audio.play('ui-back');
    this.go({ kind: 'store' });
  }

  // ----------------------------------------------------------------- admin

  private async openAdmin(): Promise<void> {
    this.go({ kind: 'admin' });
    await this.loadGrants();
  }

  private async loadGrants(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.grantsLoading = true;
    this.adminNote = null;
    this.render();

    const result = await this.deps.access.list(session);
    this.grantsLoading = false;
    if (result.ok) {
      this.grants = result.value;
      this.error = null;
    } else {
      this.error = result.error.message;
    }
    this.render();
  }

  private async invite(input: { email: string; role: Role; note: string | null }): Promise<void> {
    const session = this.session;
    if (!session) return;
    const result = await this.deps.access.invite(session, input);
    if (result.ok) {
      this.adminNote = `${result.value.email} can now sign in.`;
      this.deps.audio.play('ui-confirm');
      await this.loadGrants();
    } else {
      this.error = result.error.message;
      this.deps.audio.play('ui-error');
      this.render();
    }
  }

  private async revoke(email: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const result = await this.deps.access.revoke(session, email);
    if (result.ok) {
      this.adminNote = `${email} can no longer sign in.`;
      await this.loadGrants();
    } else {
      this.error = result.error.message;
      this.deps.audio.play('ui-error');
      this.render();
    }
  }

  // ---------------------------------------------------------------- render

  private go(view: View): void {
    this.view = view;
    this.shareNote = null;
    this.render();
  }

  private render(): void {
    if (this.view.kind === 'playing') return;
    this.renderHeader();
    clear(this.main);
    this.main.append(this.renderView());
  }

  private renderView(): HTMLElement {
    switch (this.view.kind) {
      case 'loading':
        return el('section', { className: 'hero' }, [
          el('p', { className: 'muted', text: 'Opening the arcade…' }),
        ]);

      case 'sign-in':
        return renderSignIn({
          onSignIn: () => {
            void this.signIn();
          },
          busy: this.busy,
          error: this.error,
          cloudConfigured: this.deps.cloudConfigured,
          missingSettings: this.deps.missingSettings,
        });

      case 'store':
        return renderStore({
          games: this.deps.catalog.all(),
          tags: this.deps.catalog.tags(),
          activeTag: this.activeTag,
          onFilter: (tag) => {
            this.activeTag = tag;
            this.deps.audio.play('ui-move');
            this.render();
          },
          onOpen: (game) => {
            this.deps.audio.play('ui-confirm');
            this.error = null;
            this.go({ kind: 'game', game });
          },
        });

      case 'game': {
        const { game } = this.view;
        return renderGame({
          game,
          busy: this.playMode,
          error: this.error,
          onlineAvailable: this.deps.cloudConfigured,
          onlineReason: this.deps.cloudConfigured ? null : ONLINE_UNAVAILABLE,
          initialCode: this.pendingCode ?? '',
          onPlay: (mode) => {
            void this.play(game, mode);
          },
          onJoin: (code) => {
            void this.joinByCode(code);
          },
          onBack: () => {
            this.deps.audio.play('ui-back');
            this.go({ kind: 'store' });
          },
        });
      }

      case 'lobby': {
        const { game, match, roster, capacity, canStart, note, failed, isHost } = this.view;
        return renderLobby({
          game,
          match,
          roster,
          capacity,
          canStart,
          note,
          failed,
          isHost,
          shareNote: this.shareNote,
          inviteUrl: this.deps.lobby.inviteUrl(match, new URL(window.location.href)),
          onShare: () => {
            void this.shareInvite(match);
          },
          onCopy: () => {
            void this.copyInvite(match);
          },
          onStart: () => {
            this.deps.audio.play('ui-confirm');
            this.pairing?.start();
          },
          onCancel: () => {
            this.cancelRoom(match);
          },
        });
      }

      case 'joining': {
        const { code, message, failed } = this.view;
        return renderJoining({
          code,
          message,
          failed,
          onBack: () => {
            this.deps.audio.play('ui-back');
            this.go({ kind: 'store' });
          },
        });
      }

      case 'playing':
        // `render` bails out before reaching here while a game is mounted;
        // this case exists so the switch stays exhaustive and the compiler
        // keeps checking it.
        return el('section');

      case 'admin':
        return renderAdmin({
          grants: this.grants,
          loading: this.grantsLoading,
          error: this.error,
          note: this.adminNote,
          ownEmail: this.session?.player.email ? normaliseEmail(this.session.player.email) : null,
          onInvite: (input) => {
            void this.invite(input);
          },
          onRevoke: (email) => {
            void this.revoke(email);
          },
          onRefresh: () => {
            void this.loadGrants();
          },
          onBack: () => {
            this.deps.audio.play('ui-back');
            this.go({ kind: 'store' });
          },
        });
    }
  }

  /** The explicit "copy" button, which must not open a share sheet. */
  private async copyInvite(match: Match): Promise<void> {
    const url = this.deps.lobby.inviteUrl(match, new URL(window.location.href));
    const copied = await this.deps.share.copy(url);
    this.shareNote = copied
      ? 'Link copied to your clipboard.'
      : 'Could not copy automatically — the link is below.';
    this.render();
  }

  private async shareInvite(match: Match): Promise<void> {
    const outcome = await this.deps.lobby.shareInvite(match, new URL(window.location.href));
    this.shareNote =
      outcome === 'shared'
        ? 'Sent.'
        : outcome === 'copied'
          ? 'Link copied to your clipboard.'
          : 'Could not share automatically — copy the link below.';
    this.render();
  }

  private renderHeader(): void {
    clear(this.header);
    const brand = el('div', { className: 'topbar__brand' }, [
      el('span', { className: 'topbar__mark', text: '▲' }),
      el('span', { text: 'Arcade' }),
    ]);

    const actions: HTMLElement[] = [
      button({
        // Labelled by the action, not the state: "Sound off" next to a
        // muted app reads as a instruction that has already been followed.
        label: this.deps.audio.muted ? 'Unmute' : 'Mute',
        tone: 'ghost',
        onClick: () => {
          this.deps.audio.setMuted(!this.deps.audio.muted);
          this.render();
        },
      }),
    ];

    if (canFullscreen()) {
      actions.push(
        button({
          label: isFullscreen() ? 'Exit full screen' : 'Full screen',
          tone: 'ghost',
          onClick: () => {
            toggleFullscreen();
          },
        }),
      );
    }

    if (this.installPrompt) {
      // Only ever shown when the browser has actually offered to install:
      // Chrome fires `beforeinstallprompt` when the app qualifies and is not
      // already installed, so this button cannot appear where it would do
      // nothing.
      actions.push(
        button({
          label: 'Install app',
          onClick: () => {
            void this.install();
          },
        }),
      );
    }

    const session = this.session;
    // Signed in, not "signed in and granted". This read `session?.grant`
    // while the arcade was invitation only, when the two were the same thing.
    // They are not any more: almost nobody has a grant now, and gating on one
    // left every ordinary player with no name in the header and — worse — no
    // way to sign out.
    if (session) {
      if (canAdminister(session)) {
        actions.unshift(
          button({
            label: 'Admins',
            tone: 'ghost',
            onClick: () => {
              void this.openAdmin();
            },
          }),
        );
      }
      const name = displayNameFor(session.player);
      actions.push(
        el('div', { className: 'topbar__who' }, [
          avatar({ url: session.player.avatarUrl, initials: initialsFor(name), label: name }),
          el('span', { className: 'topbar__name', text: name }),
        ]),
        button({
          label: 'Sign out',
          tone: 'ghost',
          onClick: () => {
            void this.deps.session.signOut();
          },
        }),
      );
    }

    this.header.append(brand, el('div', { className: 'topbar__actions' }, actions));
  }

  /**
   * Accepts the browser's offer to install.
   *
   * The event has to be kept from when it fired — `prompt()` may only be
   * called on the saved event, and only once — so it is dropped afterwards
   * either way. If the player dismisses the dialogue the browser will offer
   * again on a later visit and fire a fresh event.
   */
  private async install(): Promise<void> {
    const offer = this.installPrompt;
    if (!offer) return;
    this.installPrompt = null;
    this.render();
    try {
      await offer.prompt();
    } catch {
      /* dismissed, or already installed in another tab */
    }
  }

  /** Takes the invite code out of the address bar once it has been used. */
  private clearCodeFromUrl(): void {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('join') && !url.searchParams.has('room')) return;
    url.searchParams.delete('join');
    url.searchParams.delete('room');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
}

/**
 * Chrome's install offer.
 *
 * `beforeinstallprompt` is not in the DOM typings — it is not a standard —
 * so this is the shape actually used, declared once rather than cast at the
 * point of use.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}
