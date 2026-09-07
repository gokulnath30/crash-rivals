import { beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@domain/identity/session.ts';
import { MATCH_STALE_AFTER_MS, hostOf } from '@domain/lobby/match.ts';
import { asGameId, asPlayerId } from '@domain/shared/ids.ts';
import { LobbyService } from '@app/usecases/lobby.usecase.ts';
import {
  FakeCatalog,
  FakeClock,
  FakeMatchRepository,
  FakeShare,
  SilentLogger,
  TEST_GAME,
  testPlayer,
  sequentialRandom,
} from './support/fakes.ts';

/**
 * The lobby, driven entirely through fake ports.
 *
 * No Firestore, no emulator, no network — which is the point of the ports: the
 * room lifecycle is ordinary code and can be tested like ordinary code.
 */
describe('the lobby', () => {
  let matches: FakeMatchRepository;
  let clock: FakeClock;
  let share: FakeShare;
  let lobby: LobbyService;

  const invited: Session = {
    player: testPlayer(),
    grant: { email: 'ada@example.com', role: 'player', note: null, grantedAt: 0 },
  };
  /* Signed in, on no list, and their own person — sharing an id with the host
     would trip the "you created this room" rule rather than the access one. */
  const uninvited: Session = {
    player: testPlayer({ id: asPlayerId('player-3'), displayName: 'Ines', email: 'ines@example.com' }),
    grant: null,
  };
  const friend: Session = {
    player: testPlayer({ id: asPlayerId('player-2'), displayName: 'Grace', email: 'grace@example.com' }),
    grant: { email: 'grace@example.com', role: 'player', note: null, grantedAt: 0 },
  };

  beforeEach(() => {
    matches = new FakeMatchRepository();
    clock = new FakeClock();
    share = new FakeShare();
    lobby = new LobbyService(matches, new FakeCatalog(), clock, share, new SilentLogger(), () => 0);
  });

  describe('hosting', () => {
    it('opens a room for a game on the shelf', async () => {
      const result = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe('open');
      expect(hostOf(result.value).displayName).toBe('Ada');
      expect(matches.rooms.size).toBe(1);
    });

    it('opens a room for anyone signed in, on no list at all', async () => {
      // The arcade is no longer invitation only: signing in with Google is the
      // whole entry requirement, so a player with no grant hosts like any
      // other. This used to be the test that they were turned away.
      const result = await lobby.host({ session: uninvited, gameId: TEST_GAME.id });
      expect(result.ok).toBe(true);
      expect(matches.rooms.size).toBe(1);
    });

    it('refuses a game that is not on the shelf', async () => {
      const result = await lobby.host({ session: invited, gameId: asGameId('not-a-game') });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('game-not-found');
    });

    it('rolls a different code when the first one collides', async () => {
      // Both hosts would generate '0000' with this generator, so the second
      // has to notice and try again.
      const first = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      expect(first.ok && first.value.code).toBe('0000');

      // The second attempt walks to a different code.
      const rolling = new LobbyService(
        matches,
        new FakeCatalog(),
        clock,
        share,
        new SilentLogger(),
        sequentialRandom([0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5]),
      );
      const second = await rolling.host({ session: friend, gameId: TEST_GAME.id });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.code).not.toBe('0000');
      expect(matches.rooms.size).toBe(2);
    });

    it('gives up rather than looping forever when every code collides', async () => {
      await lobby.host({ session: invited, gameId: TEST_GAME.id });
      // This generator can only ever produce '0000', which is already taken.
      const stuck = await lobby.host({ session: friend, gameId: TEST_GAME.id });
      expect(stuck.ok).toBe(false);
      if (!stuck.ok) expect(stuck.error.code).toBe('code-taken');
    });

    it('surfaces a database failure instead of retrying it', async () => {
      matches.failNextWrite = 'the database is on fire';
      const result = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('on fire');
      // One attempt, not five: only a code collision is worth another roll,
      // and a database that is down stays down.
      expect(matches.rooms.size).toBe(0);
    });
  });

  describe('joining', () => {
    it('seats the friend and marks the room ready', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');

      const joined = await lobby.join({ session: friend, code: hosted.value.code });
      expect(joined.ok).toBe(true);
      if (!joined.ok) return;
      expect(joined.value.status).toBe('ready');
      expect(joined.value.seats[1]?.displayName).toBe('Grace');
    });

    it('accepts a code typed with the wrong lookalike characters', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');
      expect(hosted.value.code).toBe('0000');

      // Someone reads "0000" out and their friend types the letter O.
      const joined = await lobby.join({ session: friend, code: 'oOoO' });
      expect(joined.ok).toBe(true);
    });

    it('reports a code that no room is using', async () => {
      const result = await lobby.join({ session: friend, code: 'ZZZZ' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('match-not-found');
    });

    it('rejects a code that is not a code at all', async () => {
      const result = await lobby.join({ session: friend, code: 'no' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid-invite-code');
    });

    it('seats anyone signed in, on no list at all', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');
      const result = await lobby.join({ session: uninvited, code: hosted.value.code });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.seats[1]?.playerId).toBe(uninvited.player.id);
    });

    it('lets the seated guest re-join without a second write', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');
      await lobby.join({ session: friend, code: hosted.value.code });

      // A reload looks exactly like a second join, so it must be free and safe.
      matches.failNextWrite = 'this write should never happen';
      const again = await lobby.join({ session: friend, code: hosted.value.code });
      expect(again.ok).toBe(true);
      expect(matches.failNextWrite).toBe('this write should never happen');
    });

    it('refuses a room whose host walked away long ago', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');

      clock.advance(MATCH_STALE_AFTER_MS + 1000);
      const result = await lobby.join({ session: friend, code: hosted.value.code });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('match-abandoned');
    });
  });

  describe('invite links', () => {
    it('builds a link that carries the code', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');

      const url = lobby.inviteUrl(hosted.value, new URL('https://example.com/arcade/'));
      expect(url).toBe('https://example.com/arcade/?join=0000');
    });

    it('drops any fragment already on the page address', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');

      const url = lobby.inviteUrl(hosted.value, new URL('https://example.com/a/#somewhere'));
      expect(url).not.toContain('#');
    });

    it('reads a code back out of a link', () => {
      const code = LobbyService.codeFromUrl(new URL('https://example.com/?join=7K2M'));
      expect(code).toBe('7K2M');
    });

    it('still understands the old ?room= links', () => {
      // Crash Rivals shipped with ?room= before the store existed.
      expect(LobbyService.codeFromUrl(new URL('https://example.com/?room=7K2M'))).toBe('7K2M');
    });

    it('returns null when there is no code to find', () => {
      expect(LobbyService.codeFromUrl(new URL('https://example.com/'))).toBeNull();
      // Too few usable characters to be a code, once the punctuation is out.
      expect(LobbyService.codeFromUrl(new URL('https://example.com/?join=a-b'))).toBeNull();
    });

    it('salvages a code from a link with extra characters around it', () => {
      // "nonsense" folds down to four alphabet characters, so it is a code —
      // which is a consequence of being forgiving about what people paste.
      expect(LobbyService.codeFromUrl(new URL('https://example.com/?join=nonsense'))).toBe('N0NS');
    });

    it('hands the share sheet a link and a title', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');

      const outcome = await lobby.shareInvite(hosted.value, new URL('https://example.com/'));
      expect(outcome).toBe('shared');
      expect(share.shared[0]?.title).toBe('Test Game');
      expect(share.shared[0]?.url).toContain('join=0000');
    });
  });

  describe('leaving', () => {
    it('closes a room so its code stops working', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');

      const left = await lobby.leave({ session: invited, match: hosted.value });
      expect(left.ok && left.value.status).toBe('abandoned');

      const join = await lobby.join({ session: friend, code: hosted.value.code });
      expect(join.ok).toBe(false);
      if (!join.ok) expect(join.error.code).toBe('match-abandoned');
    });

    it('lets a closed code be reused by a new room', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');
      await lobby.leave({ session: invited, match: hosted.value });

      // Otherwise every abandoned lobby would burn a code forever.
      const again = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      expect(again.ok && again.value.code).toBe('0000');
      expect(again.ok && again.value.status).toBe('open');
    });
  });

  describe('watching a room', () => {
    it('reports the guest arriving from the other browser', async () => {
      const hosted = await lobby.host({ session: invited, gameId: TEST_GAME.id });
      if (!hosted.ok) throw new Error('setup failed');

      const seen: (string | null)[] = [];
      const stop = lobby.observe(hosted.value, (match) => {
        seen.push(match?.status ?? null);
      });

      await lobby.join({ session: friend, code: hosted.value.code });
      stop();

      expect(seen[0]).toBe('open');
      expect(seen.at(-1)).toBe('ready');
    });
  });
});
