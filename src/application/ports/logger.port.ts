export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Diagnostics as a port, so use cases can explain themselves without
 * hard-wiring `console` — and so a noisy netcode log can be switched off in
 * production without touching the netcode.
 */
export interface LoggerPort {
  log(level: LogLevel, message: string, detail?: unknown): void;
  /** A logger scoped to a subsystem, e.g. `logger.scoped('webrtc')`. */
  scoped(scope: string): LoggerPort;
}
