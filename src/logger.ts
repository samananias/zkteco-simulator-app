/**
 * Logging (NFR-09).
 *
 * Two channels:
 *  - app log: leveled, single-line, `level message key=value`
 *  - packet log: per-session command in / reply out, with hex dumps only at `debug`
 *
 * Template payloads are redacted by `redactPayload` (ADR-011) — the protocol engine
 * legitimately carries template bytes for FR-8, so redaction happens at the log
 * boundary rather than being left to call sites.
 */

import type { LogLevel } from './config.js';

const LEVELS: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  /** true when `debug` is enabled (avoids building hex dumps needlessly) */
  readonly isDebug: boolean;
}

function fmt(fields?: Record<string, unknown>): string {
  if (!fields) return '';
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

export function createLogger(level: LogLevel, sink: (line: string) => void = console.log): Logger {
  const threshold = LEVELS[level];
  const emit = (lvl: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[lvl] > threshold) return;
    sink(`${lvl.toUpperCase().padEnd(5)} ${message}${fmt(fields)}`);
  };
  return {
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    get isDebug() {
      return threshold >= LEVELS.debug;
    },
  };
}

/** Commands whose payloads must never appear in logs (ADR-011 / R15). */
const TEMPLATE_COMMANDS = new Set([9 /* USERTEMP_RRQ */, 10 /* USERTEMP_WRQ */]);

export function redactPayload(command: number, payload: Buffer, isDebug: boolean): string {
  if (TEMPLATE_COMMANDS.has(command)) return `<TEMPLATE ${payload.length} bytes>`;
  if (!isDebug) return `${payload.length}B`;
  return payload.length ? payload.toString('hex') : '-';
}
