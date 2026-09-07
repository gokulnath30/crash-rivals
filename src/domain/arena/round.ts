import { RING } from './brawler.ts';
import { NO_EVENTS, type ArenaEvent, type BrawlerIndex } from './events.ts';

/**
 * The scoreboard and the clock.
 *
 * Every delay here is a `pending` entry advanced by `tick`, never a timer: a
 * round is a plain state machine that is fed time and hands back events,
 * which is what makes a whole match reproducible in a test.
 */
export type RoundPhase =
  /** Nothing has started. */
  | 'waiting'
  /** The camera is sweeping in and the round is being announced. */
  | 'intro'
  | 'fighting'
  /** A knockdown or the clock has landed; the call is playing out. */
  | 'settling'
  | 'round-over'
  | 'match-over';

type Pending =
  | { readonly kind: 'fight-call' }
  | { readonly kind: 'end-round'; readonly winner: BrawlerIndex | null }
  | { readonly kind: 'replay-round' };

/** How long the intro sweep and "Round N" card get before "Fight". */
export const INTRO_SECONDS = 2.6;
const SETTLE_SECONDS = 2.3;

export class Round {
  round = 1;
  readonly wins: [number, number] = [0, 0];
  timeLeft: number = RING.roundSeconds;
  phase: RoundPhase = 'waiting';

  private pending: { action: Pending; secondsLeft: number } | null = null;

  get isFighting(): boolean {
    return this.phase === 'fighting';
  }

  /** Fighters may move and swing only during the fight itself. */
  get acceptsInput(): boolean {
    return this.phase === 'fighting';
  }

  /**
   * How far through the opening the round is, 0..1, or null outside it.
   *
   * Read from the same countdown that will call "Fight", so whatever is
   * timed to the intro (a camera sweep, the letterbox) lands on the call
   * itself rather than on a wall clock that may have run ahead of the fight.
   */
  get introProgress(): number | null {
    if (this.phase !== 'intro' || !this.pending) return null;
    return Math.max(0, Math.min(1, 1 - this.pending.secondsLeft / INTRO_SECONDS));
  }

  get decided(): boolean {
    return this.wins[0] >= RING.roundsToWin || this.wins[1] >= RING.roundsToWin;
  }

  get winner(): BrawlerIndex | null {
    if (this.wins[0] >= RING.roundsToWin) return 0;
    if (this.wins[1] >= RING.roundsToWin) return 1;
    return null;
  }

  resetMatch(): void {
    this.round = 1;
    this.wins[0] = 0;
    this.wins[1] = 0;
    this.phase = 'waiting';
    this.pending = null;
    this.timeLeft = RING.roundSeconds;
  }

  beginRound(): readonly ArenaEvent[] {
    this.timeLeft = RING.roundSeconds;
    this.phase = 'intro';
    this.pending = { action: { kind: 'fight-call' }, secondsLeft: INTRO_SECONDS };
    return [
      { kind: 'round-start', round: this.round },
      { kind: 'announce', text: `Round ${this.round}`, holdMs: 1300 },
    ];
  }

  /** A blow put someone down. The round is over; the call is not. */
  recordKnockdown(loser: BrawlerIndex): readonly ArenaEvent[] {
    if (this.phase !== 'fighting') return NO_EVENTS;
    const winner: BrawlerIndex = loser === 0 ? 1 : 0;
    this.wins[winner] += 1;
    this.phase = 'settling';
    this.pending = { action: { kind: 'end-round', winner }, secondsLeft: SETTLE_SECONDS };
    return [{ kind: 'announce', text: 'K.O.', holdMs: 1400 }];
  }

  /**
   * Advances the clock and anything scheduled.
   *
   * @param hp both fighters' health, for deciding a round on time.
   */
  tick(dt: number, hp: readonly [number, number]): readonly ArenaEvent[] {
    const events: ArenaEvent[] = [];

    if (this.pending) {
      this.pending.secondsLeft -= dt;
      if (this.pending.secondsLeft <= 0) {
        const { action } = this.pending;
        this.pending = null;
        events.push(...this.run(action));
      }
    }

    if (this.phase === 'fighting') {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        events.push(...this.callTime(hp));
      }
    }

    return events;
  }

  /** The next round, or a fresh match once one has been decided. */
  advance(): readonly ArenaEvent[] {
    if (this.phase === 'match-over') {
      this.resetMatch();
    } else if (this.phase === 'round-over') {
      this.round += 1;
    }
    return this.beginRound();
  }

  private run(action: Pending): readonly ArenaEvent[] {
    switch (action.kind) {
      case 'fight-call':
        if (this.phase !== 'intro') return NO_EVENTS;
        this.phase = 'fighting';
        return [{ kind: 'fight-call' }, { kind: 'announce', text: 'Fight', holdMs: 800 }];

      case 'end-round': {
        const matchOver = this.decided;
        this.phase = matchOver ? 'match-over' : 'round-over';
        return [
          {
            kind: 'round-end',
            winner: action.winner,
            round: this.round,
            wins: [this.wins[0], this.wins[1]],
            matchOver,
          },
        ];
      }

      case 'replay-round':
        return this.beginRound();
    }
  }

  /** The clock ran out: most health takes it, level health replays it. */
  private callTime(hp: readonly [number, number]): readonly ArenaEvent[] {
    const [a, b] = hp;
    this.phase = 'settling';

    if (a === b) {
      this.pending = { action: { kind: 'replay-round' }, secondsLeft: SETTLE_SECONDS };
      return [{ kind: 'announce', text: 'Draw', holdMs: 1400 }];
    }

    const winner: BrawlerIndex = a > b ? 0 : 1;
    this.wins[winner] += 1;
    this.pending = { action: { kind: 'end-round', winner }, secondsLeft: SETTLE_SECONDS };
    return [{ kind: 'announce', text: 'Time', holdMs: 1400 }];
  }
}
