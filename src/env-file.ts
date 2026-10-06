/**
 * Reading and writing `.env` files.
 *
 * Shared by the Ollama setup wizard (`scripts/ollama.ts`) and the WebUI's config
 * editor, so both mutate `.env` with the same semantics: existing keys are
 * rewritten in place, comments and unrelated settings survive untouched, and the
 * operation is idempotent.
 */

import { existsSync, readFileSync } from 'node:fs';

export interface EnvChange {
  key: string;
  /** Previous value, or null when the key was newly appended. */
  from: string | null;
  to: string;
}

export interface UpsertResult {
  content: string;
  applied: EnvChange[];
}

/** A key that is safe to write: uppercase NAMI_* only. */
const KEY_PATTERN = /^NAMI_[A-Z0-9_]+$/;

export function isWritableEnvKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * Applies `key=value` updates to an existing `.env` body.
 *
 * Existing keys are rewritten in place (preserving comments and ordering); new
 * keys are appended under a marker comment. Returns the new content plus the
 * list of changes, so callers can report exactly what was touched.
 *
 * @throws when a key is not a writable `NAMI_*` name.
 */
export function upsertEnv(content: string, updates: Record<string, string>): UpsertResult {
  for (const key of Object.keys(updates)) {
    if (!isWritableEnvKey(key)) {
      throw new Error(`refusing to write "${key}": only NAMI_* keys are managed here`);
    }
  }

  const lines = content === '' ? [] : content.split(/\r?\n/);
  const applied: EnvChange[] = [];
  const remaining = new Map(Object.entries(updates));

  const rewritten = lines.map((line) => {
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) return line;
    const key = match[2] as string;
    if (!remaining.has(key)) return line;
    const next = remaining.get(key) as string;
    remaining.delete(key);
    applied.push({ key, from: (match[3] as string).trim(), to: next });
    return `${match[1]}${key}=${next}`;
  });

  if (remaining.size > 0) {
    const additions: string[] = [];
    if (rewritten.length > 0 && rewritten[rewritten.length - 1]?.trim() !== '') additions.push('');
    additions.push('# --- added by the Nami config editor ---');
    for (const [key, value] of remaining) {
      additions.push(`${key}=${value}`);
      applied.push({ key, from: null, to: value });
    }
    rewritten.push(...additions);
  }

  let output = rewritten.join('\n');
  if (!output.endsWith('\n')) output += '\n';
  return { content: output, applied };
}

/** Reads the current `.env` body, or an empty string when absent. */
export function readEnvFile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

/**
 * Parses a `.env` body into key/value pairs.
 *
 * Values keep their raw text (no unescaping) because this is only used to show
 * what a restart would pick up — the server's own `loadConfig` remains the
 * authority on effective values.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
