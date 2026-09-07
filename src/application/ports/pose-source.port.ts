import type { PoseSnapshot, Triple } from '@domain/motion/landmarks.ts';
import type { Result } from '@domain/shared/result.ts';
import type { Listener, Unsubscribe } from './types.ts';

/** What a tracked hand adds, when the tracker reports one. */
export interface HandSnapshot {
  /** 21 landmarks in image space, 0..1, for drawing over the camera. */
  readonly image: readonly Triple[];
}

/** One frame from the tracker. */
export interface TrackedFrame {
  readonly body: PoseSnapshot;
  readonly hands: { readonly left: HandSnapshot | null; readonly right: HandSnapshot | null };
  /** Facial blendshape weights by ARKit name, when the tracker reports them. */
  readonly face: Readonly<Record<string, number>> | null;
}

export type PoseStatus =
  | { readonly kind: 'off' }
  | { readonly kind: 'starting'; readonly message: string }
  | { readonly kind: 'tracking' }
  | { readonly kind: 'no-body' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * Body tracking as a port. Whoever asks wants "what is the camera seeing"; the
 * vision library, the model file and whether it runs on the GPU all stay
 * behind here.
 */
export interface PoseSourcePort {
  readonly status: PoseStatus;

  /** Asks for the camera and loads the model. */
  start(): Promise<Result<void>>;

  /**
   * The newest frame, or null if nothing new has arrived since last asked.
   * Pull-based on purpose: the render loop decides when it wants input,
   * rather than being interrupted at the camera's frame rate.
   */
  read(): TrackedFrame | null;

  onStatusChange(listener: Listener<PoseStatus>): Unsubscribe;

  /** The live camera feed, to show behind the landmark overlay. */
  videoElement(): HTMLVideoElement | null;

  stop(): void;
}
