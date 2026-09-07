import type { ActionName } from './actions.ts';
import { windowFeature } from './features.ts';
import type { PoseSnapshot } from './landmarks.ts';
import type { Sample } from './dataset.ts';

/**
 * The take: a countdown, then a capture window, then a sample.
 *
 * A state machine fed time rather than a pile of timers, for the same reason
 * the fight's rounds are: it can be tested end to end without a camera, and
 * it cannot get stuck in a state nothing is left to leave.
 */
export type TakePhase = 'ready' | 'counting' | 'capturing' | 'done';

export interface TakeState {
  readonly phase: TakePhase;
  readonly action: ActionName | null;
  /** Whole seconds left on the countdown, for the big number on screen. */
  readonly countdown: number;
  /** 0..1 through the capture. */
  readonly progress: number;
}

export interface TakeResult {
  readonly sample: Sample | null;
  /** Why nothing was recorded, when nothing was. */
  readonly problem: string | null;
}

/** Seconds of "get ready" before a capture starts. */
export const COUNTDOWN_SECONDS = 3;
/** Seconds a struck gesture is captured over. */
export const CAPTURE_SECONDS = 1.0;
/** A held pose needs less: it is not going anywhere. */
export const HELD_CAPTURE_SECONDS = 0.7;

export class TakeRecorder {
  private phase: TakePhase = 'ready';
  private action: ActionName | null = null;
  private held = false;
  private left = 0;
  private frames: PoseSnapshot[] = [];

  get state(): TakeState {
    const total = this.held ? HELD_CAPTURE_SECONDS : CAPTURE_SECONDS;
    return {
      phase: this.phase,
      action: this.action,
      countdown: this.phase === 'counting' ? Math.ceil(this.left) : 0,
      progress: this.phase === 'capturing' ? 1 - Math.max(0, this.left) / total : 0,
    };
  }

  get recording(): boolean {
    return this.phase === 'counting' || this.phase === 'capturing';
  }

  /** Starts a take. Ignored if one is already running. */
  begin(action: ActionName, held: boolean): void {
    if (this.recording) return;
    this.action = action;
    this.held = held;
    this.phase = 'counting';
    this.left = COUNTDOWN_SECONDS;
    this.frames = [];
  }

  cancel(): void {
    this.phase = 'ready';
    this.action = null;
    this.frames = [];
    this.left = 0;
  }

  /**
   * Advances the take and collects frames.
   *
   * @param snapshot the newest tracking frame, or null if the tracker has
   *   lost the body this frame.
   * @returns a sample on the frame the capture completes, and nothing on
   *   every other frame.
   */
  tick(dt: number, snapshot: PoseSnapshot | null): TakeResult {
    if (this.phase === 'counting') {
      this.left -= dt;
      if (this.left <= 0) {
        this.phase = 'capturing';
        this.left = this.held ? HELD_CAPTURE_SECONDS : CAPTURE_SECONDS;
        this.frames = [];
      }
      return NOTHING;
    }

    if (this.phase !== 'capturing') return NOTHING;

    if (snapshot) this.frames.push(snapshot);
    this.left -= dt;
    if (this.left > 0) return NOTHING;

    const action = this.action;
    this.phase = 'done';
    this.action = null;

    if (!action) return { sample: null, problem: 'Nothing was being recorded.' };
    if (this.frames.length < 4) {
      return { sample: null, problem: 'The camera lost you during that take. Try again.' };
    }
    const features = windowFeature(this.frames);
    if (!features) {
      return { sample: null, problem: 'Could not read a full body in that take. Step back and retry.' };
    }
    return {
      sample: { action, features: Array.from(features), atMs: Date.now() },
      problem: null,
    };
  }
}

const NOTHING: TakeResult = { sample: null, problem: null };
