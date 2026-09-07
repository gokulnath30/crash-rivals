/** Small numeric helpers the fighting rules lean on. Framework-free by design. */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Frame-rate independent easing. `rate` is the fraction of the remaining
 * distance still left after one second, so the result of a 16ms frame and of a
 * 33ms frame agree — which a naive `x += (target - x) * 0.1` does not.
 */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.pow(rate, dt));

export const approach = (current: number, target: number, perSecond: number, dt: number): number => {
  const step = perSecond * dt;
  if (Math.abs(target - current) <= step) return target;
  return current + Math.sign(target - current) * step;
};
