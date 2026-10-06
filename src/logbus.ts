/**
 * In-memory log ring buffer with live subscribers.
 *
 * Exists so the WebUI can tail logs over SSE. Two properties matter:
 *
 *   1. **Bounded.** A long-running server must not grow this without limit, so
 *      the oldest entries are dropped and counted.
 *   2. **Redacted before storage.** Logs are now readable from a browser, so
 *      anything that looks like a credential is masked on the way in. Redacting
 *      at the source is the only reliable place: once a secret reaches the
 *      buffer, every consumer of it has already leaked.
 */

import type { LogLevel } from './logger.ts';

export interface LogEntry {
  /** Monotonic id, also used as the SSE event id for resume. */
  seq: number;
  time: string;
  level: LogLevel;
  msg: string;
  fields: Record<string, unknown>;
}

/** Field names whose values are masked wherever they appear in the tree. */
const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'eventtoken',
  'event_token',
  'token',
  'secret',
  'password',
  'credential',
  'key',
]);

const MASK = '***redacted***';
const MAX_DEPTH = 4;

/**
 * Recursively masks values under sensitive-looking keys.
 *
 * Deliberately key-based rather than value-based: a value that merely *looks*
 * like a key (the README's `sk-xxxx` placeholder, a model name) must survive.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[deep]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? MASK : redactValue(child, depth + 1);
  }
  return out;
}

export type LogListener = (entry: LogEntry) => void;

export interface LogBusOptions {
  /** Ring size. Older entries are dropped once exceeded. */
  capacity?: number;
  /**
   * Lowest level captured for the UI, independent of the console threshold.
   *
   * Kept separate on purpose: an operator who sets `NAMI_LOG_LEVEL=error` to
   * quiet the console still expects the WebUI log page to show something. The
   * UI can filter further at read time.
   */
  captureLevel?: LogLevel;
}

export class LogBus {
  private readonly capacityLimit: number;
  private readonly captureLevel: LogLevel;
  private readonly entries: LogEntry[] = [];
  private readonly listeners = new Set<LogListener>();
  private seq = 0;
  private dropped = 0;

  constructor(options: LogBusOptions = {}) {
    this.capacityLimit = Math.max(50, options.capacity ?? 1000);
    this.captureLevel = options.captureLevel ?? 'info';
  }

  /** Whether an entry at this level should be buffered. */
  captures(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.captureLevel];
  }

  get captureThreshold(): LogLevel {
    return this.captureLevel;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Ring size, i.e. the most entries that can be retained. */
  get capacity(): number {
    return this.capacityLimit;
  }

  /** How many entries fell out of the ring; surfaced so the UI can say "older logs dropped". */
  get droppedCount(): number {
    return this.dropped;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Records one entry. Never throws: logging must not break the caller. */
  push(level: LogLevel, msg: string, fields: Record<string, unknown>): LogEntry | null {
    try {
      const entry: LogEntry = {
        seq: ++this.seq,
        time: new Date().toISOString(),
        level,
        msg,
        fields: redactValue(fields) as Record<string, unknown>,
      };

      this.entries.push(entry);
      if (this.entries.length > this.capacityLimit) {
        this.entries.splice(0, this.entries.length - this.capacityLimit);
        this.dropped += 1;
      }

      for (const listener of this.listeners) {
        try {
          listener(entry);
        } catch {
          // A broken subscriber must not affect logging or other subscribers.
        }
      }
      return entry;
    } catch {
      return null;
    }
  }

  /** Recent entries in chronological order. */
  recent(limit = 200, minLevel?: LogLevel): LogEntry[] {
    const ranks = LEVEL_RANK;
    const filtered = minLevel
      ? this.entries.filter((entry) => ranks[entry.level] >= ranks[minLevel])
      : this.entries;
    return filtered.slice(Math.max(0, filtered.length - limit));
  }

  /** Entries newer than `seq`, for SSE resume. */
  since(seq: number, limit = 500): LogEntry[] {
    return this.entries.filter((entry) => entry.seq > seq).slice(0, limit);
  }

  subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear(): void {
    this.entries.length = 0;
    this.dropped = 0;
  }
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Level ordering, exported so routes can validate a `?level=` filter. */
export function logLevelRank(level: LogLevel): number {
  return LEVEL_RANK[level];
}

/** True when `level` is a recognised log level name. */
export function isLogLevel(value: string): value is LogLevel {
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, value);
}
