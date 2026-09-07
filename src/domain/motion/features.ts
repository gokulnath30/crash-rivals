import { LANDMARK, midpoint, type PoseSnapshot, type Triple } from './landmarks.ts';

/**
 * Turning tracked bodies into numbers a classifier can learn from.
 *
 * Everything here exists to remove the things that should not change the
 * answer. Where you stand, how tall you are and which way you have turned are
 * all facts about the room, not about the action — so a pose is moved to the
 * origin, divided by the length of its own torso, and turned to face front
 * before a single number is kept. What is left is the shape of the body.
 *
 * A single frame cannot tell a punch from a hand held out, so the unit a
 * classifier sees is a short *window* of frames, resampled to a fixed number
 * of key frames and laid end to end. Movement is then simply the difference
 * between one key frame and the next, which the classifier can see for
 * itself.
 */

/** The joints that carry the meaning of a fighting action. */
export const KEY_JOINTS: readonly number[] = [
  LANDMARK.nose,
  LANDMARK.shoulderL,
  LANDMARK.shoulderR,
  LANDMARK.elbowL,
  LANDMARK.elbowR,
  LANDMARK.wristL,
  LANDMARK.wristR,
  LANDMARK.hipL,
  LANDMARK.hipR,
  LANDMARK.kneeL,
  LANDMARK.kneeR,
  LANDMARK.ankleL,
  LANDMARK.ankleR,
];

/** How many frames a window is boiled down to. */
export const KEY_FRAMES = 6;

/** Numbers in one pose, and in a whole window. */
export const POSE_DIMENSIONS = KEY_JOINTS.length * 3;
export const FEATURE_DIMENSIONS = POSE_DIMENSIONS * KEY_FRAMES;

/** How long a window of movement is, in seconds. */
export const WINDOW_SECONDS = 0.7;

/**
 * Below this the torso is too short to divide by — the person is side-on, or
 * tracking has lost them.
 */
const MIN_TORSO = 0.05;

/**
 * One pose in a canonical frame: hips at the origin, torso one unit long,
 * shoulders square to the camera.
 *
 * Returns null when the pose cannot be canonicalised, which is the honest
 * answer for a body the tracker is guessing at.
 */
export function normalisePose(world: readonly Triple[]): Float64Array | null {
  const hips = midpoint(world, LANDMARK.hipL, LANDMARK.hipR);
  const shoulders = midpoint(world, LANDMARK.shoulderL, LANDMARK.shoulderR);

  const torso = Math.hypot(
    shoulders[0] - hips[0],
    shoulders[1] - hips[1],
    shoulders[2] - hips[2],
  );
  if (!Number.isFinite(torso) || torso < MIN_TORSO) return null;

  // The shoulder line gives the direction the body faces; undoing its yaw
  // makes the same action recorded at an angle look like the same action.
  const left = world[LANDMARK.shoulderL];
  const right = world[LANDMARK.shoulderR];
  if (!left || !right) return null;
  const spanX = left[0] - right[0];
  const spanZ = left[2] - right[2];
  const span = Math.hypot(spanX, spanZ);
  // Facing straight up or down the camera axis leaves no yaw to read; the
  // identity rotation is then the least wrong choice.
  const cos = span > 1e-4 ? spanX / span : 1;
  const sin = span > 1e-4 ? spanZ / span : 0;

  const out = new Float64Array(POSE_DIMENSIONS);
  for (const [slot, index] of KEY_JOINTS.entries()) {
    const point = world[index];
    if (!point) return null;
    const x = point[0] - hips[0];
    const y = point[1] - hips[1];
    const z = point[2] - hips[2];
    // Rotate by -yaw about the vertical axis.
    const at = slot * 3;
    out[at] = (x * cos + z * sin) / torso;
    out[at + 1] = y / torso;
    out[at + 2] = (-x * sin + z * cos) / torso;
  }
  return out;
}

/**
 * Picks `KEY_FRAMES` poses evenly across a window of snapshots and lays them
 * end to end.
 *
 * Resampled by *time* rather than by index, so a window recorded on a slow
 * laptop and one recorded on a fast desktop describe the same movement.
 * Returns null if any frame in the window cannot be canonicalised.
 */
export function windowFeature(frames: readonly PoseSnapshot[]): Float64Array | null {
  if (frames.length === 0) return null;
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last) return null;

  const span = last.atMs - first.atMs;
  const out = new Float64Array(FEATURE_DIMENSIONS);

  for (let k = 0; k < KEY_FRAMES; k++) {
    const wanted = first.atMs + (span * k) / Math.max(1, KEY_FRAMES - 1);
    const frame = nearestInTime(frames, wanted);
    const pose = normalisePose(frame.world);
    if (!pose) return null;
    out.set(pose, k * POSE_DIMENSIONS);
  }
  return out;
}

/** The frame whose timestamp is closest to `atMs`. */
function nearestInTime(frames: readonly PoseSnapshot[], atMs: number): PoseSnapshot {
  let best = frames[0] as PoseSnapshot;
  let bestGap = Math.abs(best.atMs - atMs);
  for (const frame of frames) {
    const gap = Math.abs(frame.atMs - atMs);
    if (gap < bestGap) {
      best = frame;
      bestGap = gap;
    }
  }
  return best;
}

/** Straight-line distance between two feature vectors. */
export function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    total += delta * delta;
  }
  return Math.sqrt(total);
}

/**
 * Keeps the last `WINDOW_SECONDS` of frames, so the newest window is always
 * ready to classify.
 */
export class PoseWindow {
  private readonly frames: PoseSnapshot[] = [];

  constructor(private readonly seconds: number = WINDOW_SECONDS) {}

  push(snapshot: PoseSnapshot): void {
    this.frames.push(snapshot);
    const cutoff = snapshot.atMs - this.seconds * 1000;
    while (this.frames.length > 0 && (this.frames[0] as PoseSnapshot).atMs < cutoff) {
      this.frames.shift();
    }
  }

  /** True once the window covers enough time to describe a movement. */
  get full(): boolean {
    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    if (!first || !last) return false;
    return this.frames.length >= KEY_FRAMES && last.atMs - first.atMs >= this.seconds * 700;
  }

  get size(): number {
    return this.frames.length;
  }

  /** The frames themselves, oldest first. */
  contents(): readonly PoseSnapshot[] {
    return this.frames;
  }

  feature(): Float64Array | null {
    return this.full ? windowFeature(this.frames) : null;
  }

  clear(): void {
    this.frames.length = 0;
  }
}
