import type { GameId } from '../shared/ids.ts';

/**
 * How a game can be played. The store shows a button per mode a game
 * declares, so adding a mode to a game is a one-line change here rather
 * than a change to the store's UI.
 *
 * There used to be a `local-versus` here — two players sharing one keyboard
 * and a split screen. It is gone: splitting a display between two people gave
 * each of them a worse view than either game deserved, and with rooms holding
 * up to four the interesting versus mode is the one played over the network.
 * Its replacement is `solo`, which now fills the other seats with machines.
 */
export type GameMode = 'solo' | 'online-versus';

/** Hardware or permissions a game cannot run without. */
export type GameRequirement = 'webgl' | 'camera' | 'keyboard' | 'network';

export interface GameArt {
  /** CSS colours: the first two seats' liveries, used for the tile. */
  readonly accent: string;
  readonly accentAlt: string;
  /** A CSS background value used for the shelf tile. */
  readonly poster: string;
}

/**
 * A game as the store knows it: enough to draw a tile and open a lobby, and
 * nothing about how the game is implemented. The runtime that actually plays
 * it is resolved separately, through `GameRegistryPort`.
 */
export interface GameDefinition {
  readonly id: GameId;
  readonly title: string;
  /** One line on the tile. */
  readonly tagline: string;
  /** A paragraph on the lobby screen. */
  readonly blurb: string;
  readonly tags: readonly string[];
  readonly modes: readonly GameMode[];
  /**
   * How many can play one match of this game.
   *
   * Per game rather than one constant for the store, because the answer really
   * does differ: Crash Rivals puts four cars on a road, while Ashen Ring is a
   * duel and a third fighter in the ring would be a redesign of the fight, not
   * a wider room.
   */
  readonly seats: number;
  readonly requirements: readonly GameRequirement[];
  readonly howToPlay: readonly string[];
  /** Who you fight in solo mode, if the game has one. */
  readonly soloOpponent: string | null;
  readonly art: GameArt;
  readonly status: 'playable' | 'coming-soon';
}

export const supportsMode = (game: GameDefinition, mode: GameMode): boolean =>
  game.modes.includes(mode);

export const needs = (game: GameDefinition, requirement: GameRequirement): boolean =>
  game.requirements.includes(requirement);

export const isOnline = (game: GameDefinition): boolean => supportsMode(game, 'online-versus');

export const MODE_LABELS: Readonly<Record<GameMode, string>> = {
  solo: 'Solo vs the machine',
  'online-versus': 'Invite a friend',
};

/**
 * The button on a game's page.
 *
 * Takes the game rather than only the mode, because "invite a friend" is
 * right for a duel and wrong for a four-car race — and the difference is
 * exactly the number of seats the game declares.
 */
export function modeLabel(game: GameDefinition, mode: GameMode): string {
  if (mode === 'online-versus' && game.seats > 2) return 'Invite friends';
  return MODE_LABELS[mode];
}

/** How many seats a room for this game should open with. */
export const seatsOf = (game: GameDefinition): number => game.seats;
