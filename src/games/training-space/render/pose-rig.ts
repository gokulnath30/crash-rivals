import * as THREE from 'three';
import { LANDMARK, midpoint, MIN_VISIBILITY, type PoseSnapshot, type Triple } from '@domain/motion/landmarks.ts';

/**
 * A skinned character driven straight from camera landmarks.
 *
 * ## How the retarget works
 *
 * The tracker gives joint *positions*. A skeleton needs bone *rotations*. The
 * bridge is that a bone's job is to point at its child: for each mapped bone
 * we take the direction its child sits in at rest, take the direction the
 * corresponding pair of tracked points sit in now, and rotate the bone by the
 * difference.
 *
 * Matching directions rather than copying rotations is what makes this work
 * against an arbitrary export: the model is in a T-pose and the person in
 * front of the camera is not, and neither has to know about the other. It
 * ignores twist along the bone's own axis, which is invisible on a forearm
 * and not worth the cost of solving.
 *
 * Bones are processed root-first, because a bone's rotation is expressed
 * relative to its parent and the parent must already be in its final pose.
 */

/** The joints the retarget works in, derived from the raw landmarks. */
type JointName =
  | 'pelvis'
  | 'chest'
  | 'neck'
  | 'head'
  | 'shL'
  | 'elL'
  | 'wrL'
  | 'shR'
  | 'elR'
  | 'wrR'
  | 'hipL'
  | 'knL'
  | 'anL'
  | 'hipR'
  | 'knR'
  | 'anR';

type Joints = Record<JointName, Triple>;

interface Segment {
  /** The bone to rotate. */
  readonly bone: string;
  /**
   * The bone whose rest offset defines this bone's forward direction. Named
   * explicitly because several bones have more than one child — `Spine2`
   * carries the neck and both shoulders, and only the neck should steer it.
   */
  readonly child: string;
  readonly from: JointName;
  readonly to: JointName;
}

/**
 * Root-first. `Spine1` and the shoulders are deliberately left at their rest
 * pose: the tracker has no points that correspond to them, and inventing
 * rotations for them would be guessing.
 */
const SEGMENTS: readonly Segment[] = [
  { bone: 'Spine', child: 'Spine1', from: 'pelvis', to: 'chest' },
  { bone: 'Spine2', child: 'Neck', from: 'chest', to: 'neck' },
  { bone: 'Neck', child: 'Head', from: 'neck', to: 'head' },

  { bone: 'LeftArm', child: 'LeftForeArm', from: 'shL', to: 'elL' },
  { bone: 'LeftForeArm', child: 'LeftHand', from: 'elL', to: 'wrL' },
  { bone: 'RightArm', child: 'RightForeArm', from: 'shR', to: 'elR' },
  { bone: 'RightForeArm', child: 'RightHand', from: 'elR', to: 'wrR' },

  { bone: 'LeftUpLeg', child: 'LeftLeg', from: 'hipL', to: 'knL' },
  { bone: 'LeftLeg', child: 'LeftFoot', from: 'knL', to: 'anL' },
  { bone: 'RightUpLeg', child: 'RightLeg', from: 'hipR', to: 'knR' },
  { bone: 'RightLeg', child: 'RightFoot', from: 'knR', to: 'anR' },
];

const ROOT_BONE = 'Hips';

/** How fast the drawn pose chases the tracked one. Per second. */
const FOLLOW_RATE = 22;

interface Prepared {
  readonly bone: THREE.Object3D;
  readonly restQuaternion: THREE.Quaternion;
  /** Rest direction of the segment, in the bone's *parent* space. */
  readonly restDirection: THREE.Vector3;
  readonly from: JointName;
  readonly to: JointName;
}

export class PoseRig {
  readonly group = new THREE.Group();

  private readonly segments: Prepared[] = [];
  private readonly faces: { dictionary: Record<string, number>; influences: number[] }[] = [];
  /** The smoothed joint positions the bones are actually aimed at. */
  private readonly joints: Joints = blankJoints();
  /** How high the model's own hips sit when it stands straight, in metres. */
  private readonly restHipHeight: number;
  /** Smoothed hip height, so a crouch lowers the body instead of floating it. */
  private hipHeight = 0;
  private tracking = false;

  // Scratch, reused every frame so a session allocates nothing per bone.
  private readonly target = new THREE.Vector3();
  private readonly restDir = new THREE.Vector3();
  private readonly parentQuat = new THREE.Quaternion();
  private readonly groupQuat = new THREE.Quaternion();
  private readonly delta = new THREE.Quaternion();

  constructor(scene: THREE.Scene, model: THREE.Object3D) {
    model.position.set(0, 0, 0);
    model.rotation.set(0, 0, 0);
    this.group.add(model);

    const bones = new Map<string, THREE.Object3D>();
    model.traverse((object) => {
      if (object.type === 'Bone') bones.set(object.name, object);
      if (object instanceof THREE.SkinnedMesh) {
        object.castShadow = true;
        object.receiveShadow = true;
        object.frustumCulled = false; // a posed skin can leave its rest bounds
        const dictionary = object.morphTargetDictionary;
        const influences = object.morphTargetInfluences;
        if (dictionary && influences) this.faces.push({ dictionary, influences });
      }
    });

    // Sit the hips on the group's origin, so everything below is expressed
    // relative to the hips the way the tracker reports them. The group is then
    // lifted each frame to put the feet back on the floor.
    const hips = bones.get(ROOT_BONE);
    const restHips = new THREE.Vector3();
    if (hips) {
      hips.getWorldPosition(restHips);
      model.position.y -= restHips.y;
    }
    this.restHipHeight = restHips.y || 0.95;
    this.hipHeight = this.restHipHeight;
    this.group.position.y = this.restHipHeight;

    // Stand in a relaxed stance before any camera is running. A T-pose is the
    // model's rest, not a person's, and it reads as something broken.
    this.setPose(RESTING, 10);
    this.sync();
    this.tracking = false;

    for (const segment of SEGMENTS) {
      const bone = bones.get(segment.bone);
      const child = bones.get(segment.child);
      if (!bone || !child) continue;
      // `child.position` is the child's offset in this bone's own space, so
      // rotating it by the bone's rest rotation puts it in the parent's space
      // — the space the bone's own quaternion lives in.
      const restDirection = child.position.clone().applyQuaternion(bone.quaternion).normalize();
      if (restDirection.lengthSq() < 1e-8) continue;
      this.segments.push({
        bone,
        restQuaternion: bone.quaternion.clone(),
        restDirection,
        from: segment.from,
        to: segment.to,
      });
    }

    scene.add(this.group);
  }

  /** True once a real body has been seen; false while showing the rest stance. */
  get live(): boolean {
    return this.tracking;
  }

  /** Feeds a tracked body in. Ignored when the tracker is only guessing. */
  setPose(snapshot: PoseSnapshot, dt: number): void {
    const wanted = jointsFrom(snapshot);
    if (!wanted) return;
    // Eased rather than copied: the tracker is noisy frame to frame, and
    // following it verbatim gives a character that shivers.
    const t = this.tracking ? 1 - Math.exp(-FOLLOW_RATE * dt) : 1;
    this.tracking = true;
    for (const name of JOINT_NAMES) {
      const to = wanted[name];
      const at = this.joints[name] as [number, number, number];
      at[0] += (to[0] - at[0]) * t;
      at[1] += (to[1] - at[1]) * t;
      at[2] += (to[2] - at[2]) * t;
    }

    // How much of its own leg length the body is standing on. One when the
    // legs are straight, less when crouched — measured against the person's
    // own leg, so it means the same for any height.
    const wantedHeight = this.restHipHeight * legExtension(wanted);
    this.hipHeight += (wantedHeight - this.hipHeight) * t;
    this.group.position.y = this.hipHeight;
  }

  /** Applies facial blendshape weights straight from the tracker. */
  setFace(weights: Readonly<Record<string, number>> | null): void {
    for (const face of this.faces) {
      for (const [name, slot] of Object.entries(face.dictionary)) {
        const wanted = weights?.[name] ?? 0;
        const current = face.influences[slot] ?? 0;
        face.influences[slot] = current + (wanted - current) * 0.4;
      }
    }
  }

  /** Writes the smoothed joints onto the bones. Call once a frame. */
  sync(): void {
    if (!this.tracking) return;
    this.group.updateMatrixWorld(true);
    this.group.getWorldQuaternion(this.groupQuat);
    // Everything below is expressed in the group's space, which is the space
    // the tracked pose is already in.
    this.groupQuat.invert();

    for (const segment of this.segments) {
      const from = this.joints[segment.from];
      const to = this.joints[segment.to];
      this.target.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
      if (this.target.lengthSq() < 1e-8) continue;
      this.target.normalize();

      const parent = segment.bone.parent;
      if (!parent) continue;
      // The parent is already in its final pose for this frame, because
      // SEGMENTS runs root-first.
      parent.getWorldQuaternion(this.parentQuat);
      this.parentQuat.premultiply(this.groupQuat).invert();
      this.target.applyQuaternion(this.parentQuat);

      this.restDir.copy(segment.restDirection);
      this.delta.setFromUnitVectors(this.restDir, this.target);
      segment.bone.quaternion.copy(this.delta).multiply(segment.restQuaternion);
      segment.bone.updateMatrixWorld(true);
    }
  }

  /**
   * Releases only what this rig created. Emphatically *not* the model's
   * geometry: the library's cache owns that and shares it with every clone.
   */
  dispose(): void {
    this.group.removeFromParent();
    this.segments.length = 0;
    this.faces.length = 0;
  }
}

/**
 * A relaxed standing pose, in the same metres-from-the-hips the tracker
 * reports, so the character has somewhere to stand before anyone steps in
 * front of the camera.
 */
const RESTING: PoseSnapshot = (() => {
  const world: Triple[] = Array.from({ length: 33 }, () => [0, 0, 0] as Triple);
  world[LANDMARK.nose] = [0, 0.71, 0.09];
  world[LANDMARK.shoulderL] = [0.18, 0.48, 0];
  world[LANDMARK.shoulderR] = [-0.18, 0.48, 0];
  world[LANDMARK.elbowL] = [0.23, 0.22, 0.02];
  world[LANDMARK.elbowR] = [-0.23, 0.22, 0.02];
  world[LANDMARK.wristL] = [0.25, -0.04, 0.06];
  world[LANDMARK.wristR] = [-0.25, -0.04, 0.06];
  world[LANDMARK.hipL] = [0.1, 0, 0];
  world[LANDMARK.hipR] = [-0.1, 0, 0];
  world[LANDMARK.kneeL] = [0.11, -0.45, 0.01];
  world[LANDMARK.kneeR] = [-0.11, -0.45, 0.01];
  world[LANDMARK.ankleL] = [0.11, -0.88, 0];
  world[LANDMARK.ankleR] = [-0.11, -0.88, 0];
  return {
    world,
    image: [],
    visibility: Array.from({ length: 33 }, () => 1),
    atMs: 0,
  };
})();

const JOINT_NAMES: readonly JointName[] = [
  'pelvis',
  'chest',
  'neck',
  'head',
  'shL',
  'elL',
  'wrL',
  'shR',
  'elR',
  'wrR',
  'hipL',
  'knL',
  'anL',
  'hipR',
  'knR',
  'anR',
];

/** Distance between two joints. */
function span(a: Triple, b: Triple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * How far the legs are extended, 0..1: the drop from hips to the lower foot,
 * over the length of that leg. A straight leg gives one, a deep crouch about
 * a half.
 */
function legExtension(joints: Joints): number {
  const legL = span(joints.hipL, joints.knL) + span(joints.knL, joints.anL);
  const legR = span(joints.hipR, joints.knR) + span(joints.knR, joints.anR);
  const leg = Math.max(legL, legR);
  if (leg < 0.1) return 1;
  const drop = Math.max(joints.pelvis[1] - joints.anL[1], joints.pelvis[1] - joints.anR[1]);
  return Math.max(0.2, Math.min(1.1, drop / leg));
}

function blankJoints(): Joints {
  const joints = {} as Joints;
  for (const name of JOINT_NAMES) joints[name] = [0, 0, 0] as unknown as Triple;
  return joints;
}

/**
 * The sixteen joints the retarget needs, from the thirty-three the tracker
 * reports. Null when the body is not sufficiently visible to be worth drawing.
 */
function jointsFrom(snapshot: PoseSnapshot): Joints | null {
  const { world, visibility } = snapshot;
  const seen = (index: number): boolean => (visibility[index] ?? 1) >= MIN_VISIBILITY;
  for (const index of [LANDMARK.shoulderL, LANDMARK.shoulderR, LANDMARK.hipL, LANDMARK.hipR]) {
    if (!seen(index)) return null;
  }

  const at = (index: number): Triple => world[index] ?? [0, 0, 0];
  const pelvis = midpoint(world, LANDMARK.hipL, LANDMARK.hipR);
  const neck = midpoint(world, LANDMARK.shoulderL, LANDMARK.shoulderR);
  const chest: Triple = [
    pelvis[0] + (neck[0] - pelvis[0]) * 0.55,
    pelvis[1] + (neck[1] - pelvis[1]) * 0.55,
    pelvis[2] + (neck[2] - pelvis[2]) * 0.55,
  ];

  // A limb the tracker cannot see holds still rather than following a guess.
  const limb = (index: number, fallback: Triple): Triple => (seen(index) ? at(index) : fallback);

  return {
    pelvis,
    chest,
    neck,
    head: seen(LANDMARK.nose) ? at(LANDMARK.nose) : [neck[0], neck[1] + 0.2, neck[2]],
    shL: at(LANDMARK.shoulderL),
    elL: limb(LANDMARK.elbowL, at(LANDMARK.shoulderL)),
    wrL: limb(LANDMARK.wristL, limb(LANDMARK.elbowL, at(LANDMARK.shoulderL))),
    shR: at(LANDMARK.shoulderR),
    elR: limb(LANDMARK.elbowR, at(LANDMARK.shoulderR)),
    wrR: limb(LANDMARK.wristR, limb(LANDMARK.elbowR, at(LANDMARK.shoulderR))),
    hipL: at(LANDMARK.hipL),
    knL: limb(LANDMARK.kneeL, at(LANDMARK.hipL)),
    anL: limb(LANDMARK.ankleL, limb(LANDMARK.kneeL, at(LANDMARK.hipL))),
    hipR: at(LANDMARK.hipR),
    knR: limb(LANDMARK.kneeR, at(LANDMARK.hipR)),
    anR: limb(LANDMARK.ankleR, limb(LANDMARK.kneeR, at(LANDMARK.hipR))),
  };
}
