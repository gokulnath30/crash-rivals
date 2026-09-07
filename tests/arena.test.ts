import { describe, expect, it } from 'vitest';
import { MachineMind } from '@domain/arena/ai.ts';
import { ATTACKS, IDLE_INTENT, RING, totalDuration, type Intent } from '@domain/arena/brawler.ts';
import type { ArenaEvent } from '@domain/arena/events.ts';
import { Fight } from '@domain/arena/fight.ts';
import { INTRO_SECONDS, Round } from '@domain/arena/round.ts';

/**
 * Ashen Ring's rules, run without a canvas, a keyboard or a clock.
 *
 * The fight is fed time in fixed steps and the events it hands back are what
 * the tests read, exactly the way the session reads them.
 */
const STEP = 1 / 120;

const still = IDLE_INTENT;
const press = (partial: Partial<Intent>): Intent => ({ ...IDLE_INTENT, ...partial });

/** Runs a fight forward, collecting every event, until `seconds` have passed. */
function run(
  fight: Fight,
  seconds: number,
  intents: () => readonly [Intent, Intent] = () => [still, still],
): ArenaEvent[] {
  const events: ArenaEvent[] = [];
  for (let t = 0; t < seconds; t += STEP) events.push(...fight.step(intents(), STEP));
  return events;
}

/** A fight with the intro already played out, so input is live. */
function liveFight(): Fight {
  const fight = new Fight(['A', 'B']);
  fight.start();
  run(fight, INTRO_SECONDS + 0.05);
  expect(fight.round.isFighting).toBe(true);
  return fight;
}

const kinds = (events: readonly ArenaEvent[]): string[] => events.map((event) => event.kind);

describe('the round clock', () => {
  it('announces the round, then calls the fight after the intro', () => {
    const round = new Round();
    const opening = round.beginRound();
    expect(kinds(opening)).toEqual(['round-start', 'announce']);
    expect(round.phase).toBe('intro');
    expect(round.acceptsInput).toBe(false);

    const events = round.tick(INTRO_SECONDS + 0.01, [100, 100]);
    expect(kinds(events)).toEqual(['fight-call', 'announce']);
    expect(round.isFighting).toBe(true);
  });

  it('reports how far through the opening it is, and nothing once the fight is on', () => {
    const round = new Round();
    expect(round.introProgress).toBeNull();
    round.beginRound();
    expect(round.introProgress).toBeCloseTo(0);
    round.tick(INTRO_SECONDS / 2, [100, 100]);
    expect(round.introProgress).toBeCloseTo(0.5);
    round.tick(INTRO_SECONDS / 2 + 0.01, [100, 100]);
    expect(round.introProgress).toBeNull();
  });

  it('gives the round to whoever has more health when time runs out', () => {
    const round = new Round();
    round.beginRound();
    round.tick(INTRO_SECONDS + 0.01, [100, 100]);
    const events = round.tick(RING.roundSeconds + 0.01, [40, 60]);
    expect(events.some((event) => event.kind === 'announce' && event.text === 'Time')).toBe(true);
    expect(round.wins).toEqual([0, 1]);
    expect(round.phase).toBe('settling');
  });

  it('replays a round that ends level', () => {
    const round = new Round();
    round.beginRound();
    round.tick(INTRO_SECONDS + 0.01, [100, 100]);
    const events = round.tick(RING.roundSeconds + 0.01, [50, 50]);
    expect(events.some((event) => event.kind === 'announce' && event.text === 'Draw')).toBe(true);
    expect(round.wins).toEqual([0, 0]);
    // After the settle, the same round begins again rather than ending.
    const later = round.tick(5, [50, 50]);
    expect(kinds(later)).toContain('round-start');
    expect(round.round).toBe(1);
  });

  it('decides the match after two rounds to one side', () => {
    const round = new Round();
    round.beginRound();
    round.tick(INTRO_SECONDS + 0.01, [100, 100]);
    round.recordKnockdown(1);
    let events = round.tick(5, [100, 0]);
    const first = events.find((event) => event.kind === 'round-end');
    expect(first?.kind === 'round-end' && first.matchOver).toBe(false);

    round.advance();
    round.tick(INTRO_SECONDS + 0.01, [100, 100]);
    round.recordKnockdown(1);
    events = round.tick(5, [100, 0]);
    const second = events.find((event) => event.kind === 'round-end');
    expect(second?.kind === 'round-end' && second.matchOver).toBe(true);
    expect(round.winner).toBe(0);
    expect(round.phase).toBe('match-over');
  });

  it('ignores a knockdown outside the fight', () => {
    const round = new Round();
    round.beginRound();
    expect(round.recordKnockdown(0)).toHaveLength(0);
    expect(round.wins).toEqual([0, 0]);
  });
});

describe('two fighters on the line', () => {
  it('start in their corners facing each other', () => {
    const fight = new Fight(['A', 'B']);
    fight.start();
    const [a, b] = fight.brawlers;
    expect(a.x).toBeLessThan(b.x);
    expect(a.facing).toBe(1);
    expect(b.facing).toBe(-1);
  });

  it('stand still during the intro however hard the keys are pressed', () => {
    const fight = new Fight(['A', 'B']);
    fight.start();
    const startX = fight.brawlers[0].x;
    run(fight, 0.5, () => [press({ move: 1, run: true }), still]);
    expect(fight.brawlers[0].x).toBe(startX);
    expect(fight.brawlers[0].stance).toBe('idle');
  });

  it('walk and run at different speeds, and walk backward slower still', () => {
    const fight = liveFight();
    const a = fight.brawlers[0];
    const from = a.x;
    run(fight, 0.5, () => [press({ move: -1 }), still]);
    const retreat = from - a.x;
    expect(a.stride).toBe(-1);

    const mid = a.x;
    run(fight, 0.5, () => [press({ move: 1 }), still]);
    const walk = a.x - mid;
    expect(a.stance).toBe('walk');
    expect(a.stride).toBe(1);

    const again = a.x;
    run(fight, 0.5, () => [press({ move: 1, run: true }), still]);
    const sprint = a.x - again;
    expect(a.stance).toBe('run');

    expect(retreat).toBeLessThan(walk);
    expect(walk).toBeLessThan(sprint);
  });

  it('cannot walk through each other', () => {
    const fight = liveFight();
    run(fight, 3, () => [press({ move: 1, run: true }), press({ move: -1, run: true })]);
    expect(fight.gap).toBeGreaterThanOrEqual(RING.minGap - 1e-6);
  });

  it('cannot leave the ring', () => {
    const fight = liveFight();
    run(fight, 4, () => [press({ move: -1 }), press({ move: 1 })]);
    expect(fight.brawlers[0].x).toBeCloseTo(-RING.halfWidth, 5);
    expect(fight.brawlers[1].x).toBeCloseTo(RING.halfWidth, 5);
  });

  it('turn to face a foe who has crossed behind them', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x - 1.5;
    run(fight, 0.1);
    expect(a.facing).toBe(-1);
    expect(b.facing).toBe(1);
  });
});

describe('landing a blow', () => {
  it('lands a punch in range and reports where', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + 0.8;
    const stoodAt = b.x;
    let pressed = false;
    const events = run(fight, totalDuration(ATTACKS.punch) + 0.05, () => {
      const punch = !pressed;
      pressed = true;
      return [press({ punch }), still];
    });
    expect(kinds(events)).toContain('attack');
    const hit = events.find((event) => event.kind === 'hit');
    expect(hit?.kind === 'hit' && hit.damage).toBe(ATTACKS.punch.damage);
    expect(b.hp).toBe(RING.maxHp - ATTACKS.punch.damage);
    // The contact is on the near side of the defender's torso, where they
    // stood when it landed; the shove moves them afterwards.
    expect(hit?.kind === 'hit' && hit.x).toBeCloseTo(stoodAt + RING.bodyRadius * 0.6, 1);
    expect(hit?.kind === 'hit' && hit.y).toBe(ATTACKS.punch.height);
    expect(a.attack).toBeNull();
    expect(a.stance).toBe('idle');
  });

  it('whiffs when the foe is out of reach', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + ATTACKS.punch.reach + 1;
    let pressed = false;
    const events = run(fight, totalDuration(ATTACKS.punch) + 0.05, () => {
      const punch = !pressed;
      pressed = true;
      return [press({ punch }), still];
    });
    expect(kinds(events)).toContain('whiff');
    expect(kinds(events)).not.toContain('hit');
    expect(b.hp).toBe(RING.maxHp);
  });

  it('lands at most once however long the swing is held out', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + 0.8;
    let pressed = false;
    const events = run(fight, totalDuration(ATTACKS.punch), () => {
      const punch = !pressed;
      pressed = true;
      return [press({ punch }), still];
    });
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(1);
  });

  it('cuts a blocked kick to a fifth and does not stagger the guard', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + 1.0;
    let pressed = false;
    const events = run(fight, totalDuration(ATTACKS.kick), () => {
      const kick = !pressed;
      pressed = true;
      return [press({ kick }), press({ guard: true })];
    });
    const hit = events.find((event) => event.kind === 'hit');
    expect(hit?.kind === 'hit' && hit.blocked).toBe(true);
    expect(b.hp).toBe(RING.maxHp - Math.round(ATTACKS.kick.damage * RING.blockScale));
    expect(b.stance).toBe('guard');
  });

  it('staggers on a clean hit, then recovers', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + 0.8;
    let pressed = false;
    run(fight, ATTACKS.punch.windup + ATTACKS.punch.active, () => {
      const punch = !pressed;
      pressed = true;
      return [press({ punch }), still];
    });
    expect(b.stance).toBe('hit');
    expect(b.busy).toBe(true);
    run(fight, ATTACKS.punch.stagger + 0.1);
    expect(b.stance).toBe('idle');
  });

  it('shoves the defender back and away from the attacker', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + 0.8;
    const before = b.x;
    let pressed = false;
    run(fight, totalDuration(ATTACKS.kick) + 0.3, () => {
      const kick = !pressed;
      pressed = true;
      return [press({ kick }), still];
    });
    expect(b.x).toBeGreaterThan(before + 0.2);
  });

  it('knocks down at zero health and hands the round over', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + 0.8;
    b.hp = ATTACKS.punch.damage;
    let pressed = false;
    const events = run(fight, totalDuration(ATTACKS.punch), () => {
      const punch = !pressed;
      pressed = true;
      return [press({ punch }), still];
    });
    const hit = events.find((event) => event.kind === 'hit');
    expect(hit?.kind === 'hit' && hit.knockdown).toBe(true);
    expect(b.down).toBe(true);
    expect(fight.round.phase).toBe('settling');
    expect(events.some((event) => event.kind === 'announce' && event.text === 'K.O.')).toBe(true);

    // The call plays out, then the round ends 1-0.
    const later = run(fight, 3);
    const end = later.find((event) => event.kind === 'round-end');
    expect(end?.kind === 'round-end' && end.winner).toBe(0);
    expect(fight.round.wins).toEqual([1, 0]);
  });

  it('freezes time briefly on impact', () => {
    const fight = liveFight();
    expect(fight.scaleFrameTime(0.016)).toBeCloseTo(0.016);
    fight.hitstop = 0.1;
    expect(fight.scaleFrameTime(0.016)).toBeLessThan(0.016);
  });

  it('puts both back in their corners for the next round', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    a.x = 2;
    b.hp = 3;
    fight.advance();
    expect(a.x).toBeCloseTo(-1.15);
    expect(b.hp).toBe(RING.maxHp);
    expect(fight.round.phase).toBe('intro');
  });
});

describe('leaving the floor', () => {
  /** Presses a button once, then holds nothing, for `seconds`. */
  const once = (partial: Partial<Intent>, hold: Partial<Intent> = {}) => {
    let pressed = false;
    return (): readonly [Intent, Intent] => {
      const first = pressed ? press(hold) : press({ ...hold, ...partial });
      pressed = true;
      return [first, still];
    };
  };

  it('jumps in an arc and lands back on its feet', () => {
    const fight = liveFight();
    const a = fight.brawlers[0];
    run(fight, 0.3, once({ jump: true }));
    expect(a.airborne).toBe(true);
    expect(a.stance).toBe('jump');
    expect(a.y).toBeGreaterThan(0.5);
    run(fight, 0.7);
    expect(a.airborne).toBe(false);
    expect(a.y).toBe(0);
    expect(a.stance).toBe('idle');
  });

  it('carries a held direction into the jump and ignores a guard mid-air', () => {
    const fight = liveFight();
    const a = fight.brawlers[0];
    const from = a.x;
    run(fight, 0.4, once({ jump: true, move: 1 }, { guard: true, move: 1 }));
    expect(a.x).toBeGreaterThan(from + 0.3);
    expect(a.stance).toBe('jump');
  });

  it('lets a punch pass under a jumping foe', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + 0.8;
    b.y = 0.8;
    b.verticalVelocity = 2;
    const events = run(fight, ATTACKS.punch.windup + ATTACKS.punch.active, once({ punch: true }));
    expect(kinds(events)).not.toContain('hit');
    expect(b.hp).toBe(RING.maxHp);
  });

  it('catches a jumping foe with the uppercut', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + 0.7;
    b.y = 0.8;
    b.verticalVelocity = 2;
    const events = run(fight, ATTACKS.uppercut.windup + ATTACKS.uppercut.active, once({ uppercut: true }));
    const hit = events.find((event) => event.kind === 'hit');
    expect(hit?.kind === 'hit' && hit.move).toBe('uppercut');
    expect(b.hp).toBe(RING.maxHp - ATTACKS.uppercut.damage);
  });

  it('sweeps low: under a jump, but into a standing foe', () => {
    const jumped = liveFight();
    jumped.brawlers[1].x = jumped.brawlers[0].x + 0.8;
    jumped.brawlers[1].y = 0.5;
    jumped.brawlers[1].verticalVelocity = 3;
    const missed = run(jumped, ATTACKS.sweep.windup + ATTACKS.sweep.active, once({ sweep: true }));
    expect(kinds(missed)).not.toContain('hit');

    const standing = liveFight();
    standing.brawlers[1].x = standing.brawlers[0].x + 0.8;
    const landed = run(standing, ATTACKS.sweep.windup + ATTACKS.sweep.active, once({ sweep: true }));
    const hit = landed.find((event) => event.kind === 'hit');
    expect(hit?.kind === 'hit' && hit.move).toBe('sweep');
    expect(hit?.kind === 'hit' && hit.y).toBe(ATTACKS.sweep.height);
  });

  it('throws a flying kick from a jump that lands before the floor does', () => {
    const fight = liveFight();
    const [a, b] = fight.brawlers;
    b.x = a.x + 1.2;
    let frame = 0;
    const events = run(fight, 0.9, () => {
      frame += 1;
      // Jump forward on the first frame, kick a few frames into the air.
      return [press({ jump: frame === 1, move: frame === 1 ? 1 : 0, kick: frame === 12 }), still];
    });
    expect(kinds(events)).toContain('attack');
    const hit = events.find((event) => event.kind === 'hit');
    expect(hit?.kind === 'hit' && hit.move).toBe('air-kick');
    expect(b.hp).toBe(RING.maxHp - ATTACKS['air-kick'].damage);
    // Back on the floor afterwards, and free to act.
    expect(a.airborne).toBe(false);
    expect(a.stance).toBe('idle');
  });
});

describe('the machine', () => {
  it('kicks when it is in the air over the player', () => {
    const fight = liveFight();
    const [player, machine] = fight.brawlers;
    machine.x = player.x + 0.6;
    machine.y = 0.7;
    machine.verticalVelocity = 1;
    machine.stance = 'jump';
    const mind = new MachineMind(() => 0.5);
    expect(mind.decide(machine, player, STEP).kick).toBe(true);
  });

  it('closes distance when far away', () => {
    const fight = liveFight();
    const [player, machine] = fight.brawlers;
    machine.x = player.x + 3;
    const mind = new MachineMind(() => 0.5);
    const intent = mind.decide(machine, player, STEP);
    expect(intent.move).toBe(-1);
    expect(intent.run).toBe(true);
  });

  it('does nothing while either fighter is down', () => {
    const fight = liveFight();
    const [player, machine] = fight.brawlers;
    machine.hp = 0;
    machine.receive(ATTACKS.punch, 1);
    const mind = new MachineMind(() => 0.5);
    expect(mind.decide(machine, player, STEP)).toEqual(IDLE_INTENT);
  });

  it('is reproducible under a seeded random and eventually swings', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const fight = liveFight();
    const [player, machine] = fight.brawlers;
    const mind = new MachineMind(random);
    const swung = run(fight, 8, () => [still, mind.decide(machine, player, STEP)]).some(
      (event) => event.kind === 'attack' && event.attacker === 1,
    );
    expect(swung).toBe(true);
  });
});
