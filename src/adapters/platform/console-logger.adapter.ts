import type { LoggerPort, LogLevel } from '@app/ports/logger.port.ts';

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logs to the console, above a threshold.
 *
 * Production keeps `warn` and above: the netcode's debug chatter is useful
 * while building and pure noise in a player's console.
 */
export class ConsoleLogger implements LoggerPort {
  constructor(
    private readonly threshold: LogLevel = 'info',
    private readonly scope = 'arcade',
  ) {}

  log(level: LogLevel, message: string, detail?: unknown): void {
    if (ORDER[level] < ORDER[this.threshold]) return;
    const label = `[${this.scope}] ${message}`;
    const method = level === 'debug' ? 'log' : level;
    if (detail === undefined) console[method](label);
    else console[method](label, detail);
  }

  scoped(scope: string): LoggerPort {
    return new ConsoleLogger(this.threshold, `${this.scope}:${scope}`);
  }
}
