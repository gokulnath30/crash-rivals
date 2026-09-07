import { clamp, lerp } from '../shared/mathx.ts';
import { ATTACKS, IDLE_INTENT, type Brawler, type Intent } from './brawler.ts';
import type { AttackName } from './events.ts';

/** Where the machine likes to stand: just inside punching range. */
const PREFERRED_GAP = 0.92;
/** Beyond this it runs rather than walks. */
const RUN_GAP = 2.4;

/**
 * The solo opponent.
 *
 * A sparring partner, not a wall: it closes distance, throws more as its own
 * health drops, guards in bursts when it sees a swing coming, backs off for a
 * beat after taking a hit rather than trading blindly, and now and then jumps
 * in or answers a jump with an uppercut. Every choice goes through the
 * injected `random`, so a seeded run is reproducible.
 */
export class MachineMind {
  /** Seconds until it next chooses an action. Zero, so the first frame decides. */
  private thinkIn = 0;
  /** Seconds of guard left, and until it may guard again. */
  private guardFor = 0;
  private guardCooldown = 0;
  /** Seconds of stepping back after being hit. */
  private retreatFor = 0;
  /** Health last frame, to notice a hit. Null until the first frame is seen. */
  private lastHp: number | null = null;
  /** The decision that is being carried out this frame. */
  private plan: 'advance' | 'retreat' | 'hold' = 'hold';

  constructor(private readonly random: () => number = Math.random) {}

  reset(): void {
    this.thinkIn = 0;
    this.guardFor = 0;
    this.guardCooldown = 0;
    this.retreatFor = 0;
    this.lastHp = null;
    this.plan = 'hold';
  }

  decide(self: Brawler, foe: Brawler, dt: number): Intent {
    if (self.down || foe.down) return IDLE_INTENT;

    // Just took one: give ground before anything else.
    if (this.lastHp !== null && self.hp < this.lastHp) {
      this.retreatFor = 0.35 + this.random() * 0.3;
    }
    this.lastHp = self.hp;

    const toward: -1 | 1 = foe.x > self.x ? 1 : -1;
    const away: -1 | 1 = toward === 1 ? -1 : 1;
    const gap = Math.abs(foe.x - self.x);
    const aggression = clamp(0.4 + (1 - self.healthFraction) * 0.45, 0, 1);

    this.guardCooldown -= dt;
    this.retreatFor -= dt;
    this.thinkIn -= dt;

    // Nothing to decide in the air except whether to kick, which it does
    // whenever the foe is under it.
    if (self.airborne) {
      const under = gap <= ATTACKS['air-kick'].reach && foe.y < 0.3;
      return { ...IDLE_INTENT, kick: under && self.stance === 'jump' };
    }

    if (this.guardFor > 0) {
      this.guardFor -= dt;
      return { ...IDLE_INTENT, guard: true };
    }

    // A foe in the air over it gets the uppercut, which is what it is for.
    if (foe.airborne && foe.y > 0.3 && gap <= ATTACKS.uppercut.reach + 0.2 && this.random() < 0.6) {
      return { ...IDLE_INTENT, uppercut: true };
    }

    // React to a swing: a raised guard about a third of the time, which is
    // enough to reward feints without making the guard a wall.
    if (this.seesSwing(foe, gap) && this.guardCooldown <= 0 && this.random() < 0.38) {
      this.guardFor = 0.42;
      this.guardCooldown = 1.3;
      return { ...IDLE_INTENT, guard: true };
    }

    if (this.retreatFor > 0) return { ...IDLE_INTENT, move: away };

    if (this.thinkIn <= 0) {
      this.thinkIn = lerp(0.95, 0.38, aggression) * (0.7 + this.random() * 0.7);
      const kickRange = gap <= ATTACKS.kick.reach + 0.1;

      if (kickRange) {
        const roll = this.random();
        if (roll < aggression * 0.75) return attackIntent(this.pickAttack(gap));
        if (roll < aggression * 0.75 + 0.15) {
          this.plan = 'retreat';
          return { ...IDLE_INTENT, move: away };
        }
      } else if (gap < RUN_GAP && this.random() < 0.18) {
        // Now and then, come in over the top.
        return { ...IDLE_INTENT, jump: true, move: toward };
      }
      this.plan = gap > PREFERRED_GAP ? 'advance' : gap < PREFERRED_GAP - 0.3 ? 'retreat' : 'hold';
    }

    switch (this.plan) {
      case 'advance':
        if (gap <= PREFERRED_GAP) return IDLE_INTENT;
        return { ...IDLE_INTENT, move: toward, run: gap > RUN_GAP };
      case 'retreat':
        return { ...IDLE_INTENT, move: away };
      case 'hold':
        return IDLE_INTENT;
    }
  }

  /**
   * Weighted toward the quick punch up close and the long kick from range,
   * with the sweep and the uppercut as the occasional surprise.
   */
  private pickAttack(gap: number): AttackName {
    const roll = this.random();
    if (gap <= ATTACKS.punch.reach + 0.15) {
      if (roll < 0.55) return 'punch';
      if (roll < 0.72) return 'uppercut';
      if (roll < 0.86) return 'sweep';
      return 'kick';
    }
    return roll < 0.7 ? 'kick' : 'sweep';
  }

  private seesSwing(foe: Brawler, gap: number): boolean {
    if (!foe.attack) return false;
    return (
      foe.stance !== 'hit' &&
      gap <= foe.attack.spec.reach + 0.3 &&
      foe.stanceTime < foe.attack.spec.windup
    );
  }
}

function attackIntent(name: AttackName): Intent {
  switch (name) {
    case 'punch':
      return { ...IDLE_INTENT, punch: true };
    case 'kick':
    case 'air-kick':
      return { ...IDLE_INTENT, kick: true };
    case 'sweep':
      return { ...IDLE_INTENT, sweep: true };
    case 'uppercut':
      return { ...IDLE_INTENT, uppercut: true };
  }
}
