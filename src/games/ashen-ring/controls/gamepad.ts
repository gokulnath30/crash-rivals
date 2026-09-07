import { IDLE_INTENT, type Intent } from '@domain/arena/brawler.ts';
import type { InputSource } from './input.ts';

/**
 * The standard gamepad layout, by button index. The names are what the
 * browser's "standard" mapping guarantees; the faces are what Xbox and
 * PlayStation print on them.
 */
export const BUTTON = {
  /** A on Xbox, Cross on PlayStation. */
  south: 0,
  /** B / Circle. */
  east: 1,
  /** X / Square. */
  west: 2,
  /** Y / Triangle. */
  north: 3,
  leftBumper: 4,
  rightBumper: 5,
  leftTrigger: 6,
  rightTrigger: 7,
  dpadUp: 12,
  dpadDown: 13,
  dpadLeft: 14,
  dpadRight: 15,
} as const;

/** Stick past this counts as a direction; past `RUN_DEADZONE`, a run. */
const DEADZONE = 0.4;
const RUN_DEADZONE = 0.85;
/** Stick pushed up this far is a jump. */
const JUMP_DEADZONE = 0.6;

/** A snapshot of a pad, plain enough to build in a test. */
export interface PadState {
  readonly buttons: readonly boolean[];
  readonly axes: readonly number[];
}

/**
 * Turns a pad snapshot into an intent, given last frame's snapshot so the
 * attack buttons fire once per press.
 *
 * The layout follows the genre: the four face buttons are the four limbs
 * (punch on Square/X, the heavy punch above it on Triangle/Y, kick on
 * Cross/A, the low kick beside it on Circle/B), bumpers and triggers guard,
 * up jumps, and pushing the stick all the way runs.
 */
export function decodeGamepad(now: PadState, before: PadState): Intent {
  const down = (index: number): boolean => now.buttons[index] ?? false;
  const pressed = (index: number): boolean => down(index) && !(before.buttons[index] ?? false);
  const x = now.axes[0] ?? 0;
  const y = now.axes[1] ?? 0;
  const yBefore = before.axes[1] ?? 0;

  const left = down(BUTTON.dpadLeft) || x < -DEADZONE;
  const right = down(BUTTON.dpadRight) || x > DEADZONE;
  const move: -1 | 0 | 1 = left === right ? 0 : left ? -1 : 1;

  return {
    move,
    run: Math.abs(x) > RUN_DEADZONE,
    guard:
      down(BUTTON.dpadDown) ||
      y > JUMP_DEADZONE ||
      down(BUTTON.leftBumper) ||
      down(BUTTON.rightBumper) ||
      down(BUTTON.leftTrigger) ||
      down(BUTTON.rightTrigger),
    jump: pressed(BUTTON.dpadUp) || (y < -JUMP_DEADZONE && yBefore >= -JUMP_DEADZONE),
    punch: pressed(BUTTON.west),
    kick: pressed(BUTTON.south),
    sweep: pressed(BUTTON.east),
    uppercut: pressed(BUTTON.north),
  };
}

/**
 * The n-th connected gamepad, polled once a frame.
 *
 * Polled rather than event-driven because that is how the Gamepad API works:
 * `navigator.getGamepads()` is a snapshot, and the difference between two
 * snapshots is where a press lives.
 */
export class GamepadPad implements InputSource {
  private before: PadState = EMPTY;

  /** @param slot 0 for the first connected pad, 1 for the second. */
  constructor(private readonly slot: 0 | 1) {}

  /** Whether a pad is plugged in for this slot right now. */
  get connected(): boolean {
    return this.pad() !== null;
  }

  read(): Intent {
    const pad = this.pad();
    if (!pad) {
      this.before = EMPTY;
      return IDLE_INTENT;
    }
    const now: PadState = {
      buttons: pad.buttons.map((button) => button.pressed),
      axes: pad.axes,
    };
    const intent = decodeGamepad(now, this.before);
    this.before = now;
    return intent;
  }

  dispose(): void {
    this.before = EMPTY;
  }

  private pad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    const connected = navigator.getGamepads().filter((pad): pad is Gamepad => pad !== null);
    return connected[this.slot] ?? null;
  }
}

/** True when any gamepad at all is plugged in. */
export function anyGamepadConnected(): boolean {
  if (typeof navigator.getGamepads !== 'function') return false;
  return navigator.getGamepads().some((pad) => pad !== null);
}

/** The legend for the HUD, in the same shape as the keyboard's. */
export const GAMEPAD_LEGEND: readonly (readonly [string, string])[] = [
  ['◀ ▶ / stick', 'move'],
  ['stick fully', 'run'],
  ['▲', 'jump'],
  ['▼ / LB RB', 'guard'],
  ['X / □', 'punch'],
  ['A / ✕', 'kick'],
  ['B / ○', 'sweep'],
  ['Y / △', 'uppercut'],
];

const EMPTY: PadState = { buttons: [], axes: [] };
