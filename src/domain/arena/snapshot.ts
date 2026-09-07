import type { Stance } from './brawler.ts';
import type { Fight } from './fight.ts';
import type { RoundPhase } from './round.ts';

/**
 * The fight as one player can tell another about it.
 *
 * An online match is host-authoritative: seat 0 runs the only copy of the
 * rules that counts, and the other browser is shown this. So a snapshot has
 * to carry everything the far end needs to *draw* a moment — not to decide
 * one — which is where the bodies are, what they are doing and how far
 * through it they are, plus the scoreboard.
 *
 * Deliberately plain data: the netcode encodes it, the domain produces and
 * adopts it, and neither knows the other exists.
 */
export interface BrawlerState {
  readonly x: number;
  readonly y: number;
  readonly facing: 1 | -1;
  readonly stance: Stance;
  /** Seconds into the stance, so an animation resumes where it really is. */
  readonly stanceTime: number;
  readonly stride: -1 | 0 | 1;
  readonly hp: number;
  /**
   * How fast the body is travelling, so the far end can carry it between
   * snapshots instead of teleporting it thirty times a second.
   */
  readonly velocity: number;
  readonly verticalVelocity: number;
}

export interface FightState {
  readonly round: number;
  readonly phase: RoundPhase;
  readonly timeLeft: number;
  readonly wins: readonly [number, number];
  readonly brawlers: readonly [BrawlerState, BrawlerState];
}

/**
 * Every stance, in a fixed order.
 *
 * The order is the wire format: an index into this list is what crosses the
 * connection, so entries may be appended but never reordered or removed.
 */
export const STANCES: readonly Stance[] = [
  'idle',
  'walk',
  'run',
  'guard',
  'jump',
  'punch',
  'kick',
  'sweep',
  'uppercut',
  'hit',
  'knockdown',
];

/** Every round phase, in a fixed order, for the same reason. */
export const PHASES: readonly RoundPhase[] = [
  'waiting',
  'intro',
  'fighting',
  'settling',
  'round-over',
  'match-over',
];

/** What the host sends: the whole fight, as it stands this frame. */
export function captureFight(fight: Fight): FightState {
  const [a, b] = fight.brawlers;
  return {
    round: fight.round.round,
    phase: fight.round.phase,
    timeLeft: fight.round.timeLeft,
    wins: [fight.round.wins[0], fight.round.wins[1]],
    brawlers: [captureBrawler(a), captureBrawler(b)],
  };
}

function captureBrawler(brawler: BrawlerState): BrawlerState {
  return {
    x: brawler.x,
    y: brawler.y,
    facing: brawler.facing,
    stance: brawler.stance,
    stanceTime: brawler.stanceTime,
    stride: brawler.stride,
    hp: brawler.hp,
    velocity: brawler.velocity,
    verticalVelocity: brawler.verticalVelocity,
  };
}

/**
 * What the guest does with it: adopts the host's account of the fight whole.
 *
 * The guest runs no rules at all, so there is nothing here to reconcile — the
 * snapshot simply *is* the truth, and the guest's own copy is overwritten by
 * it. That costs the guest a round trip of input latency and buys a match
 * that cannot disagree with itself about who won.
 *
 * Between snapshots the guest still integrates the bodies from the velocities
 * this carries, which is motion rather than judgement: it decides nothing, it
 * only keeps thirty updates a second from looking like thirty frames a second.
 */
export function applyFightState(fight: Fight, state: FightState): void {
  fight.round.round = state.round;
  fight.round.phase = state.phase;
  fight.round.timeLeft = state.timeLeft;
  fight.round.wins[0] = state.wins[0];
  fight.round.wins[1] = state.wins[1];
  fight.brawlers[0].adopt(state.brawlers[0]);
  fight.brawlers[1].adopt(state.brawlers[1]);
}
