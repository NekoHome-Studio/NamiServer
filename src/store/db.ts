/**
 * SQLite connection handling built on Node's bundled `node:sqlite` module, so
 * the server needs no native or third-party database driver.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT,
  name         TEXT,
  tool_calls   TEXT,
  tool_call_id TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  status            TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  rounds            INTEGER NOT NULL DEFAULT 0,
  tool_calls        INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  args        TEXT NOT NULL DEFAULT '{}',
  ok          INTEGER NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  error       TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_run ON tool_invocations(run_id);

CREATE TABLE IF NOT EXISTS kv (
  session_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, key)
);
`;

/**
 * Opens (creating if needed) the Nami database and applies the schema.
 *
 * @param path Absolute file path, or `:memory:` for an ephemeral database.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // WAL keeps readers (admin panel, WebSocket) from blocking the agent loop.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/* ------------------------------------------------------------------ *
 * Row coercion helpers.
 *
 * `node:sqlite` yields `unknown` for every column and refuses to bind
 * booleans, so all reads and writes funnel through these.
 * ------------------------------------------------------------------ */

export function nowMs(): number {
  return Date.now();
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function asBool(value: unknown): boolean {
  return asNumber(value, 0) !== 0;
}

export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parses a JSON text column, returning `fallback` when it is absent/invalid. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
