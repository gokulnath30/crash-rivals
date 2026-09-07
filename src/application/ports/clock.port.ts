/**
 * Time, as a dependency.
 *
 * The fighting rules take `dt` and `nowMs` as arguments rather than calling
 * `performance.now()`, and everything that needs a wall-clock timestamp asks
 * this port. That is what makes a bout reproducible in a test.
 */
export interface ClockPort {
  /** Wall-clock milliseconds since the epoch. Use for timestamps. */
  now(): number;
  /** A monotonic millisecond counter. Use for animation and deltas. */
  elapsed(): number;
}
