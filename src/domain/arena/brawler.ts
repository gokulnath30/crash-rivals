import { clamp } from '../shared/mathx.ts';
import type { AttackName, BrawlerIndex } from './events.ts';

/**
 * What a fighter is doing. One of these is on screen at any moment, and the
 * animator draws exactly this list, so the rules and the picture cannot
 * disagree about what a fighter is up to.
 */
export type Stance =
  | 'idle'
  | 'walk'
  | 'run'
  | 'guard'
  | 'jump'
  | 'punch'
  | 'kick'
  | 'sweep'
  | 'uppercut'
  | 'air-kick'
  | 'hit'
  | 'knockdown';

/** A frame of input, from a keyboard or from the machine. */
export interface Intent {
  /** World direction: -1 left, +1 right, 0 still. */
  readonly move: -1 | 0 | 1;
  readonly run: boolean;
  readonly guard: boolean;
  /** Edge-triggered: true on the frame the button went down. */
  readonly jump: boolean;
  readonly punch: boolean;
  readonly kick: boolean;
  readonly sweep: boolean;
  readonly uppercut: boolean;
}

export const IDLE_INTENT: Intent = Object.freeze({
  move: 0,
  run: false,
  guard: false,
  jump: false,
  punch: false,
  kick: false,
  sweep: false,
  uppercut: false,
});

export interface AttackSpec {
  /** Seconds before the blow can connect. */
  readonly windup: number;
  /** Seconds the blow is live. It lands at most once. */
  readonly active: number;
  /** Seconds before the fighter can act again. */
  readonly recovery: number;
  /** How far in front of the fighter the blow reaches, in metres. */
  readonly reach: number;
  readonly damage: number;
  /** Height of the contact point, for effects. */
  readonly height: number;
  /** How hard the defender is shoved, in metres per second. */
  readonly pushback: number;
  /** How long the defender is staggered. */
  readonly stagger: number;
  /**
   * How high off the floor a defender can be and still be caught. A sweep
   * goes under a jump; an uppercut is the one thing that reaches into it.
   */
  readonly catchesUpTo: number;
}

export const ATTACKS: Readonly<Record<AttackName, AttackSpec>> = {
  punch: {
    windup: 0.14,
    active: 0.1,
    recovery: 0.3,
    reach: 0.98,
    damage: 8,
    height: 1.45,
    pushback: 1.6,
    stagger: 0.42,
    catchesUpTo: 0.55,
  },
  kick: {
    windup: 0.26,
    active: 0.12,
    recovery: 0.5,
    reach: 1.3,
    damage: 14,
    height: 1.15,
    pushback: 3.2,
    stagger: 0.62,
    catchesUpTo: 0.55,
  },
  /** Low and fast to come out, slow to recover. Goes under a jump. */
  sweep: {
    windup: 0.2,
    active: 0.1,
    recovery: 0.48,
    reach: 1.15,
    damage: 10,
    height: 0.4,
    pushback: 1.4,
    stagger: 0.55,
    catchesUpTo: 0.2,
  },
  /** The heavy hand. Short reach, long recovery, and it catches jumpers. */
  uppercut: {
    windup: 0.22,
    active: 0.1,
    recovery: 0.56,
    reach: 0.86,
    damage: 16,
    height: 1.6,
    pushback: 2.6,
    stagger: 0.7,
    catchesUpTo: 1.2,
  },
  /** Thrown mid-jump. Live until the fighter lands. */
  'air-kick': {
    windup: 0.1,
    active: 0.5,
    recovery: 0.1,
    reach: 1.15,
    damage: 12,
    height: 1.2,
    pushback: 2.4,
    stagger: 0.55,
    catchesUpTo: 1.2,
  },
};

export const totalDuration = (spec: AttackSpec): number =>
  spec.windup + spec.active + spec.recovery;

/** The numbers the whole fight is tuned around. */
export const RING = {
  maxHp: 100,
  /** How far either fighter can go from the centre. */
  halfWidth: 3.4,
  /** Two bodies cannot occupy the same floor. */
  minGap: 0.62,
  /** Half the width of a torso, for deciding whether a fist arrived. */
  bodyRadius: 0.22,
  walkSpeed: 1.55,
  backSpeed: 1.2,
  runSpeed: 3.9,
  /** Fraction of the damage that gets through a guard. */
  blockScale: 0.2,
  roundSeconds: 60,
  roundsToWin: 2,
  /** Take-off speed and gravity. Floaty on purpose, as the genre is. */
  jumpSpeed: 4.8,
  gravity: 12,
  /** Horizontal speed carried into a jump when a direction is held. */
  jumpDrift: 2.0,
} as const;

/** How quickly a shove wears off: fraction of the velocity left after a second. */
const SHOVE_DECAY = 0.002;

export interface ActiveAttack {
  readonly name: AttackName;
  readonly spec: AttackSpec;
  /** A blow lands at most once, however long it is held out. */
  struck: boolean;
}

export interface Received {
  readonly damage: number;
  readonly knockdown: boolean;
  readonly blocked: boolean;
}

/**
 * One fighter: where they are, what they are doing, and how much is left in
 * them. Pure state and rules; nothing here knows what a bone or a key is.
 *
 * Movement is along a line, plus a jump. The two fighters face each other,
 * which is the whole grammar of the genre: distance is the only thing that
 * matters, and every decision is about closing or keeping it.
 */
export class Brawler {
  x: number;
  /** Height above the floor. Zero except mid-jump. */
  y = 0;
  /** +1 faces toward positive x, -1 the other way. Always toward the foe. */
  facing: 1 | -1;
  hp: number = RING.maxHp;
  stance: Stance = 'idle';
  /** Seconds spent in the current stance. */
  stanceTime = 0;
  /**
   * Movement relative to facing, for the animation: +1 advancing, -1
   * retreating, 0 standing. Set only while walking or running.
   */
  stride: -1 | 0 | 1 = 0;
  /** Metres per second along x: controlled movement plus any shove. */
  velocity = 0;
  /** Metres per second upward. */
  verticalVelocity = 0;
  attack: ActiveAttack | null = null;
  /** How long the current stagger lasts. */
  private staggerFor = 0;

  constructor(
    readonly name: string,
    readonly index: BrawlerIndex,
    private readonly startX: number,
    private readonly startFacing: 1 | -1,
  ) {
    this.x = startX;
    this.facing = startFacing;
  }

  reset(): void {
    this.x = this.startX;
    this.y = 0;
    this.facing = this.startFacing;
    this.hp = RING.maxHp;
    this.stance = 'idle';
    this.stanceTime = 0;
    this.stride = 0;
    this.velocity = 0;
    this.verticalVelocity = 0;
    this.attack = null;
    this.staggerFor = 0;
  }

  get healthFraction(): number {
    return clamp(this.hp / RING.maxHp, 0, 1);
  }

  get down(): boolean {
    return this.stance === 'knockdown';
  }

  get airborne(): boolean {
    return this.y > 0;
  }

  /** How long the current stagger lasts, so a flinch can be timed to it. */
  get staggerSeconds(): number {
    return this.staggerFor;
  }

  /** Committed to something that input cannot interrupt. */
  get busy(): boolean {
    return isAttack(this.stance) || this.stance === 'hit' || this.down;
  }

  /**
   * Turns an intent into a stance for this frame. Free stances (idle, walk,
   * run, guard) are re-decided every frame from the input; committed ones
   * (attacks, being hit, knocked down) run to their end first; a jump takes
   * only one order, the kick, until the floor comes back.
   *
   * @param foeX where the other fighter stands, so this one keeps facing them.
   */
  act(intent: Intent, foeX: number, dt: number): void {
    this.stanceTime += dt;

    if (this.airborne) {
      if (this.stance === 'jump' && intent.kick) this.beginAttack('air-kick');
      else if (isAttack(this.stance)) this.continueAttack();
      this.stride = 0;
      return;
    }

    if (this.busy) {
      this.continueCommitted();
      this.stride = 0;
      return;
    }

    // Always square up. A fighter who has walked past the other turns round.
    if (Math.abs(foeX - this.x) > 0.01) this.facing = foeX > this.x ? 1 : -1;

    if (intent.jump) {
      this.setStance('jump');
      this.verticalVelocity = RING.jumpSpeed;
      // Nudged off the floor now, so the very next frame is airborne.
      this.y = 0.001;
      this.velocity = intent.move * RING.jumpDrift;
      this.stride = 0;
      return;
    }

    const attack = chooseAttack(intent);
    if (attack) {
      this.beginAttack(attack);
      this.stride = 0;
      this.velocity = 0;
      return;
    }

    if (intent.guard) {
      // Raising the guard plants the feet; a shove taken while already
      // guarding keeps carrying them and wears off in `integrate`.
      if (this.stance !== 'guard') {
        this.setStance('guard');
        this.velocity = 0;
      }
      this.stride = 0;
      return;
    }

    if (intent.move !== 0) {
      const advancing = intent.move === this.facing;
      const running = advancing && intent.run;
      this.setStance(running ? 'run' : 'walk');
      this.stride = advancing ? 1 : -1;
      const speed = running ? RING.runSpeed : advancing ? RING.walkSpeed : RING.backSpeed;
      this.velocity = intent.move * speed;
      return;
    }

    this.setStance('idle');
    this.stride = 0;
    this.velocity = 0;
  }

  /**
   * Whether the current attack is live this frame and has not yet connected.
   * The fight asks this once per frame and decides what, if anything, it hit.
   */
  get attackIsLive(): boolean {
    if (!this.attack || this.attack.struck) return false;
    const { spec } = this.attack;
    return this.stanceTime >= spec.windup && this.stanceTime < spec.windup + spec.active;
  }

  /** The attack's window has passed without a verdict; it hit nothing. */
  get attackJustMissed(): boolean {
    if (!this.attack || this.attack.struck) return false;
    return this.stanceTime >= this.attack.spec.windup + this.attack.spec.active;
  }

  /** Where the fist or foot is right now, in world x. */
  strikePoint(): number {
    const reach = this.attack?.spec.reach ?? 0;
    return this.x + this.facing * reach;
  }

  /** Records that the live attack connected (or was judged), so it cannot again. */
  markStruck(): void {
    if (this.attack) this.attack.struck = true;
  }

  /**
   * Takes a blow. Mutates health and stance; returns what it cost.
   *
   * @param fromFacing which way the attacker was facing, so the shove goes
   *   the right way and a guard only counts when it faces the blow.
   */
  receive(spec: AttackSpec, fromFacing: 1 | -1): Received {
    const blocked = this.stance === 'guard' && this.facing === -fromFacing;
    const damage = Math.round(blocked ? spec.damage * RING.blockScale : spec.damage);
    this.hp = Math.max(0, this.hp - damage);
    this.velocity = fromFacing * spec.pushback * (blocked ? 0.5 : 1);
    this.attack = null;

    if (this.hp <= 0) {
      this.setStance('knockdown');
      return { damage, knockdown: true, blocked };
    }

    if (blocked) {
      // The guard holds; the shove alone says something arrived.
      return { damage, knockdown: false, blocked };
    }

    this.setStance('hit');
    this.staggerFor = spec.stagger;
    return { damage, knockdown: false, blocked };
  }

  /**
   * Moves along the line, falls under gravity, and wears off any shove.
   * Walls are the fight's job.
   */
  integrate(dt: number): void {
    this.x += this.velocity * dt;

    if (this.airborne) {
      this.verticalVelocity -= RING.gravity * dt;
      this.y += this.verticalVelocity * dt;
      if (this.y <= 0) this.land();
      return;
    }

    if (this.stance === 'hit' || this.stance === 'knockdown' || this.stance === 'guard') {
      this.velocity *= Math.pow(SHOVE_DECAY, dt);
      if (Math.abs(this.velocity) < 0.01) this.velocity = 0;
    }
  }

  private land(): void {
    this.y = 0;
    this.verticalVelocity = 0;
    // Whatever was happening in the air is over. A fighter dropped by a blow
    // mid-jump stays down; everyone else is simply back on their feet.
    if (this.down) return;
    this.attack = null;
    this.velocity = 0;
    this.setStance('idle');
  }

  private beginAttack(name: AttackName): void {
    this.attack = { name, spec: ATTACKS[name], struck: false };
    this.setStance(name);
  }

  private continueAttack(): void {
    const spec = this.attack?.spec;
    if (!spec || this.stanceTime < totalDuration(spec)) return;
    this.attack = null;
    // Mid-air the legs come back but the jump goes on; on the floor, done.
    this.setStance(this.airborne ? 'jump' : 'idle');
  }

  private continueCommitted(): void {
    if (isAttack(this.stance)) {
      this.continueAttack();
      return;
    }
    if (this.stance === 'hit' && this.stanceTime >= this.staggerFor) {
      this.setStance('idle');
    }
    // A knockdown holds until the round resets them.
  }

  private setStance(stance: Stance): void {
    if (this.stance === stance) return;
    this.stance = stance;
    this.stanceTime = 0;
  }
}

export function isAttack(stance: Stance): stance is AttackName {
  return (
    stance === 'punch' ||
    stance === 'kick' ||
    stance === 'sweep' ||
    stance === 'uppercut' ||
    stance === 'air-kick'
  );
}

/** Which ground attack an intent asks for, quickest first when several are down. */
function chooseAttack(intent: Intent): AttackName | null {
  if (intent.punch) return 'punch';
  if (intent.kick) return 'kick';
  if (intent.sweep) return 'sweep';
  if (intent.uppercut) return 'uppercut';
  return null;
}
