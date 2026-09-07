import { describe, expect, it } from 'vitest';
import { IDLE_INTENT } from '@domain/arena/brawler.ts';
import { BUTTON, decodeGamepad, type PadState } from '@games/ashen-ring/controls/gamepad.ts';
import { mergeIntents } from '@games/ashen-ring/controls/input.ts';

/**
 * The parts of the controls that are pure: how a gamepad snapshot becomes an
 * intent, and how several devices fold into one player.
 */
const pad = (pressed: readonly number[], axes: readonly number[] = [0, 0]): PadState => {
  const buttons = Array<boolean>(16).fill(false);
  for (const index of pressed) buttons[index] = true;
  return { buttons, axes };
};
const none = pad([]);

describe('a standard gamepad', () => {
  it('walks with the d-pad or the stick, and runs when the stick is pushed fully', () => {
    expect(decodeGamepad(pad([BUTTON.dpadRight]), none).move).toBe(1);
    expect(decodeGamepad(pad([BUTTON.dpadLeft]), none).move).toBe(-1);
    expect(decodeGamepad(pad([], [0.6, 0]), none)).toMatchObject({ move: 1, run: false });
    expect(decodeGamepad(pad([], [-0.95, 0]), none)).toMatchObject({ move: -1, run: true });
    // A resting stick's tiny drift is not a walk.
    expect(decodeGamepad(pad([], [0.1, 0]), none).move).toBe(0);
  });

  it('puts the four limbs on the four face buttons', () => {
    expect(decodeGamepad(pad([BUTTON.west]), none).punch).toBe(true);
    expect(decodeGamepad(pad([BUTTON.north]), none).uppercut).toBe(true);
    expect(decodeGamepad(pad([BUTTON.south]), none).kick).toBe(true);
    expect(decodeGamepad(pad([BUTTON.east]), none).sweep).toBe(true);
  });

  it('fires an attack once per press, not once per frame', () => {
    const held = pad([BUTTON.west]);
    expect(decodeGamepad(held, none).punch).toBe(true);
    expect(decodeGamepad(held, held).punch).toBe(false);
  });

  it('guards on the bumpers, the triggers, or down', () => {
    for (const index of [BUTTON.leftBumper, BUTTON.rightBumper, BUTTON.leftTrigger, BUTTON.rightTrigger, BUTTON.dpadDown]) {
      expect(decodeGamepad(pad([index]), none).guard).toBe(true);
    }
    expect(decodeGamepad(pad([], [0, 0.9]), none).guard).toBe(true);
  });

  it('jumps on up, once per push', () => {
    expect(decodeGamepad(pad([BUTTON.dpadUp]), none).jump).toBe(true);
    const up = pad([], [0, -0.9]);
    expect(decodeGamepad(up, none).jump).toBe(true);
    expect(decodeGamepad(up, up).jump).toBe(false);
  });

  it('does nothing when nothing is touched', () => {
    expect(decodeGamepad(none, none)).toEqual(IDLE_INTENT);
  });
});

describe('merging devices', () => {
  it('lets the first device with a direction steer, and unions the buttons', () => {
    const merged = mergeIntents([
      { ...IDLE_INTENT, move: 1 },
      { ...IDLE_INTENT, move: -1, punch: true },
      { ...IDLE_INTENT, guard: true },
    ]);
    expect(merged).toEqual({ ...IDLE_INTENT, move: 1, punch: true, guard: true });
  });

  it('is idle with no devices', () => {
    expect(mergeIntents([])).toEqual(IDLE_INTENT);
  });
});
