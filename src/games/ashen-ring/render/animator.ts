import * as THREE from 'three';
import type { AttackSpec, Stance } from '@domain/arena/brawler.ts';
import { clamp, lerp } from '@domain/shared/mathx.ts';
import type { ClipLibrary, SampledClip } from './clip-library.ts';
import { cueFor, type ClipName } from './clip-timing.ts';

/**
 * The animator for a Mixamo-named skeleton: procedural poses underneath,
 * recorded clips layered on top.
 *
 * Every state the fight has is authored here as joint angles and curves, so a
 * fighter is always fully posed with nothing downloaded. Where a motion
 * capture segment exists (see `clip-timing.ts`), it is blended over that pose
 * bone by bone once it has loaded, timed so its contact frame lands exactly
 * when the rules make the blow live. The animator reads the fighter's stance
 * and how long they have been in it, and writes bone rotations. It never
 * decides anything.
 *
 * ## Conventions
 *
 * Every angle is in **character space**: the model faces +z, its left is +x
 * and up is +y, and this holds whichever way the fighter is turned in the
 * world, because the whole character is rotated afterwards by its group.
 *
 * A bone's rotation is a triple of degrees `[x, y, z]`, applied in the order
 * z, then x, then y, and expressed *as if its parent were at rest*. The maths
 * that makes that true is in `apply`: the rotation is composed onto the
 * bone's rest orientation and re-expressed in its actual parent's frame. The
 * payoff is that "bend the elbow" is the same three numbers whatever the
 * shoulder is doing.
 *
 * Signs worth knowing, derived from the export's T-pose (arms out along x,
 * palms down):
 *  - arms: z lowers the arm from horizontal (left −, right +); y swings it
 *    forward (left −, right +); elbows flex with the same y signs.
 *  - legs: x negative swings the thigh forward; x positive bends the knee.
 *  - spine: x positive leans forward; y negative turns the left side forward.
 */
export const DRIVEN_BONES = [
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
] as const;

export type DrivenBone = (typeof DRIVEN_BONES)[number];
type Triple = readonly [number, number, number];
export type PoseSpec = Partial<Record<DrivenBone, Triple>>;

const OFFSET: Readonly<Record<DrivenBone, number>> = Object.fromEntries(
  DRIVEN_BONES.map((bone, index) => [bone, index * 3]),
) as Record<DrivenBone, number>;

/** What the animator needs to know about a fighter this frame. */
export interface AnimInput {
  readonly stance: Stance;
  /** Seconds in the current stance. */
  readonly time: number;
  /** +1 advancing, -1 retreating, 0 standing. */
  readonly stride: number;
  readonly attack: AttackSpec | null;
  /** How long the current stagger lasts. */
  readonly stagger: number;
}

/**
 * A full-body pose: an angle triple per driven bone, a root offset and how
 * closed the hands are. Two of these live in the animator, the target it
 * computes each frame and the current one that chases it.
 */
class Pose {
  readonly angles = new Float32Array(DRIVEN_BONES.length * 3);
  /** Root offsets in metres, character space. */
  hipsY = 0;
  hipsZ = 0;
  /** 0 open hand, 1 tight fist. */
  fist = 0;

  load(spec: PoseSpec): void {
    this.angles.fill(0);
    this.blendTo(spec, 1);
  }

  /** Moves every bone the spec names part of the way toward it. */
  blendTo(spec: PoseSpec, t: number): void {
    if (t <= 0) return;
    for (const bone of DRIVEN_BONES) {
      const wanted = spec[bone];
      if (!wanted) continue;
      const at = OFFSET[bone];
      for (let axis = 0; axis < 3; axis++) {
        const current = this.angles[at + axis] ?? 0;
        this.angles[at + axis] = current + ((wanted[axis] ?? 0) - current) * t;
      }
    }
  }

  /** Adds a scaled offset to every bone the spec names. */
  mix(spec: PoseSpec, weight: number): void {
    if (weight === 0) return;
    for (const bone of DRIVEN_BONES) {
      const delta = spec[bone];
      if (!delta) continue;
      const at = OFFSET[bone];
      for (let axis = 0; axis < 3; axis++) {
        this.angles[at + axis] = (this.angles[at + axis] ?? 0) + (delta[axis] ?? 0) * weight;
      }
    }
  }

  add(bone: DrivenBone, x: number, y: number, z: number): void {
    const at = OFFSET[bone];
    this.angles[at] = (this.angles[at] ?? 0) + x;
    this.angles[at + 1] = (this.angles[at + 1] ?? 0) + y;
    this.angles[at + 2] = (this.angles[at + 2] ?? 0) + z;
  }

  /** Frame-rate independent chase toward another pose. */
  chase(target: Pose, rate: number, dt: number): void {
    const t = 1 - Math.exp(-rate * dt);
    for (let i = 0; i < this.angles.length; i++) {
      const current = this.angles[i] ?? 0;
      this.angles[i] = current + ((target.angles[i] ?? 0) - current) * t;
    }
    this.hipsY += (target.hipsY - this.hipsY) * t;
    this.hipsZ += (target.hipsZ - this.hipsZ) * t;
    this.fist += (target.fist - this.fist) * t;
  }
}

// ------------------------------------------------------------------- poses

/** The fighting stance: bladed, lead (left) foot forward, hands up. */
const STANCE: PoseSpec = {
  Hips: [0, -18, 0],
  Spine: [2, -6, 0],
  Spine1: [4, -4, 0],
  Spine2: [6, 0, 0],
  Neck: [-2, 20, 0],
  Head: [4, 8, 0],
  LeftArm: [0, -62, -38],
  LeftForeArm: [0, -118, 0],
  LeftHand: [0, -10, 0],
  RightArm: [0, 55, 52],
  RightForeArm: [0, 132, 0],
  RightHand: [0, 10, 0],
  LeftUpLeg: [-16, 0, 5],
  LeftLeg: [20, 0, 0],
  LeftFoot: [-4, 0, 0],
  RightUpLeg: [12, -20, -6],
  RightLeg: [16, 0, 0],
  RightFoot: [-2, 0, 0],
};

/** Hands tight in front of the face, chin down, weight low. */
const GUARD: PoseSpec = {
  LeftArm: [0, -70, -45],
  LeftForeArm: [0, -140, 0],
  RightArm: [0, 62, 52],
  RightForeArm: [0, 145, 0],
  Neck: [10, 20, 0],
  Head: [8, 8, 0],
  Spine2: [10, 0, 0],
  LeftLeg: [28, 0, 0],
  RightLeg: [24, 0, 0],
};

/** The rear hand pulled back a touch before it goes. */
const PUNCH_COCKED: PoseSpec = {
  RightArm: [0, 28, 72],
  RightForeArm: [0, 135, 0],
  Hips: [0, -28, 0],
  Spine: [0, -10, 0],
};

/** A straight right: hips through, shoulder over, head still on target. */
const PUNCH_EXTENDED: PoseSpec = {
  RightShoulder: [0, 14, 0],
  RightArm: [10, 96, 8],
  RightForeArm: [0, 4, 0],
  RightHand: [0, 0, 0],
  Hips: [0, 10, 0],
  Spine: [3, 10, 0],
  Spine1: [4, 6, 0],
  Spine2: [8, 4, 0],
  Neck: [-4, -14, 0],
  Head: [2, -16, 0],
  LeftArm: [0, -60, -58],
  LeftForeArm: [0, -125, 0],
  RightUpLeg: [10, -40, -8],
  RightLeg: [10, 0, 0],
  LeftLeg: [24, 0, 0],
};

/** Knee up, foot loaded. */
const KICK_CHAMBER: PoseSpec = {
  RightUpLeg: [-78, 0, -12],
  RightLeg: [112, 0, 0],
  RightFoot: [22, 0, 0],
  Hips: [0, 4, 0],
  Spine: [-10, 6, 0],
  Spine2: [-8, 0, 0],
  LeftUpLeg: [-6, -25, 6],
  LeftLeg: [30, 0, 0],
  LeftFoot: [-8, 0, 0],
  LeftArm: [0, -30, -35],
  LeftForeArm: [0, -70, 0],
  RightArm: [0, 20, 70],
  RightForeArm: [0, 110, 0],
  Neck: [4, -6, 0],
  Head: [4, -2, 0],
};

/** The leg snapped straight, hips turned through, torso leaning away. */
const KICK_EXTENDED: PoseSpec = {
  RightUpLeg: [-92, 0, -16],
  RightLeg: [6, 0, 0],
  RightFoot: [32, 0, 0],
  Hips: [0, 22, 0],
  Spine: [-16, 8, 0],
  Spine1: [-8, 0, 0],
  Spine2: [-6, 0, 0],
  Neck: [8, -18, 0],
  Head: [6, -12, 0],
  LeftArm: [0, -20, -30],
  LeftForeArm: [0, -60, 0],
  LeftLeg: [26, 0, 0],
};

/** Added on top of whatever the body was doing when a blow lands. */
const HIT_OFFSETS: PoseSpec = {
  Spine: [-14, 0, 0],
  Spine1: [-10, 0, 0],
  Spine2: [-8, 0, 0],
  Neck: [-24, 0, 0],
  Head: [-12, -10, 0],
  LeftArm: [0, 28, -22],
  RightArm: [0, -28, 22],
  LeftForeArm: [0, 50, 0],
  RightForeArm: [0, -50, 0],
  LeftUpLeg: [8, 0, 0],
  RightLeg: [14, 0, 0],
};

/** Flat on the back, head away from the foe, arms out. */
const LYING: PoseSpec = {
  Hips: [-86, 0, 0],
  Spine: [-6, 0, 0],
  Spine1: [-4, 0, 0],
  Spine2: [0, 0, 0],
  Neck: [-14, 0, 0],
  Head: [-6, 0, 0],
  // Arms nearly flat: on a body lying on its back, the T-pose *is* the floor.
  LeftArm: [0, -6, -10],
  LeftForeArm: [0, -22, 0],
  RightArm: [0, 6, 10],
  RightForeArm: [0, 22, 0],
  LeftUpLeg: [-22, 0, 8],
  LeftLeg: [34, 0, 0],
  LeftFoot: [10, 0, 0],
  RightUpLeg: [-14, 0, -8],
  RightLeg: [26, 0, 0],
  RightFoot: [10, 0, 0],
};

/** Knees drawn up, arms in, for the arc of a jump. */
const JUMP_TUCK: PoseSpec = {
  LeftUpLeg: [-38, 0, 8],
  LeftLeg: [70, 0, 0],
  LeftFoot: [20, 0, 0],
  RightUpLeg: [-28, -10, -8],
  RightLeg: [60, 0, 0],
  RightFoot: [20, 0, 0],
  LeftArm: [0, -45, -25],
  LeftForeArm: [0, -100, 0],
  RightArm: [0, 40, 30],
  RightForeArm: [0, 110, 0],
  Spine: [8, -6, 0],
  Spine2: [6, 0, 0],
};

/** The flying kick: rear leg out and down, the other tucked. */
const AIR_KICK: PoseSpec = {
  RightUpLeg: [-75, 0, -14],
  RightLeg: [8, 0, 0],
  RightFoot: [30, 0, 0],
  LeftUpLeg: [-30, 0, 8],
  LeftLeg: [80, 0, 0],
  LeftFoot: [15, 0, 0],
  Hips: [0, 18, 0],
  Spine: [-14, 8, 0],
  Spine1: [-6, 0, 0],
  Neck: [8, -16, 0],
  Head: [6, -10, 0],
  LeftArm: [0, -25, -30],
  LeftForeArm: [0, -60, 0],
  RightArm: [0, 20, 65],
  RightForeArm: [0, 90, 0],
};

/** Dropped into a deep squat on the lead leg, rear hand to the floor. */
const SWEEP_CROUCH: PoseSpec = {
  Hips: [0, -10, 0],
  Spine: [22, 0, 0],
  Spine1: [8, 0, 0],
  Spine2: [6, 0, 0],
  Neck: [-14, 12, 0],
  Head: [-8, 6, 0],
  LeftUpLeg: [-100, 0, 12],
  LeftLeg: [128, 0, 0],
  LeftFoot: [-25, 0, 0],
  RightUpLeg: [-20, -20, -14],
  RightLeg: [60, 0, 0],
  RightFoot: [10, 0, 0],
  LeftArm: [0, -45, -35],
  LeftForeArm: [0, -90, 0],
  RightArm: [0, 15, 75],
  RightForeArm: [0, 40, 0],
};

/** The rear leg swung straight through, low. */
const SWEEP_EXTENDED: PoseSpec = {
  Hips: [0, 28, 0],
  Spine: [26, 10, 0],
  RightUpLeg: [-82, 0, -24],
  RightLeg: [6, 0, 0],
  RightFoot: [30, 0, 0],
  Neck: [-14, -20, 0],
  Head: [-8, -12, 0],
  LeftArm: [0, -30, -20],
};

/** Dipped and loaded, rear hand low. */
const UPPERCUT_COCKED: PoseSpec = {
  RightArm: [0, 25, 82],
  RightForeArm: [0, 95, 0],
  Hips: [0, -32, 0],
  Spine: [14, -10, 0],
  Spine1: [8, 0, 0],
  LeftLeg: [34, 0, 0],
  RightLeg: [30, 0, 0],
  LeftUpLeg: [-22, 0, 5],
  RightUpLeg: [6, -20, -6],
  Neck: [-8, 30, 0],
  Head: [0, 12, 0],
};

/** Driven up through the target, body rising with it. */
const UPPERCUT_EXTENDED: PoseSpec = {
  RightShoulder: [0, 12, -10],
  RightArm: [0, 80, -30],
  RightForeArm: [0, 55, 0],
  RightHand: [0, 0, 0],
  Hips: [0, 14, 0],
  Spine: [-8, 10, 0],
  Spine1: [-4, 4, 0],
  Spine2: [-4, 0, 0],
  Neck: [-6, -16, 0],
  Head: [-4, -8, 0],
  LeftArm: [0, -55, -45],
  LeftForeArm: [0, -120, 0],
  LeftLeg: [12, 0, 0],
  RightLeg: [8, 0, 0],
  RightUpLeg: [4, -35, -6],
};

/** Arms pumping, guard dropped, body leaning into the sprint. */
const RUN_ARMS: PoseSpec = {
  LeftArm: [0, -40, -70],
  RightArm: [0, 40, 70],
  LeftForeArm: [0, -95, 0],
  RightForeArm: [0, 95, 0],
};

/** Standing height of the hips in the stance, below the rest height. */
const STANCE_CROUCH = -0.05;
/** How far the hips drop when lying down. The rest hips sit 0.97 m up. */
const LYING_DROP = -0.83;
const FALL_SECONDS = 0.7;

/** Finger curl per segment, in degrees about the hand's z, for a fist. */
const FINGER_CURL: readonly number[] = [62, 78, 55];
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'] as const;
const THUMB_CURL: readonly Triple[] = [
  [0, 38, -22],
  [0, 25, -18],
  [0, 15, -10],
];

interface Driven {
  readonly bone: THREE.Object3D;
  /** Inverse of the parent's rest orientation, in character space. */
  readonly pre: THREE.Quaternion;
  /** The bone's own rest orientation, in character space. */
  readonly post: THREE.Quaternion;
}

/** How long a switch between two recorded clips takes to cross over. */
const CLIP_FADE = 0.12;
/** How fast the recorded layer fades in over, or out to, the procedural pose. */
const CLIP_WEIGHT_RATE = 14;

export class SkeletonAnimator {
  private readonly target = new Pose();
  private readonly current = new Pose();
  private readonly driven: (Driven | null)[] = [];
  /** Finger segments, with their curl axis sign and segment index. */
  private readonly fingers: { driven: Driven; sign: 1 | -1; curl: Triple }[] = [];
  private readonly hips: THREE.Object3D | null;
  private readonly hipsRest = new THREE.Vector3();

  /** Every bone by name, with its rest rotation, for the recorded layer. */
  private readonly bones = new Map<string, THREE.Object3D>();
  private readonly restLocal = new Map<string, THREE.Quaternion>();
  /** Bones the procedural pass writes; anything else starts from rest. */
  private readonly procedural = new Set<THREE.Object3D>();
  /** Per-bone scratch for crossfading one clip into another. */
  private readonly blend = new Map<string, THREE.Quaternion>();
  private clipWeight = 0;
  private clipName: ClipName | null = null;
  private clip: SampledClip | null = null;
  private clipTime = 0;
  private fading: { clip: SampledClip; time: number; left: number } | null = null;

  private readonly euler = new THREE.Euler();
  private readonly quat = new THREE.Quaternion();

  /**
   * @param model the character, in its rest pose and at the origin. The rest
   *   orientations are read once here, so it must not have been posed yet.
   * @param seed offsets the idle sway so two fighters never breathe in step.
   * @param clips the recorded segments, if any. Null keeps everything procedural.
   */
  constructor(
    model: THREE.Object3D,
    private readonly seed: number,
    private readonly clips: ClipLibrary | null = null,
  ) {
    model.updateMatrixWorld(true);
    const bones = this.bones;
    model.traverse((object) => {
      if (object.type !== 'Bone') return;
      bones.set(object.name, object);
      this.restLocal.set(object.name, object.quaternion.clone());
      this.blend.set(object.name, new THREE.Quaternion());
    });

    for (const name of DRIVEN_BONES) this.driven.push(prepare(bones.get(name)));

    for (const side of ['Left', 'Right'] as const) {
      const sign: 1 | -1 = side === 'Left' ? -1 : 1;
      for (const finger of FINGERS) {
        for (let segment = 1; segment <= 3; segment++) {
          const driven = prepare(bones.get(`${side}Hand${finger}${segment}`));
          if (!driven) continue;
          const curl = FINGER_CURL[segment - 1] ?? 0;
          this.fingers.push({ driven, sign, curl: [0, 0, curl] });
        }
      }
      for (let segment = 1; segment <= 3; segment++) {
        const driven = prepare(bones.get(`${side}HandThumb${segment}`));
        const curl = THUMB_CURL[segment - 1];
        if (!driven || !curl) continue;
        this.fingers.push({ driven, sign, curl });
      }
    }

    this.hips = bones.get('Hips') ?? null;
    if (this.hips) this.hipsRest.copy(this.hips.position);

    for (const driven of this.driven) if (driven) this.procedural.add(driven.bone);
    for (const finger of this.fingers) this.procedural.add(finger.driven.bone);

    this.current.load(STANCE);
    this.current.hipsY = STANCE_CROUCH;
    this.current.fist = 0.85;
  }

  /** Computes this frame's pose and writes it to the bones. */
  update(input: AnimInput, dt: number): void {
    const { target } = this;
    target.load(STANCE);
    target.hipsY = STANCE_CROUCH;
    target.hipsZ = 0;
    target.fist = 0.85;

    let rate = 12;
    switch (input.stance) {
      case 'idle':
        this.breathe(input.time);
        break;
      case 'walk':
        this.locomote(input.time, input.stride, false);
        break;
      case 'run':
        this.locomote(input.time, input.stride, true);
        break;
      case 'guard':
        target.blendTo(GUARD, 1);
        target.hipsY -= 0.06;
        target.fist = 1;
        rate = 22;
        break;
      case 'jump':
        target.blendTo(JUMP_TUCK, smoothstep(input.time / 0.18));
        target.hipsY = 0;
        rate = 18;
        break;
      case 'punch':
        this.punch(input.time, input.attack);
        rate = 30;
        break;
      case 'kick':
        this.kick(input.time, input.attack);
        rate = 30;
        break;
      case 'air-kick':
        target.blendTo(JUMP_TUCK, 1);
        target.blendTo(AIR_KICK, smoothstep(input.time / (input.attack?.windup ?? 0.1)));
        target.hipsY = 0;
        target.fist = 1;
        rate = 30;
        break;
      case 'sweep':
        this.sweep(input.time, input.attack);
        rate = 30;
        break;
      case 'uppercut':
        this.uppercut(input.time, input.attack);
        rate = 30;
        break;
      case 'hit':
        this.flinch(input.time, input.stagger);
        rate = 30;
        break;
      case 'knockdown':
        this.fall(input.time);
        rate = 26;
        break;
    }

    this.current.chase(target, rate, dt);
    this.apply();
    this.layerClip(input, dt);
  }

  // -------------------------------------------------------- recorded layer

  /**
   * Blends the stance's recorded clip, if there is one and it has loaded,
   * over the procedural pose just written.
   *
   * Three blends happen here. The layer's weight eases in and out, so a state
   * with a recording fades from the procedural pose rather than snapping.
   * Switching between two recordings crossfades the old, frozen at its last
   * frame, into the new. And within a looping clip the seam is blended by the
   * clip itself.
   */
  private layerClip(input: AnimInput, dt: number): void {
    const { clips } = this;
    if (!clips) return;

    const cue = cueFor(input.stance, input.time, input.attack, (name) => clips.duration(name));
    const clip = cue ? clips.get(cue.name) : null;
    if (cue && clip) {
      if (this.clip && this.clipName !== cue.name) {
        this.fading = { clip: this.clip, time: this.clipTime, left: CLIP_FADE };
      }
      this.clip = clip;
      this.clipName = cue.name;
      this.clipTime = cue.time;
    }

    const wanted = cue && clip ? cue.weight : 0;
    this.clipWeight += (wanted - this.clipWeight) * (1 - Math.exp(-CLIP_WEIGHT_RATE * dt));
    if (this.fading) this.fading.left -= dt;
    if (this.fading && this.fading.left <= 0) this.fading = null;

    const weight = this.clipWeight;
    const current = this.clip;
    if (!current || weight < 0.002) return;

    // The clip being left, frozen where it was, so the new one can be mixed in.
    const fading = this.fading;
    const mix = fading ? 1 - fading.left / CLIP_FADE : 1;
    if (fading) {
      fading.clip.sample(fading.time, (bone, rotation) => {
        this.blend.get(bone)?.copy(rotation);
      });
    }

    const hipsY = current.sample(this.clipTime, (bone, rotation) => {
      const object = this.bones.get(bone);
      if (!object) return;
      let wanted: THREE.Quaternion = rotation;
      if (fading) {
        const previous = this.blend.get(bone);
        if (previous) wanted = previous.slerp(rotation, mix);
      }
      // A bone the procedural pass never touches would otherwise keep its
      // last recorded rotation forever; it blends from rest instead.
      if (!this.procedural.has(object)) {
        const rest = this.restLocal.get(bone);
        if (rest) object.quaternion.copy(rest);
      }
      object.quaternion.slerp(wanted, weight);
    });

    if (this.hips && hipsY !== null && current.segment.hipsHeight) {
      this.hips.position.y += (hipsY - this.hips.position.y) * weight;
    }
  }

  // ------------------------------------------------------------- states

  private breathe(t: number): void {
    const { target } = this;
    const phase = t * 2.6 + this.seed;
    const breath = Math.sin(phase);
    target.add('Spine2', 1.8 * breath, 0, 0);
    target.add('LeftArm', 0, 0, -1.5 * breath);
    target.add('RightArm', 0, 0, 1.5 * breath);
    target.add('Head', 0, 2 * Math.sin(t * 0.9 + this.seed), 0);
    target.add('Hips', 0, 0, 1.5 * Math.sin(t * 1.1 + this.seed));
    // The small bounce every fighter in the genre has.
    target.hipsY += 0.01 * breath - 0.01 + 0.012 * Math.sin(t * 4.2 + this.seed);
  }

  private locomote(t: number, stride: number, running: boolean): void {
    const { target } = this;
    const frequency = running ? 2.75 : 1.85;
    const phase = Math.PI * 2 * frequency * t * (stride < 0 ? -1 : 1);
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const swing = running ? 38 : 20;
    const lift = running ? 78 : 42;

    // Thighs swing in opposite phase; a knee bends while its leg comes forward.
    const leftThigh = -swing * s;
    const rightThigh = swing * s;
    const leftKnee = lift * Math.max(0, -c);
    const rightKnee = lift * Math.max(0, c);
    target.add('LeftUpLeg', leftThigh, 0, 0);
    target.add('RightUpLeg', rightThigh, 0, 0);
    target.add('LeftLeg', leftKnee, 0, 0);
    target.add('RightLeg', rightKnee, 0, 0);
    // Feet stay roughly level with the floor.
    target.add('LeftFoot', -(leftThigh + leftKnee) * 0.5, 0, 0);
    target.add('RightFoot', -(rightThigh + rightKnee) * 0.5, 0, 0);

    const bob = running ? 0.05 : 0.025;
    target.hipsY += bob * (Math.abs(c) - 1);
    target.add('Hips', 0, -(running ? 8 : 4) * s, 0);
    target.add('Spine', 0, 4 * s, 0);

    if (running) {
      target.blendTo(RUN_ARMS, 1);
      target.add('LeftArm', 0, 30 * s, 0);
      target.add('RightArm', 0, 30 * s, 0);
      target.add('Spine', 14, 0, 0);
      target.add('Spine2', 6, 0, 0);
      target.add('Head', -10, 0, 0);
      target.hipsZ += 0.06;
    } else {
      target.add('LeftArm', 0, 8 * s, 0);
      target.add('RightArm', 0, 8 * s, 0);
    }
  }

  private punch(t: number, spec: AttackSpec | null): void {
    if (!spec) return;
    const { target } = this;
    const { windup, active, recovery } = spec;

    // A small pull-back that peaks mid wind-up, then the shot itself, which
    // stays slow for the first half and snaps out over the second.
    const cock = t < windup ? Math.sin(Math.PI * clamp(t / windup, 0, 1)) : 0;
    let extend: number;
    if (t < windup) extend = Math.pow(t / windup, 2.2);
    else if (t < windup + active) extend = 1;
    else extend = 1 - smoothstep((t - windup - active) / recovery);

    target.blendTo(PUNCH_COCKED, cock * (1 - extend));
    target.blendTo(PUNCH_EXTENDED, extend);
    target.hipsZ += 0.1 * extend;
    target.hipsY -= 0.03 * extend;
    target.fist = 1;
  }

  private kick(t: number, spec: AttackSpec | null): void {
    if (!spec) return;
    const { target } = this;
    const { windup, active, recovery } = spec;
    const end = windup + active;

    const chamber = smoothstep(clamp(t / (windup * 0.62), 0, 1));
    let extend: number;
    if (t < windup) extend = smoothstep(clamp((t - windup * 0.45) / (windup * 0.55), 0, 1));
    else if (t < end) extend = 1;
    else extend = 1 - smoothstep((t - end) / (recovery * 0.75));
    // The leg comes down over the whole recovery.
    const up = t < end ? 1 : 1 - smoothstep((t - end) / recovery);

    target.blendTo(KICK_CHAMBER, chamber * up);
    target.blendTo(KICK_EXTENDED, extend * up);
    target.hipsY -= 0.06 * up;
    target.hipsZ += 0.05 * extend * up;
    target.fist = 1;
  }

  private sweep(t: number, spec: AttackSpec | null): void {
    if (!spec) return;
    const { target } = this;
    const { windup, active, recovery } = spec;
    const end = windup + active;

    const crouch = smoothstep(clamp(t / (windup * 0.6), 0, 1));
    let swing: number;
    if (t < windup) swing = smoothstep(clamp((t - windup * 0.4) / (windup * 0.6), 0, 1));
    else if (t < end) swing = 1;
    else swing = 1 - smoothstep((t - end) / (recovery * 0.7));
    // The body comes back up over the whole recovery.
    const low = t < end ? 1 : 1 - smoothstep((t - end) / recovery);

    target.blendTo(SWEEP_CROUCH, crouch * low);
    target.blendTo(SWEEP_EXTENDED, swing * low);
    target.hipsY -= 0.5 * crouch * low;
    target.hipsZ += 0.06 * swing * low;
    target.fist = 1;
  }

  private uppercut(t: number, spec: AttackSpec | null): void {
    if (!spec) return;
    const { target } = this;
    const { windup, active, recovery } = spec;

    const cocked = t < windup ? smoothstep(clamp(t / (windup * 0.6), 0, 1)) : 0;
    let drive: number;
    if (t < windup) drive = Math.pow(clamp((t - windup * 0.4) / (windup * 0.6), 0, 1), 2);
    else if (t < windup + active) drive = 1;
    else drive = 1 - smoothstep((t - windup - active) / recovery);

    target.blendTo(UPPERCUT_COCKED, cocked * (1 - drive));
    target.blendTo(UPPERCUT_EXTENDED, drive);
    target.hipsY -= 0.14 * cocked * (1 - drive);
    target.hipsY += 0.05 * drive;
    target.hipsZ += 0.06 * drive;
    target.fist = 1;
  }

  private flinch(t: number, stagger: number): void {
    const { target } = this;
    const rise = 0.07;
    const r = t < rise ? t / rise : 1 - smoothstep((t - rise) / Math.max(0.1, stagger - rise));
    target.mix(HIT_OFFSETS, r);
    target.hipsZ -= 0.12 * r;
    target.hipsY -= 0.02 * r;
    target.fist = lerp(0.85, 0.5, r);
  }

  private fall(t: number): void {
    const { target } = this;
    const u = smoothstep(clamp(t / FALL_SECONDS, 0, 1));
    const flinch = clamp(t / 0.1, 0, 1) * (1 - u);
    target.mix(HIT_OFFSETS, flinch * 1.3);
    target.blendTo(LYING, u);

    let drop = lerp(STANCE_CROUCH, LYING_DROP, u);
    const bounceAt = t - FALL_SECONDS;
    if (bounceAt > 0 && bounceAt < 0.28) drop += Math.sin((Math.PI * bounceAt) / 0.28) * 0.05;
    target.hipsY = drop;
    target.hipsZ = -0.35 * u;
    target.fist = lerp(0.85, 0.15, u);
  }

  // ---------------------------------------------------------------- apply

  private apply(): void {
    const { current, euler, quat } = this;
    for (let i = 0; i < DRIVEN_BONES.length; i++) {
      const driven = this.driven[i];
      if (!driven) continue;
      const at = i * 3;
      euler.set(
        THREE.MathUtils.degToRad(current.angles[at] ?? 0),
        THREE.MathUtils.degToRad(current.angles[at + 1] ?? 0),
        THREE.MathUtils.degToRad(current.angles[at + 2] ?? 0),
        'YXZ',
      );
      quat.setFromEuler(euler);
      // inverse(parent rest) * R * (own rest): R in character space, expressed
      // in the parent's frame, on top of the bone's rest orientation.
      driven.bone.quaternion.copy(driven.pre).multiply(quat).multiply(driven.post);
    }

    for (const finger of this.fingers) {
      const f = current.fist;
      euler.set(
        THREE.MathUtils.degToRad(finger.curl[0] * f),
        THREE.MathUtils.degToRad(finger.curl[1] * f * -finger.sign),
        THREE.MathUtils.degToRad(finger.curl[2] * f * finger.sign),
        'YXZ',
      );
      quat.setFromEuler(euler);
      finger.driven.bone.quaternion.copy(finger.driven.pre).multiply(quat).multiply(finger.driven.post);
    }

    if (this.hips) {
      this.hips.position.set(
        this.hipsRest.x,
        this.hipsRest.y + current.hipsY,
        this.hipsRest.z + current.hipsZ,
      );
    }
  }
}

/** Reads a bone's rest orientation and its parent's, once. */
function prepare(bone: THREE.Object3D | undefined): Driven | null {
  if (!bone?.parent) return null;
  const post = new THREE.Quaternion();
  bone.getWorldQuaternion(post);
  const pre = new THREE.Quaternion();
  bone.parent.getWorldQuaternion(pre);
  pre.invert();
  return { bone, pre, post };
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}
