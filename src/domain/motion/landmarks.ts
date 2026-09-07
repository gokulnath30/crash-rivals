/**
 * The body as a camera reports it.
 *
 * MediaPipe's pose landmarker returns thirty-three points; this names the
 * ones any of our code reads and fixes the axes they arrive in, so nothing
 * downstream has to remember which way is up.
 */

/** A point in space. Metres for world landmarks, 0..1 for image ones. */
export type Triple = readonly [number, number, number];

/** One frame of tracking, already converted into our axes. */
export interface PoseSnapshot {
  /**
   * Thirty-three world landmarks in metres, origin between the hips, in the
   * game's axes: x right, y up, z toward the camera.
   */
  readonly world: readonly Triple[];
  /** The same points in image space, 0..1 across the video, for drawing. */
  readonly image: readonly Triple[];
  /** How sure the tracker is of each point, 0..1, same order. */
  readonly visibility: readonly number[];
  readonly atMs: number;
}

/** Indices into a landmark array, by the name the body knows them as. */
export const LANDMARK = {
  nose: 0,
  eyeL: 2,
  eyeR: 5,
  earL: 7,
  earR: 8,
  shoulderL: 11,
  shoulderR: 12,
  elbowL: 13,
  elbowR: 14,
  wristL: 15,
  wristR: 16,
  hipL: 23,
  hipR: 24,
  kneeL: 25,
  kneeR: 26,
  ankleL: 27,
  ankleR: 28,
  heelL: 29,
  heelR: 30,
  footL: 31,
  footR: 32,
} as const;

/** How many landmarks a usable reading must carry. */
export const REQUIRED_LANDMARKS = 29;

/**
 * Below this a landmark is the model guessing rather than seeing.
 *
 * A pose model returns all thirty-three points whether or not it can see
 * them: stand too close and it will still report your ankles, by invention.
 * Following that guess is what puts a character face-down with its legs in
 * the air.
 */
export const MIN_VISIBILITY = 0.5;

/** The bones drawn over the camera preview, as landmark index pairs. */
export const POSE_LINKS: readonly (readonly [number, number])[] = [
  // Face
  [0, 2],
  [0, 5],
  [2, 7],
  [5, 8],
  // Arms
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  // Torso
  [11, 12],
  [11, 23],
  [12, 24],
  [23, 24],
  // Legs
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
  [27, 29],
  [29, 31],
  [28, 30],
  [30, 32],
];

/** The 21 points of a tracked hand, wrist first. */
export const HAND_LINKS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

/** Whether a snapshot carries enough of a body to be worth reading. */
export function isUsable(snapshot: PoseSnapshot): boolean {
  if (snapshot.world.length < REQUIRED_LANDMARKS) return false;
  for (const index of [LANDMARK.shoulderL, LANDMARK.shoulderR, LANDMARK.hipL, LANDMARK.hipR]) {
    if ((snapshot.visibility[index] ?? 1) < MIN_VISIBILITY) return false;
  }
  return true;
}

/** The midpoint of two landmarks. */
export function midpoint(points: readonly Triple[], a: number, b: number): Triple {
  const first = points[a];
  const second = points[b];
  if (!first || !second) return [0, 0, 0];
  return [
    (first[0] + second[0]) / 2,
    (first[1] + second[1]) / 2,
    (first[2] + second[2]) / 2,
  ];
}
