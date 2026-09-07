import { describe, expect, it } from 'vitest';
import { ATTACKS } from '@domain/arena/brawler.ts';
import { CLIPS, JUMP_FLIGHT_SECONDS, cueFor } from '@games/ashen-ring/render/clip-timing.ts';

/**
 * How a fighter's time in a stance maps onto a recorded clip.
 *
 * The one promise worth pinning: the recording never moves the hit. The rules
 * say when a punch is live, and the clip's contact frame has to be on screen
 * at exactly that moment, whatever the recording's own tempo was.
 */
const durations = { idle: 0.8, guard: 0.5, punch: 0.4, kick: 0.97, jump: 0.4 } as const;
const duration = (name: keyof typeof durations): number => durations[name];
const none = (): null => null;

describe('mapping a stance onto a clip', () => {
  it('shows the punch contact frame exactly when the rules make the punch live', () => {
    const cue = cueFor('punch', ATTACKS.punch.windup, ATTACKS.punch, duration);
    expect(cue?.name).toBe('punch');
    expect(cue?.time).toBeCloseTo(CLIPS.punch.impact ?? -1);
    expect(cue?.weight).toBe(1);
  });

  it('warps the wind-up so it starts at the clip start', () => {
    const start = cueFor('punch', 0, ATTACKS.punch, duration);
    const half = cueFor('punch', ATTACKS.punch.windup / 2, ATTACKS.punch, duration);
    expect(start?.time).toBe(0);
    expect(half?.time).toBeCloseTo((CLIPS.punch.impact ?? 0) / 2);
  });

  it('plays the recovery at the recording speed, then hands back to the procedural pose', () => {
    const later = cueFor('punch', ATTACKS.punch.windup + 0.05, ATTACKS.punch, duration);
    expect(later?.time).toBeCloseTo((CLIPS.punch.impact ?? 0) + 0.05);
    const spent = cueFor('punch', ATTACKS.punch.windup + 1, ATTACKS.punch, duration);
    expect(spent?.weight).toBe(0);
    expect(spent?.time).toBe(durations.punch);
  });

  it('does the same for the kick', () => {
    const cue = cueFor('kick', ATTACKS.kick.windup, ATTACKS.kick, duration);
    expect(cue?.time).toBeCloseTo(CLIPS.kick.impact ?? -1);
  });

  it('loops the idle and the guard', () => {
    expect(cueFor('idle', 0.8 * 3 + 0.1, null, duration)?.time).toBeCloseTo(0.1);
    expect(cueFor('guard', 0.5 + 0.2, null, duration)?.time).toBeCloseTo(0.2);
  });

  it('spreads the jump clip over the flight the rules give a jump', () => {
    const apex = cueFor('jump', JUMP_FLIGHT_SECONDS / 2, null, duration);
    expect(apex?.time).toBeCloseTo(durations.jump / 2);
    // A long float never runs past the end of the recording.
    expect(cueFor('jump', 5, null, duration)?.time).toBe(durations.jump);
  });

  it('leaves everything without a recording to the procedural animator', () => {
    for (const stance of ['walk', 'run', 'sweep', 'uppercut', 'air-kick', 'hit', 'knockdown'] as const) {
      expect(cueFor(stance, 0.3, ATTACKS.sweep, duration)).toBeNull();
    }
  });

  it('stays procedural until a clip has actually arrived', () => {
    expect(cueFor('idle', 0.3, null, none)).toBeNull();
    expect(cueFor('punch', 0.1, ATTACKS.punch, none)).toBeNull();
  });
});
