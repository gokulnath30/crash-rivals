import type { GameDefinition } from '@domain/catalog/game-definition.ts';
import type { AccessGrant, Player, Role } from '@domain/identity/player.ts';
import { normaliseEmail } from '@domain/identity/player.ts';
import type { InviteCode } from '@domain/lobby/invite-code.ts';
import type { Match } from '@domain/lobby/match.ts';
import { asGameId, asPlayerId, type GameId, type MatchId } from '@domain/shared/ids.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { AccessDirectoryPort } from '@app/ports/access-directory.port.ts';
import type { AudioPort, MusicTrack, SoundCue } from '@app/ports/audio.port.ts';
import type { AuthPort } from '@app/ports/auth.port.ts';
import type { ClockPort } from '@app/ports/clock.port.ts';
import type { GameCatalogPort } from '@app/ports/game-catalog.port.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import type { MatchRepositoryPort } from '@app/ports/match-repository.port.ts';
import type { SharePort, ShareOutcome } from '@app/ports/share.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';

/**
 * In-memory stand-ins for every port a use case needs.
 *
 * These exist to make a point as much as to support the tests: `LobbyService`
 * has no idea Firestore exists, so the whole of the room lifecycle — codes,
 * collisions, seats, expiry — can be exercised in a few milliseconds with no
 * emulator, no network and no mocking library.
 */

export const TEST_GAME: GameDefinition = {
  id: asGameId('test-game'),
  title: 'Test Game',
  tagline: 'For the tests.',
  blurb: 'A game that exists only in this file.',
  tags: ['test'],
  modes: ['solo', 'online-versus'],
  seats: 2,
  requirements: ['webgl'],
  howToPlay: ['Press the thing.'],
  soloOpponent: 'ROBOT',
  art: { accent: '#fff', accentAlt: '#000', poster: 'none' },
  status: 'playable',
};

export class FakeCatalog implements GameCatalogPort {
  constructor(private readonly games: readonly GameDefinition[] = [TEST_GAME]) {}

  all(): readonly GameDefinition[] {
    return this.games;
  }

  find(id: GameId): GameDefinition | null {
    return this.games.find((game) => game.id === id) ?? null;
  }

  byTag(tag: string): readonly GameDefinition[] {
    return this.games.filter((game) => game.tags.includes(tag));
  }

  tags(): readonly string[] {
    return [...new Set(this.games.flatMap((game) => game.tags))];
  }
}

/** A clock the test drives by hand. */
export class FakeClock implements ClockPort {
  constructor(private current = 1_700_000_000_000) {}

  now(): number {
    return this.current;
  }

  elapsed(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export class SilentLogger implements LoggerPort {
  readonly lines: { level: string; message: string }[] = [];

  log(level: string, message: string): void {
    this.lines.push({ level, message });
  }

  scoped(): LoggerPort {
    return this;
  }
}

export class FakeShare implements SharePort {
  readonly shared: { title: string; text: string; url: string }[] = [];
  outcome: ShareOutcome = 'shared';

  async share(invite: { title: string; text: string; url: string }): Promise<ShareOutcome> {
    this.shared.push(invite);
    return this.outcome;
  }

  readonly copied: string[] = [];
  canCopy = true;

  async copy(text: string): Promise<boolean> {
    if (!this.canCopy) return false;
    this.copied.push(text);
    return true;
  }
}

/**
 * Rooms in a Map, honouring the one contract that matters: `create` refuses a
 * code that is already held by a live room, and takes over one that is not.
 */
export class FakeMatchRepository implements MatchRepositoryPort {
  readonly rooms = new Map<string, Match>();
  /** Set to make the next write fail, for testing the unhappy path. */
  failNextWrite: string | null = null;
  private readonly watchers = new Map<string, Set<Listener<Match | null>>>();

  async create(match: Match): Promise<Result<Match>> {
    const existing = this.rooms.get(match.code);
    const reusable =
      !existing || existing.status === 'abandoned' || existing.status === 'finished';
    if (!reusable) return fail(failure('code-taken', 'That room code is in use.'));
    return this.write(match);
  }

  async find(id: MatchId): Promise<Result<Match | null>> {
    return ok(this.rooms.get(id) ?? null);
  }

  async findByCode(code: InviteCode): Promise<Result<Match | null>> {
    return ok(this.rooms.get(code) ?? null);
  }

  async save(match: Match): Promise<Result<Match>> {
    return this.write(match);
  }

  observe(id: MatchId, listener: Listener<Match | null>): Unsubscribe {
    const set = this.watchers.get(id) ?? new Set();
    this.watchers.set(id, set);
    set.add(listener);
    listener(this.rooms.get(id) ?? null);
    return () => set.delete(listener);
  }

  /** Simulates the other player's browser changing the room. */
  push(match: Match): void {
    this.rooms.set(match.code, match);
    for (const listener of this.watchers.get(match.id) ?? []) listener(match);
  }

  private write(match: Match): Result<Match> {
    if (this.failNextWrite) {
      const message = this.failNextWrite;
      this.failNextWrite = null;
      return fail(failure('unavailable', message));
    }
    this.rooms.set(match.code, match);
    for (const listener of this.watchers.get(match.id) ?? []) listener(match);
    return ok(match);
  }
}

export class FakeAuth implements AuthPort {
  private player: Player | null = null;
  private readonly listeners = new Set<Listener<Player | null>>();
  /** Set to make the next sign-in fail. */
  failWith: 'cancelled' | 'error' | null = null;

  constructor(private readonly nextPlayer: Player = testPlayer()) {}

  current(): Player | null {
    return this.player;
  }

  observe(listener: Listener<Player | null>): Unsubscribe {
    this.listeners.add(listener);
    listener(this.player);
    return () => this.listeners.delete(listener);
  }

  async ready(): Promise<void> {
    /* nothing to restore */
  }

  async signInWithGoogle(): Promise<Result<Player>> {
    if (this.failWith) {
      const reason = this.failWith;
      this.failWith = null;
      return reason === 'cancelled'
        ? fail(failure('sign-in-cancelled', 'Sign-in was cancelled.'))
        : fail(failure('sign-in-failed', 'Something went wrong.'));
    }
    this.emit(this.nextPlayer);
    return ok(this.nextPlayer);
  }

  async signOut(): Promise<void> {
    this.emit(null);
  }

  private emit(player: Player | null): void {
    this.player = player;
    for (const listener of this.listeners) listener(player);
  }
}

export class FakeAccessDirectory implements AccessDirectoryPort {
  readonly grants = new Map<string, AccessGrant>();
  /** Set to simulate an unreachable directory. */
  unreachable = false;

  async find(email: string): Promise<Result<AccessGrant | null>> {
    if (this.unreachable) return fail(failure('unavailable', 'The directory is unreachable.'));
    return ok(this.grants.get(normaliseEmail(email)) ?? null);
  }

  async list(): Promise<Result<readonly AccessGrant[]>> {
    if (this.unreachable) return fail(failure('unavailable', 'The directory is unreachable.'));
    return ok([...this.grants.values()]);
  }

  async grant(input: { email: string; role: Role; note: string | null }): Promise<Result<AccessGrant>> {
    const entry: AccessGrant = {
      email: normaliseEmail(input.email),
      role: input.role,
      note: input.note,
      grantedAt: 0,
    };
    this.grants.set(entry.email, entry);
    return ok(entry);
  }

  async revoke(email: string): Promise<Result<void>> {
    this.grants.delete(normaliseEmail(email));
    return ok(undefined);
  }

  /** Convenience for arranging a test. */
  allow(email: string, role: Role = 'player'): void {
    this.grants.set(normaliseEmail(email), {
      email: normaliseEmail(email),
      role,
      note: null,
      grantedAt: 0,
    });
  }
}

/**
 * An `AudioPort` whose mute actually toggles.
 *
 * `SilentAudioAdapter` is permanently muted by design, which makes it useless
 * for testing anything about the mute control itself.
 */
export class FakeAudio implements AudioPort {
  muted = false;
  unlocked = false;
  readonly played: SoundCue[] = [];
  music: MusicTrack | null = null;

  async unlock(): Promise<void> {
    this.unlocked = true;
  }

  play(cue: SoundCue): void {
    this.played.push(cue);
  }

  startMusic(track: MusicTrack): void {
    this.music = track;
  }

  stopMusic(): void {
    this.music = null;
  }

  duck(): void {
    /* nothing to duck */
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  dispose(): void {
    this.played.length = 0;
  }
}

export function testPlayer(overrides: Partial<Player> = {}): Player {
  return {
    id: asPlayerId('player-1'),
    displayName: 'Ada',
    email: 'ada@example.com',
    avatarUrl: null,
    ...overrides,
  };
}

/**
 * A generator that walks the alphabet, so tests can predict the codes and
 * force a collision on purpose.
 */
export function sequentialRandom(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length] ?? 0;
    index += 1;
    return value;
  };
}
