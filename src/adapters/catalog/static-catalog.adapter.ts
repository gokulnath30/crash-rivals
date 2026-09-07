import type { GameDefinition } from '@domain/catalog/game-definition.ts';
import { asGameId } from '@domain/shared/ids.ts';
import type { GameCatalogPort } from '@app/ports/game-catalog.port.ts';

/**
 * The shelf.
 *
 * Adding a game means adding an entry here and a matching case in
 * `GameRegistry.load` — the store's UI, lobby, invite flow and audio all come
 * along for free. This is the payoff for keeping the store ignorant of what a
 * game actually is.
 */
export const GAME_IDS = {
  crashRivals: asGameId('crash-rivals'),
  ashenRing: asGameId('ashen-ring'),
} as const;

const GAMES: readonly GameDefinition[] = [
  {
    id: GAME_IDS.ashenRing,
    title: 'Ashen Ring',
    tagline: 'Two fighters, one ring of fire.',
    blurb:
      'A side-on 3D fighting game in the classic shape: two realistic fighters on a raised ' +
      'stone ring, a cinematic camera that breathes with the distance between them, and best ' +
      'of three rounds. Walk, run, jump, punch, kick, sweep, uppercut and guard on a keyboard, ' +
      'a gamepad or your thumbs. Fight VARRA, or put a friend on the arrow keys or a second ' +
      'pad and settle it on one screen.',
    tags: ['fighting', 'duel'],
    modes: ['solo'],
    /* A duel. The second seat is the machine, or a friend on the same keyboard. */
    seats: 2,
    requirements: ['webgl'],
    howToPlay: [
      'Keyboard: A and D walk, W jumps, hold S to guard. Tap forward twice, or hold Shift, to run.',
      'J punches, K kicks (in the air, a flying kick), L sweeps low under a jump, U is the uppercut that catches a jumper.',
      'Gamepad: stick or ◀ ▶ to move, ▲ to jump, bumpers to guard. X/□ punch, Y/△ uppercut, A/✕ kick, B/○ sweep.',
      'Phone or tablet: turn it sideways. The left thumb moves (up jumps, down guards); the right thumb has the four limbs and guard.',
      'A guarded blow does a fifth of its damage. Nothing can be guarded in the air.',
      'A second player takes the arrow keys with , . / M, or a second gamepad.',
      'Knock them down or have more health when the clock runs out. Two rounds wins.',
    ],
    soloOpponent: 'VARRA',
    art: {
      accent: '#ff6a2a',
      accentAlt: '#58c9ff',
      poster:
        'radial-gradient(120% 90% at 20% 15%, rgba(255,106,42,.55), transparent 60%),' +
        'radial-gradient(100% 80% at 85% 35%, rgba(88,201,255,.4), transparent 60%),' +
        'linear-gradient(160deg, #2a160c, #0a0806)',
    },
    status: 'playable',
  },
  {
    id: GAME_IDS.crashRivals,
    title: 'Crash Rivals',
    tagline: 'Four cars, one straight road, no rules worth mentioning.',
    blurb:
      'A 2.6 kilometre drag strip with up to three rivals on it. Cross the line first, ' +
      'or wreck them three times each and take it by knockout. Ramming hurts you both — ' +
      'but it hurts the one who got hit far more, so come at them from behind or from ' +
      'the side. Grab the yellow pads for a burst of speed. Race the machines, or send a ' +
      'link and fill the grid with friends from opposite ends of the country.',
    tags: ['racing', 'four-player', 'boost'],
    modes: ['solo', 'online-versus'],
    seats: 4,
    requirements: ['webgl', 'keyboard', 'network'],
    howToPlay: [
      'Drive with W A S D or the arrow keys — either cluster steers your car.',
      'Space or right shift pulls the handbrake.',
      'On a phone you get a touch pad instead.',
      'Yellow pads on the road give you a few seconds of extra top speed.',
      'Damage above 100% wrecks the car and costs you a life. Three wrecks and you are out.',
      'Any empty seat in the room is driven by a machine.',
    ],
    soloOpponent: 'three machines',
    art: {
      accent: '#d94a2b',
      accentAlt: '#f5c542',
      poster:
        'radial-gradient(120% 90% at 15% 15%, rgba(217,74,43,.5), transparent 60%),' +
        'radial-gradient(100% 80% at 90% 40%, rgba(245,197,66,.35), transparent 60%),' +
        'linear-gradient(160deg, #2a1a14, #101114)',
    },
    status: 'playable',
  },
];

/**
 * Synchronous by design: the catalogue is part of the bundle, so the store
 * paints instantly instead of spinning over a list that was never going to
 * change between deploys.
 */
export class StaticGameCatalog implements GameCatalogPort {
  all(): readonly GameDefinition[] {
    return GAMES;
  }

  find(id: string): GameDefinition | null {
    return GAMES.find((game) => game.id === id) ?? null;
  }

  byTag(tag: string): readonly GameDefinition[] {
    return GAMES.filter((game) => game.tags.includes(tag));
  }

  tags(): readonly string[] {
    return [...new Set(GAMES.flatMap((game) => game.tags))].sort();
  }
}
