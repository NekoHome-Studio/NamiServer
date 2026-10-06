/**
 * Minimal structured logger.
 *
 * Emits single-line JSON in production (`NAMI_LOG_FORMAT=json`) or a compact
 * human-readable line in development. No external dependency.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Fields attached to every log line for a given logger instance. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const COLOR: Record<string, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export interface LoggerOptions {
  level: LogLevel;
  format: 'json' | 'pretty';
  /** Disable ANSI colours (auto-disabled when the format is json). */
  color?: boolean;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Normalises Error instances and other odd values into loggable fields. */
function normaliseFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value instanceof Error) {
      out[key] = { name: value.name, message: value.message, stack: value.stack };
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function createLogger(base: LogFields, options: LoggerOptions): Logger {
  const { level, format } = options;
  const color = options.color ?? format === 'pretty';
  const threshold = LEVEL_RANK[level];

  const build = (bound: LogFields): Logger => {
    const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
      if (LEVEL_RANK[lvl] < threshold) return;
      const merged = { ...bound, ...(fields ? normaliseFields(fields) : {}) };
      const time = new Date().toISOString();

      if (format === 'json') {
        process.stdout.write(`${safeJson({ time, level: lvl, msg, ...merged })}\n`);
        return;
      }

      const tag = color ? `${COLOR[lvl]}${lvl.toUpperCase().padEnd(5)}${RESET}` : lvl.toUpperCase().padEnd(5);
      const scope = typeof merged.scope === 'string' ? `${DIM}[${merged.scope}]${RESET} ` : '';
      const rest: LogFields = { ...merged };
      delete rest.scope;
      const extra = Object.keys(rest).length > 0 ? ` ${DIM}${safeJson(rest)}${RESET}` : '';
      process.stdout.write(`${DIM}${time}${RESET} ${tag} ${scope}${msg}${extra}\n`);
    };

    return {
      debug: (m, f) => emit('debug', m, f),
      info: (m, f) => emit('info', m, f),
      warn: (m, f) => emit('warn', m, f),
      error: (m, f) => emit('error', m, f),
      child: (f) => build({ ...bound, ...f }),
    };
  };

  return build(base);
}

/** A logger that discards everything; useful in tests. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
