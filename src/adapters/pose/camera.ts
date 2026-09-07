import { fail, failure, ok, type Result } from '@domain/shared/result.ts';

/**
 * Getting hold of a webcam, and the MediaPipe bundle the tracker loads from.
 *
 * The camera failure messages are worth writing once and writing properly: a
 * player who has refused permission needs telling *that*, not `NotAllowedError`.
 */

/**
 * Pinned to the same version as the `@mediapipe/tasks-vision` dependency in
 * package.json, and it has to stay that way.
 *
 * The code is written against the *typed* API of the installed package, but at
 * runtime it loads the bundle from a CDN. When those two versions disagreed,
 * `HolisticLandmarker` existed in the types and was a stub at runtime — so
 * tracking failed at the point of creating it, with nothing in the types to
 * warn about it.
 */
export const TASKS_VERSION = '@mediapipe/tasks-vision@1.0.1';
export const TASKS_BASE = `https://cdn.jsdelivr.net/npm/${TASKS_VERSION}`;

export interface OpenCamera {
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
}

/**
 * Asks for the camera and returns a playing video element.
 *
 * The secure-context check comes first because it is the failure people
 * actually hit, and the browser's own error for it is unhelpful.
 */
export async function openCamera(): Promise<Result<OpenCamera>> {
  if (!window.isSecureContext) {
    return fail(
      failure(
        'unavailable',
        'Browsers only allow camera access on https:// or localhost. Run `npm run dev`, or use the deployed site.',
      ),
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return fail(
      failure('unavailable', 'This browser has no camera API. Try Chrome, Edge or Safari.'),
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
  } catch (error: unknown) {
    return fail(failure('unavailable', describeCameraError(error)));
  }

  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // Some browsers resolve this late; the read loop waits on readyState.
  }
  return ok({ stream, video });
}

export function describeCameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : 'error';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was refused. Allow it from the address bar, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera is busy — another app may have it. Close that and retry.';
    case 'OverconstrainedError':
      return 'This camera cannot provide the resolution the room asked for.';
    default:
      return `The camera is unavailable (${name}).`;
  }
}
