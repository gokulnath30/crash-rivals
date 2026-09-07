import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import { CLIPS, type ClipName, type ClipSegment } from './clip-timing.ts';

/**
 * A recorded clip, ready to be read at any time.
 *
 * Not an `AnimationMixer`: the fighter is posed by the procedural animator
 * and the clip is blended on top of it bone by bone, so what is needed is
 * "the rotation of this bone at this time", which is what an interpolant is.
 */
export class SampledClip {
  readonly duration: number;
  private readonly rotations: { bone: string; interpolant: THREE.Interpolant }[] = [];
  private readonly hips: THREE.Interpolant | null;

  constructor(
    clip: THREE.AnimationClip,
    readonly segment: ClipSegment,
  ) {
    this.duration = clip.duration;
    let hips: THREE.Interpolant | null = null;
    for (const track of clip.tracks) {
      const [bone, property] = track.name.split('.');
      if (!bone || !property) continue;
      if (property === 'quaternion') {
        this.rotations.push({
          bone,
          interpolant: new THREE.QuaternionLinearInterpolant(
            track.times,
            track.values,
            track.getValueSize(),
            new Float32Array(4),
          ),
        });
      } else if (property === 'position' && bone === 'Hips') {
        hips = new THREE.LinearInterpolant(
          track.times,
          track.values,
          track.getValueSize(),
          new Float32Array(3),
        );
      }
    }
    this.hips = hips;
  }

  /** Every bone the clip drives. */
  bones(): readonly string[] {
    return this.rotations.map((entry) => entry.bone);
  }

  /**
   * Reads every bone at `time`, looping and blending the seam when the
   * segment loops, and hands each rotation to `write`.
   */
  sample(time: number, write: (bone: string, rotation: THREE.Quaternion) => void): number | null {
    const { loop, seam } = this.segment;
    const t = loop ? ((time % this.duration) + this.duration) % this.duration : Math.min(time, this.duration);
    // Near the end of a loop, blend toward what the start looks like, so the
    // wrap does not pop.
    const into = loop && seam > 0 && t > this.duration - seam ? (t - (this.duration - seam)) / seam : 0;
    const wrapped = t - this.duration;

    for (const { bone, interpolant } of this.rotations) {
      const a = interpolant.evaluate(t);
      SCRATCH_A.set(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1);
      if (into > 0) {
        const b = interpolant.evaluate(Math.max(0, wrapped + seam));
        SCRATCH_B.set(b[0] ?? 0, b[1] ?? 0, b[2] ?? 0, b[3] ?? 1);
        SCRATCH_A.slerp(SCRATCH_B, into);
      }
      write(bone, SCRATCH_A);
    }

    if (!this.hips) return null;
    const hips = this.hips.evaluate(t);
    return hips[1] ?? null;
  }
}

const SCRATCH_A = new THREE.Quaternion();
const SCRATCH_B = new THREE.Quaternion();

/**
 * Loads the recorded segments once and shares them with every fighter.
 *
 * The files are animation-only (no mesh, no textures, a few dozen kilobytes
 * each) and keyed by bone name, so one download serves both fighters and
 * whichever model they wear. Until a file has arrived `get` returns null and
 * the fighter simply stays procedural, which is what makes the loading
 * invisible.
 */
export class ClipLibrary {
  private readonly loader = new GLTFLoader();
  private readonly clips = new Map<ClipName, SampledClip>();
  private readonly log: LoggerPort;

  constructor(logger: LoggerPort) {
    this.log = logger.scoped('ashen-ring/clips');
  }

  /** Starts every download. Never throws; a missing clip stays procedural. */
  load(): void {
    for (const [name, segment] of Object.entries(CLIPS) as [ClipName, ClipSegment][]) {
      const url = new URL(segment.file, document.baseURI).href;
      this.loader.load(
        url,
        (gltf) => {
          const clip = gltf.animations[0];
          if (!clip) {
            this.log.log('warn', `${segment.file} carries no animation`);
            return;
          }
          this.clips.set(name, new SampledClip(clip, segment));
        },
        undefined,
        (error: unknown) => {
          this.log.log('warn', `could not load ${segment.file}; that move stays procedural`, error);
        },
      );
    }
  }

  get(name: ClipName): SampledClip | null {
    return this.clips.get(name) ?? null;
  }

  duration(name: ClipName): number | null {
    return this.clips.get(name)?.duration ?? null;
  }

  dispose(): void {
    this.clips.clear();
  }
}
