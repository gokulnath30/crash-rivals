import type { PoseSnapshot, Triple } from '@domain/motion/landmarks.ts';
import { fail, failure, ok, type Result } from '@domain/shared/result.ts';
import type { LoggerPort } from '@app/ports/logger.port.ts';
import type {
  HandSnapshot,
  PoseSourcePort,
  PoseStatus,
  TrackedFrame,
} from '@app/ports/pose-source.port.ts';
import type { Listener, Unsubscribe } from '@app/ports/types.ts';
import { TASKS_BASE, openCamera } from './camera.ts';

/**
 * Body tracking with MediaPipe's *holistic* landmarker: the pose, both hands
 * and the face in one pass.
 *
 * The same model the MediaPipe web samples demonstrate, loaded from the same
 * CDN, so what this room shows is what that demo shows — with the landmarks
 * also driving a character and feeding a recorder.
 *
 * It tracks exactly one person, which is all a training room needs.
 */
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/holistic_landmarker/holistic_landmarker/float16/latest/holistic_landmarker.task';

interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

interface Category {
  categoryName?: string;
  displayName?: string;
  score: number;
}

interface HolisticResult {
  poseWorldLandmarks: Landmark[][];
  poseLandmarks: Landmark[][];
  leftHandLandmarks: Landmark[][];
  rightHandLandmarks: Landmark[][];
  faceBlendshapes: { categories: Category[] }[];
}

interface Holistic {
  detectForVideo(video: HTMLVideoElement, timestampMs: number): HolisticResult | undefined;
  close(): void;
}

interface VisionModule {
  FilesetResolver: { forVisionTasks(base: string): Promise<unknown> };
  HolisticLandmarker: { createFromOptions(fileset: unknown, options: unknown): Promise<Holistic> };
}

interface Attempt {
  readonly delegate: 'GPU' | 'CPU';
  readonly blendshapes: boolean;
}

/**
 * Tried in order until one actually infers.
 *
 * The face is worth more than the delegate here, so a working CPU
 * configuration beats a GPU one that cannot report expressions. The last
 * entry is the bare minimum: pose and hands, however it can get them.
 */
const ATTEMPTS: readonly Attempt[] = [
  { delegate: 'GPU', blendshapes: true },
  { delegate: 'CPU', blendshapes: true },
  { delegate: 'GPU', blendshapes: false },
  { delegate: 'CPU', blendshapes: false },
];

const describe = (attempt: Attempt): string =>
  `${attempt.delegate}${attempt.blendshapes ? ' with faces' : ' without faces'}`;

export class MediaPipeHolisticSource implements PoseSourcePort {
  status: PoseStatus = { kind: 'off' };

  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private landmarker: Holistic | null = null;
  private stopped = false;
  private lastVideoTime = -1;
  private readonly statusListeners = new Set<Listener<PoseStatus>>();
  private readonly log: LoggerPort;

  constructor(logger: LoggerPort) {
    this.log = logger.scoped('holistic');
  }

  async start(): Promise<Result<void>> {
    if (this.landmarker) return ok(undefined);
    this.stopped = false;

    this.setStatus({ kind: 'starting', message: 'Asking for the camera…' });
    const camera = await openCamera();
    if (!camera.ok) {
      this.setStatus({ kind: 'failed', message: camera.error.message });
      return camera;
    }
    this.stream = camera.value.stream;
    this.video = camera.value.video;

    this.setStatus({ kind: 'starting', message: 'Loading the tracking model (13 MB)…' });
    let vision: VisionModule;
    let fileset: unknown;
    try {
      vision = (await import(/* @vite-ignore */ `${TASKS_BASE}/vision_bundle.mjs`)) as VisionModule;
      fileset = await vision.FilesetResolver.forVisionTasks(`${TASKS_BASE}/wasm`);
    } catch (error: unknown) {
      this.log.log('error', 'could not load the vision bundle', error);
      const message = 'Could not load the tracking model. Check the connection and retry.';
      this.setStatus({ kind: 'failed', message });
      this.releaseCamera();
      return fail(failure('unavailable', message));
    }

    // Wait for a frame, because a configuration can only be *proved* to work
    // by running one.
    await this.waitForFrame();

    for (const attempt of ATTEMPTS) {
      if (this.stopped) return fail(failure('unavailable', 'Tracking was cancelled.'));
      const candidate = await this.tryAttempt(vision, fileset, attempt);
      if (!candidate) continue;
      this.landmarker = candidate;
      this.log.log('info', `tracking on ${describe(attempt)}`);
      this.setStatus({ kind: 'tracking' });
      return ok(undefined);
    }

    const message = 'This device cannot run full-body tracking.';
    this.setStatus({ kind: 'failed', message });
    this.releaseCamera();
    return fail(failure('unavailable', message));
  }

  /**
   * Builds one configuration and *runs a frame through it* before accepting it.
   *
   * Creation is not proof. Face blendshapes on the GPU delegate construct
   * perfectly happily and then fail on every single inference with
   * `UNIMPLEMENTED` — which presents as a model that downloads and a camera
   * that never tracks anything, with no error at the point of setup to
   * explain it. So each candidate has to earn its place by actually working.
   */
  private async tryAttempt(
    vision: VisionModule,
    fileset: unknown,
    attempt: Attempt,
  ): Promise<Holistic | null> {
    let candidate: Holistic;
    try {
      candidate = await vision.HolisticLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: attempt.delegate },
        runningMode: 'VIDEO',
        outputFaceBlendshapes: attempt.blendshapes,
      });
    } catch (error: unknown) {
      this.log.log('info', `holistic ${describe(attempt)} could not be created`, error);
      return null;
    }

    const video = this.video;
    if (!video) return candidate;
    try {
      candidate.detectForVideo(video, performance.now());
      return candidate;
    } catch (error: unknown) {
      this.log.log('warn', `holistic ${describe(attempt)} cannot infer; trying the next`, error);
      try {
        candidate.close();
      } catch {
        // Already broken; nothing useful to do about a failed close.
      }
      return null;
    }
  }

  /** Gives the camera a moment to produce a frame worth testing against. */
  private async waitForFrame(): Promise<void> {
    const video = this.video;
    if (!video) return;
    for (let i = 0; i < 40 && video.readyState < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  read(): TrackedFrame | null {
    const video = this.video;
    const landmarker = this.landmarker;
    if (!video || !landmarker || video.readyState < 2) return null;
    if (video.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = video.currentTime;

    let result: HolisticResult | undefined;
    try {
      result = landmarker.detectForVideo(video, performance.now());
    } catch (error: unknown) {
      this.log.log('debug', 'inference failed for a frame', error);
      return null;
    }

    const world = result?.poseWorldLandmarks[0];
    const image = result?.poseLandmarks[0];
    if (!result || !world || !image) {
      if (this.status.kind !== 'no-body') this.setStatus({ kind: 'no-body' });
      return null;
    }

    if (this.status.kind !== 'tracking') this.setStatus({ kind: 'tracking' });

    const body: PoseSnapshot = {
      world: world.map(toWorldTriple),
      image: image.map(toImageTriple),
      // Taken from the *image* set: the world landmarks carry the same
      // scores, but the image-space ones are what the model is actually
      // confident or unconfident about seeing.
      visibility: image.map((point) => point.visibility ?? 1),
      atMs: performance.now(),
    };

    return {
      body,
      hands: {
        left: toHand(result.leftHandLandmarks[0]),
        right: toHand(result.rightHandLandmarks[0]),
      },
      face: toFace(result.faceBlendshapes[0]?.categories),
    };
  }

  onStatusChange(listener: Listener<PoseStatus>): Unsubscribe {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  stop(): void {
    this.stopped = true;
    try {
      this.landmarker?.close();
    } catch {
      // Closing a landmarker that already failed is not worth reporting.
    }
    this.landmarker = null;
    this.releaseCamera();
    this.setStatus({ kind: 'off' });
  }

  private releaseCamera(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
  }

  private setStatus(status: PoseStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}

/**
 * MediaPipe reports y downward and z away from the camera; the scene has y up
 * and z toward it. One negation each, in the one place that knows about both.
 */
const toWorldTriple = (l: Landmark): Triple => [l.x, -l.y, -l.z];

/** Image-space landmarks stay as they are, for drawing over the video. */
const toImageTriple = (l: Landmark): Triple => [l.x, l.y, l.z];

function toHand(hand: Landmark[] | undefined): HandSnapshot | null {
  if (!hand || hand.length === 0) return null;
  return { image: hand.map(toImageTriple) };
}

function toFace(categories: Category[] | undefined): Record<string, number> | null {
  if (!categories || categories.length === 0) return null;
  const weights: Record<string, number> = {};
  for (const category of categories) {
    const name = category.categoryName ?? category.displayName;
    if (name) weights[name] = category.score;
  }
  return weights;
}
