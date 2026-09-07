import { Brawler, IDLE_INTENT, RING, isAttack, type Intent } from './brawler.ts';
import { otherBrawler, type ArenaEvent, type BrawlerIndex } from './events.ts';
import { Round } from './round.ts';

/** Where the two start each round, and which way they look. */
const CORNERS: readonly [{ x: number; facing: 1 }, { x: number; facing: -1 }] = [
  { x: -1.15, facing: 1 },
  { x: 1.15, facing: -1 },
];

/** How far time slows on impact. Not zero, so the freeze still breathes. */
const HITSTOP_SCALE = 0.15;

/**
 * The whole duel in one place: two fighters, the clock, and the one function
 * that decides whether a blow connected.
 *
 * The session feeds it a pair of intents and a frame's worth of time and gets
 * back events. It never sees a key, a bone or a pixel.
 */
export class Fight {
  readonly brawlers: readonly [Brawler, Brawler];
  readonly round = new Round();
  /** Seconds of freeze-frame left on an impact. */
  hitstop = 0;

  constructor(names: readonly [string, string]) {
    this.brawlers = [
      new Brawler(names[0], 0, CORNERS[0].x, CORNERS[0].facing),
      new Brawler(names[1], 1, CORNERS[1].x, CORNERS[1].facing),
    ];
  }

  get midpoint(): number {
    return (this.brawlers[0].x + this.brawlers[1].x) / 2;
  }

  get gap(): number {
    return Math.abs(this.brawlers[0].x - this.brawlers[1].x);
  }

  /** Puts both in their corners and starts the first round. */
  start(): readonly ArenaEvent[] {
    this.round.resetMatch();
    return this.resetAndBegin(() => this.round.beginRound());
  }

  /** The player asked for the next round, or a rematch. */
  advance(): readonly ArenaEvent[] {
    return this.resetAndBegin(() => this.round.advance());
  }

  /**
   * Burns hitstop and reports how much the simulation should actually advance.
   * Applied to the whole fight, so both bodies freeze together.
   */
  scaleFrameTime(dt: number): number {
    if (this.hitstop <= 0) return dt;
    this.hitstop -= dt;
    return dt * HITSTOP_SCALE;
  }

  /**
   * One frame. Intents are honoured only while the round is live; outside it
   * the fighters stand, but anything already in motion (a fall, a stagger)
   * still plays out.
   */
  step(intents: readonly [Intent, Intent], dt: number): readonly ArenaEvent[] {
    const events: ArenaEvent[] = [];
    const live = this.round.acceptsInput;
    const [a, b] = this.brawlers;

    const before: [string, string] = [a.stance, b.stance];
    a.act(live ? intents[0] : IDLE_INTENT, b.x, dt);
    b.act(live ? intents[1] : IDLE_INTENT, a.x, dt);
    for (const index of BOTH) {
      const brawler = this.brawlers[index];
      if (before[index] !== brawler.stance && isAttack(brawler.stance)) {
        events.push({ kind: 'attack', attacker: index, move: brawler.stance });
      }
    }

    if (live) {
      for (const index of BOTH) events.push(...this.judge(index));
    }

    a.integrate(dt);
    b.integrate(dt);
    this.keepApart();
    this.keepInside();

    events.push(...this.round.tick(dt, [a.hp, b.hp]));
    return events;
  }

  private resetAndBegin(begin: () => readonly ArenaEvent[]): readonly ArenaEvent[] {
    for (const brawler of this.brawlers) brawler.reset();
    this.hitstop = 0;
    return begin();
  }

  /** Did this fighter's live attack arrive on the other one? */
  private judge(index: BrawlerIndex): readonly ArenaEvent[] {
    const attacker = this.brawlers[index];
    const defender = this.brawlers[otherBrawler(index)];
    const move = attacker.attack?.name;
    if (!move) return [];

    if (attacker.attackJustMissed) {
      attacker.markStruck();
      return [{ kind: 'whiff', attacker: index, move }];
    }
    if (!attacker.attackIsLive || defender.down) return [];

    // The blow reaches from the attacker's centre to the strike point; the
    // defender is a torso of some width standing somewhere along that line,
    // and possibly above it: a jump clears a sweep, and most of a punch.
    const spec = attacker.attack?.spec;
    if (!spec) return [];
    const ahead = (defender.x - attacker.x) * attacker.facing;
    if (ahead < 0 || ahead - RING.bodyRadius > spec.reach) return [];
    if (defender.y - attacker.y > spec.catchesUpTo) return [];

    attacker.markStruck();
    const received = defender.receive(spec, attacker.facing);
    const heavy = move === 'kick' || move === 'uppercut';
    this.hitstop = Math.max(this.hitstop, received.blocked ? 0.04 : heavy ? 0.12 : 0.08);

    const events: ArenaEvent[] = [
      {
        kind: 'hit',
        attacker: index,
        defender: defender.index,
        move,
        damage: received.damage,
        blocked: received.blocked,
        knockdown: received.knockdown,
        x: defender.x - defender.facing * RING.bodyRadius * 0.6,
        y: spec.height + defender.y,
      },
    ];
    if (received.knockdown) events.push(...this.round.recordKnockdown(defender.index));
    return events;
  }

  /** Two bodies cannot share the floor; the overlap is split between them. */
  private keepApart(): void {
    const [a, b] = this.brawlers;
    const gap = b.x - a.x;
    const overlap = RING.minGap - Math.abs(gap);
    if (overlap <= 0) return;
    const direction = gap >= 0 ? 1 : -1;
    a.x -= (direction * overlap) / 2;
    b.x += (direction * overlap) / 2;
  }

  private keepInside(): void {
    for (const brawler of this.brawlers) {
      const clamped = Math.max(-RING.halfWidth, Math.min(RING.halfWidth, brawler.x));
      if (clamped !== brawler.x) {
        brawler.x = clamped;
        // Into the wall stops the shove; there is nowhere left to go.
        if (Math.sign(brawler.velocity) === Math.sign(brawler.x)) brawler.velocity = 0;
      }
    }
  }
}

const BOTH: readonly BrawlerIndex[] = [0, 1];
