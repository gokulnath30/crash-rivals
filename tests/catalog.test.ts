import { describe, expect, it } from 'vitest';
import { isOnline, supportsMode } from '@domain/catalog/game-definition.ts';
import { GAME_IDS, StaticGameCatalog } from '@adapters/catalog/static-catalog.adapter.ts';

/**
 * The shelf.
 *
 * Mostly a guard on the promises a tile makes: a game that advertises invite
 * links has to be able to honour them, and one that advertises none should not
 * be showing the button.
 */
const catalog = new StaticGameCatalog();

describe('the catalogue', () => {
  it('lists every game with a unique id', () => {
    const ids = catalog.all().map((game) => game.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every game at least one way to play', () => {
    for (const game of catalog.all()) expect(game.modes.length).toBeGreaterThan(0);
  });

  it('declares a network requirement exactly when it offers invite links', () => {
    // The store greys out online play from `modes`, but the tile's
    // requirement pills come from `requirements` — they have to agree.
    for (const game of catalog.all()) {
      expect(game.requirements.includes('network')).toBe(isOnline(game));
    }
  });

  it('names a solo opponent exactly when it has a solo mode with one', () => {
    for (const game of catalog.all()) {
      if (game.soloOpponent !== null) expect(supportsMode(game, 'solo')).toBe(true);
    }
  });

  describe('Ashen Ring', () => {
    const ring = catalog.find(GAME_IDS.ashenRing);

    it('is on the shelf and offers solo play', () => {
      expect(ring).not.toBeNull();
      expect(ring?.modes).toEqual(['solo']);
    });

    it('names its machine opponent and needs no camera or network', () => {
      expect(ring?.soloOpponent).not.toBeNull();
      expect(ring?.requirements).not.toContain('camera');
      expect(ring?.requirements).not.toContain('network');
    });
  });
});
