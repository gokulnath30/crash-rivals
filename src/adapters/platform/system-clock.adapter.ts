import type { ClockPort } from '@app/ports/clock.port.ts';

/** The real clock. Everything else in the app takes time as a dependency. */
export class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }

  elapsed(): number {
    // `performance.now()` is monotonic; `Date.now()` jumps when the system
    // clock is corrected, which would make a frame delta negative.
    return performance.now();
  }
}
