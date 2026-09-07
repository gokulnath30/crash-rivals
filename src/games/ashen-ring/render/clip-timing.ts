import type { AttackSpec, Stance } from '@domain/arena/brawler.ts';

/**
 * Which motion-captured clip a stance plays, and how the fighter's time in
 * that stance maps onto the clip's time.
 *
 * Pure numbers, no three.js, so the mapping is testable on its own. The rule
 * that matters most is that a clip never moves the hit: the rules decide when
 * a blow lands, and the clip is warped so its contact frame arrives on
 * exactly that moment.
 */
export type ClipName = 'idle' | 'guard' | 'punch' | 'kick' | 'jump';

export interface ClipSegment {
  /** File under `public/animations/`. */
  readonly file: string;
  /** Play round and round, blending the seam. */
  readonly loop: boolean;
  /** Seconds at the end of a loop blended back into its start. */
  readonly seam: number;
  /** For attacks: the clip time of the contact frame. */
  readonly impact: number | null;
  /**
   * Whether the clip's own hip height is used. Off for the jump, whose
   * height comes from the rules, not the recording.
   */
  readonly hipsHeight: boolean;
}

/**
 * The trimmed Avaturn segments, with times relative to each trimmed file.
 * Chosen from contact sheets of the original recordings.
 */
export const CLIPS: Readonly<Record<ClipName, ClipSegment>> = {
  idle: { file: 'animations/idle.glb', loop: true, seam: 0.18, impact: null, hipsHeight: true },
  guard: { file: 'animations/guard.glb', loop: true, seam: 0.15, impact: null, hipsHeight: true },
  punch: { file: 'animations/punch.glb', loop: false, seam: 0, impact: 0.27, hipsHeight: true },
  kick: { file: 'animations/kick.glb', loop: false, seam: 0, impact: 0.4, hipsHeight: true },
  jump: { file: 'animations/jump.glb', loop: false, seam: 0, impact: null, hipsHeight: false },
};

/** How long the rules' jump keeps a fighter in the air: 2 · speed / gravity. */
export const JUMP_FLIGHT_SECONDS = 0.8;

export interface ClipCue {
  readonly name: ClipName;
  /** Where in the clip to sample, in seconds. */
  readonly time: number;
  /** 1 to show the clip, 0 to hand back to the procedural pose. */
  readonly weight: number;
}

/**
 * Where a fighter's stance and time land in a clip, or null for stances that
 * have no recording and stay procedural.
 *
 * @param stanceTime seconds in the current stance.
 * @param spec the attack being thrown, for its wind-up length.
 * @param duration the clip's length, in seconds.
 */
export function cueFor(
  stance: Stance,
  stanceTime: number,
  spec: AttackSpec | null,
  duration: (name: ClipName) => number | null,
): ClipCue | null {
  switch (stance) {
    case 'idle':
    case 'guard': {
      const length = duration(stance);
      if (length === null) return null;
      return { name: stance, time: stanceTime % length, weight: 1 };
    }

    case 'punch':
    case 'kick': {
      const segment = CLIPS[stance];
      const length = duration(stance);
      if (length === null || segment.impact === null || !spec) return null;
      // Wind-up is warped so the contact frame lands exactly when the rules
      // make the blow live; from there the clip runs at its own speed, and
      // once it is spent the procedural recovery takes over.
      const time =
        stanceTime < spec.windup
          ? (stanceTime / spec.windup) * segment.impact
          : segment.impact + (stanceTime - spec.windup);
      return { name: stance, time: Math.min(time, length), weight: time <= length ? 1 : 0 };
    }

    case 'jump': {
      const length = duration('jump');
      if (length === null) return null;
      const time = Math.min(length, (stanceTime / JUMP_FLIGHT_SECONDS) * length);
      return { name: 'jump', time, weight: 1 };
    }

    default:
      return null;
  }
}
