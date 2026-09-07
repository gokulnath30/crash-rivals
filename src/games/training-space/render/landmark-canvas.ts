import { HAND_LINKS, POSE_LINKS, type Triple } from '@domain/motion/landmarks.ts';
import type { TrackedFrame } from '@app/ports/pose-source.port.ts';

/**
 * The landmark view: the camera picture with the tracker's own skeleton drawn
 * over it, the way MediaPipe's own samples show it.
 *
 * This is the half of the room that tells you what the *model* sees, as
 * opposed to what it has been made to mean. When a gesture will not record,
 * this is where the reason is visible — a wrist that vanishes, a leg the
 * model is inventing.
 */
export class LandmarkCanvas {
  constructor(private readonly canvas: HTMLCanvasElement) {}

  /** Draws one frame. Sizes the backing store to the element on the way. */
  draw(frame: TrackedFrame | null, options: { mirrored: boolean }): void {
    const context = this.canvas.getContext('2d');
    if (!context) return;

    const width = this.canvas.clientWidth || 480;
    const height = this.canvas.clientHeight || 360;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    if (!frame) return;

    // The video behind is mirrored for a natural feel, so the overlay is too.
    const x = (point: Triple): number => (options.mirrored ? 1 - point[0] : point[0]) * width;
    const y = (point: Triple): number => point[1] * height;

    const { body } = frame;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    // Bones first, so the joints sit on top of them.
    context.lineWidth = Math.max(2, width / 160);
    for (const [from, to] of POSE_LINKS) {
      const a = body.image[from];
      const b = body.image[to];
      if (!a || !b) continue;
      const strength = Math.min(body.visibility[from] ?? 1, body.visibility[to] ?? 1);
      context.strokeStyle = `rgba(120, 220, 255, ${0.25 + strength * 0.6})`;
      context.beginPath();
      context.moveTo(x(a), y(a));
      context.lineTo(x(b), y(b));
      context.stroke();
    }

    const radius = Math.max(2.5, width / 190);
    for (const [index, point] of body.image.entries()) {
      const strength = body.visibility[index] ?? 1;
      // A landmark the model is unsure of is drawn faintly rather than hidden,
      // because "the model is guessing here" is the useful thing to see.
      context.fillStyle = strength < 0.5 ? 'rgba(255,110,110,0.75)' : 'rgba(255,255,255,0.92)';
      context.beginPath();
      context.arc(x(point), y(point), radius, 0, Math.PI * 2);
      context.fill();
    }

    // Hands, when the holistic tracker found them.
    context.lineWidth = Math.max(1.5, width / 260);
    for (const [side, hand] of [
      ['left', frame.hands.left],
      ['right', frame.hands.right],
    ] as const) {
      if (!hand) continue;
      context.strokeStyle = side === 'left' ? 'rgba(255,180,90,0.9)' : 'rgba(160,255,180,0.9)';
      for (const [from, to] of HAND_LINKS) {
        const a = hand.image[from];
        const b = hand.image[to];
        if (!a || !b) continue;
        context.beginPath();
        context.moveTo(x(a), y(a));
        context.lineTo(x(b), y(b));
        context.stroke();
      }
      context.fillStyle = context.strokeStyle;
      for (const point of hand.image) {
        context.beginPath();
        context.arc(x(point), y(point), radius * 0.55, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  clear(): void {
    const context = this.canvas.getContext('2d');
    context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
