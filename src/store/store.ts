/**
 * Persistence repository for sessions, messages, runs, tool invocations and
 * per-session key/value memory.
 *
 * Every method is synchronous: `node:sqlite` is synchronous by design, and the
 * agent loop already yields on network I/O, so there is nothing to gain from
 * wrapping these in promises.
 */

import type { DatabaseSync } from 'node:sqlite';
import type {
  AuthSessionRecord,
  ChatMessage,
  LoginAttemptRecord,
  MessageRecord,
  Role,
  RunRecord,
  RunStatus,
  SessionRecord,
  ToolCall,
  ToolInvocationRecord,
  UserRecord,
} from '../core/types.ts';
import { asNumber, asOptionalString, asString, newId, nowMs, parseJson } from './db.ts';

/** A supported SQLite binding value. `undefined` must be normalised to null. */
type Bind = string | number | bigint | null | Uint8Array;

function b(value: string | number | null | undefined): Bind {
  return value === undefined ? null : value;
}

/**
 * Client-supplied session ids are accepted as-is, so they must be safe to put in
 * a URL path and small enough to index. Anything else falls back to a generated id.
 */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9._:@-]{1,128}$/.test(id);
}

export interface AppendMessageInput {
  role: Role;
  content: string | null;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface CreateRunInput {
  sessionId: string;
  provider: string;
  model: string;
}

export interface FinishRunInput {
  status: RunStatus;
  rounds: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  error?: string;
}

export interface CreateToolInvocationInput {
  runId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  content: string;
  error?: string;
  durationMs: number;
}

export interface StoreCounts {
  sessions: number;
  messages: number;
  runs: number;
  toolInvocations: number;
}

export interface ToolUsageStat {
  name: string;
  calls: number;
  failures: number;
  avgMs: number;
}

export interface StoreStats {
  counts: StoreCounts;
  recentRuns: RunRecord[];
  toolUsage: ToolUsageStat[];
}

export class SessionStore {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /* ---------------------------- sessions ---------------------------- */

  createSession(title = 'New session', metadata: Record<string, unknown> = {}): SessionRecord {
    return this.insertSession(newId('sess'), title, metadata);
  }

  /**
   * Creates a session under a caller-chosen id.
   *
   * @throws when the id already exists.
   */
  createSessionWithId(
    id: string,
    title: string,
    metadata: Record<string, unknown> = {},
  ): SessionRecord {
    if (this.getSession(id)) throw new Error(`session "${id}" already exists`);
    return this.insertSession(id, title, metadata);
  }

  private insertSession(
    id: string,
    title: string,
    metadata: Record<string, unknown>,
  ): SessionRecord {
    const now = nowMs();
    const record: SessionRecord = {
      id,
      title: title.slice(0, 200) || 'New session',
      createdAt: now,
      updatedAt: now,
      metadata,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.title, record.createdAt, record.updatedAt, JSON.stringify(metadata));
    return record;
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
    return row ? mapSession(row) : null;
  }

  /**
   * Returns the existing session, or creates it under the requested id.
   *
   * Honouring a caller-supplied id is what makes `X-Nami-Session`,
   * `session_id`, OneBot group ids and the AstrBot integration work: a client
   * that keeps sending the same id must keep landing in the same conversation.
   * Previously a missing id silently produced a *generated* id, so every request
   * started a fresh session and continuity was lost without any error.
   */
  ensureSession(id: string | undefined, fallbackTitle: string): SessionRecord {
    if (id) {
      const existing = this.getSession(id);
      if (existing) return existing;
      if (isValidSessionId(id)) return this.insertSession(id, fallbackTitle, {});
    }
    return this.createSession(fallbackTitle);
  }

  listSessions(limit = 50, offset = 0): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(Math.max(1, limit), Math.max(0, offset));
    return rows.map(mapSession);
  }

  renameSession(id: string, title: string): void {
    this.db
      .prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title.slice(0, 200), nowMs(), id);
  }

  deleteSession(id: string): boolean {
    // `runs` and `tool_invocations` carry no FK to sessions, so clean them up
    // explicitly inside one transaction.
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `DELETE FROM tool_invocations
           WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)`,
        )
        .run(id);
      this.db.prepare(`DELETE FROM runs WHERE session_id = ?`).run(id);
      this.db.prepare(`DELETE FROM kv WHERE session_id = ?`).run(id);
      // messages cascade via the foreign key declared in the schema.
      const result = this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
      this.db.exec('COMMIT');
      return asNumber(result.changes, 0) > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /* ---------------------------- messages ---------------------------- */

  appendMessage(sessionId: string, input: AppendMessageInput): MessageRecord {
    const seq = this.nextSeq(sessionId);
    const record: MessageRecord = {
      id: newId('msg'),
      sessionId,
      seq,
      role: input.role,
      content: input.content,
      name: input.name,
      toolCalls: input.toolCalls,
      toolCallId: input.toolCallId,
      createdAt: nowMs(),
    };
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, content, name, tool_calls, tool_call_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.seq,
        record.role,
        b(record.content),
        b(record.name),
        record.toolCalls ? JSON.stringify(record.toolCalls) : null,
        b(record.toolCallId),
        record.createdAt,
      );
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(record.createdAt, sessionId);
    return record;
  }

  private nextSeq(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), -1) AS max_seq FROM messages WHERE session_id = ?`)
      .get(sessionId);
    return asNumber(row && (row as Record<string, unknown>).max_seq, -1) + 1;
  }

  /** Messages in chronological order; `limit` keeps the most recent ones. */
  getMessages(sessionId: string, limit?: number): MessageRecord[] {
    if (limit === undefined) {
      return this.db
        .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC`)
        .all(sessionId)
        .map(mapMessage);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?
         ) ORDER BY seq ASC`,
      )
      .all(sessionId, Math.max(1, limit));
    return rows.map(mapMessage);
  }

  countMessages(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_id = ?`)
      .get(sessionId);
    return asNumber(row && (row as Record<string, unknown>).c, 0);
  }

  /** Projection used to rebuild model context. */
  toChatMessages(records: MessageRecord[]): ChatMessage[] {
    return records.map((record) => {
      const message: ChatMessage = { role: record.role, content: record.content };
      if (record.name) message.name = record.name;
      if (record.toolCalls && record.toolCalls.length > 0) message.tool_calls = record.toolCalls;
      if (record.toolCallId) message.tool_call_id = record.toolCallId;
      return message;
    });
  }

  /* ------------------------------ runs ------------------------------ */

  createRun(input: CreateRunInput): RunRecord {
    const record: RunRecord = {
      id: newId('run'),
      sessionId: input.sessionId,
      status: 'running',
      provider: input.provider,
      model: input.model,
      rounds: 0,
      toolCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      startedAt: nowMs(),
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, status, provider, model, rounds, tool_calls,
                           prompt_tokens, completion_tokens, started_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.status,
        record.provider,
        record.model,
        record.startedAt,
      );
    return record;
  }

  finishRun(id: string, input: FinishRunInput): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, rounds = ?, tool_calls = ?, prompt_tokens = ?,
                         completion_tokens = ?, error = ?, ended_at = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.rounds,
        input.toolCalls,
        input.promptTokens,
        input.completionTokens,
        b(input.error),
        nowMs(),
        id,
      );
  }

  getRun(id: string): RunRecord | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id);
    return row ? mapRun(row) : null;
  }

  listRuns(limit = 20): RunRecord[] {
    return this.db
      .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(Math.max(1, limit))
      .map(mapRun);
  }

  /** Marks runs left dangling by an unclean shutdown as failed. */
  reapStaleRuns(): number {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'failed', error = 'interrupted by server restart', ended_at = ?
         WHERE status = 'running'`,
      )
      .run(nowMs());
    return asNumber(result.changes, 0);
  }

  /* ------------------------- tool invocations ------------------------ */

  createToolInvocation(input: CreateToolInvocationInput): ToolInvocationRecord {
    const record: ToolInvocationRecord = {
      id: newId('tool'),
      runId: input.runId,
      name: input.name,
      args: input.args,
      ok: input.ok,
      content: input.content,
      error: input.error,
      durationMs: input.durationMs,
      createdAt: nowMs(),
    };
    this.db
      .prepare(
        `INSERT INTO tool_invocations (id, run_id, name, args, ok, content, error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.name,
        JSON.stringify(record.args),
        record.ok ? 1 : 0,
        record.content,
        b(record.error),
        Math.round(record.durationMs),
        record.createdAt,
      );
    return record;
  }

  listToolInvocations(runId: string): ToolInvocationRecord[] {
    return this.db
      .prepare(`SELECT * FROM tool_invocations WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId)
      .map(mapToolInvocation);
  }

  /* ------------------------------- kv ------------------------------- */

  kvSet(sessionId: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (session_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(sessionId, key, JSON.stringify(value ?? null), nowMs());
  }

  kvGet<T = unknown>(sessionId: string, key: string): T | undefined {
    const row = this.db
      .prepare(`SELECT value FROM kv WHERE session_id = ? AND key = ?`)
      .get(sessionId, key);
    if (!row) return undefined;
    return parseJson<T | undefined>((row as Record<string, unknown>).value, undefined);
  }

  kvList(sessionId: string): Record<string, unknown> {
    const rows = this.db
      .prepare(`SELECT key, value FROM kv WHERE session_id = ? ORDER BY key ASC`)
      .all(sessionId);
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      const rec = row as Record<string, unknown>;
      out[asString(rec.key)] = parseJson<unknown>(rec.value, null);
    }
    return out;
  }

  kvDelete(sessionId: string, key: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM kv WHERE session_id = ? AND key = ?`)
      .run(sessionId, key);
    return asNumber(result.changes, 0) > 0;
  }

  /* ------------------------------ stats ------------------------------ */

  counts(): StoreCounts {
    const one = (table: string): number => {
      const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
      return asNumber(row && (row as Record<string, unknown>).c, 0);
    };
    return {
      sessions: one('sessions'),
      messages: one('messages'),
      runs: one('runs'),
      toolInvocations: one('tool_invocations'),
    };
  }

  toolUsage(limit = 20): ToolUsageStat[] {
    return this.db
      .prepare(
        `SELECT name,
                COUNT(*)                                   AS calls,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END)    AS failures,
                AVG(duration_ms)                           AS avg_ms
         FROM tool_invocations
         GROUP BY name
         ORDER BY calls DESC
         LIMIT ?`,
      )
      .all(Math.max(1, limit))
      .map((row) => {
        const rec = row as Record<string, unknown>;
        return {
          name: asString(rec.name),
          calls: asNumber(rec.calls, 0),
          failures: asNumber(rec.failures, 0),
          avgMs: Math.round(asNumber(rec.avg_ms, 0)),
        };
      });
  }

  stats(): StoreStats {
    return {
      counts: this.counts(),
      recentRuns: this.listRuns(10),
      toolUsage: this.toolUsage(10),
    };
  }

  /* ------------------------------ users ------------------------------ */

  /**
   * Usernames are stored already normalised (lower-cased, trimmed) by
   * `normaliseUsername`; this is the only place that relies on it, and the
   * UNIQUE index is what actually enforces one account per name.
   */
  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get();
    return asNumber(row && (row as Row).c, 0);
  }

  listUsers(): UserRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM users ORDER BY created_at ASC')
      .all() as unknown[];
    return rows.map(mapUser);
  }

  findUserByUsername(username: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    return row ? mapUser(row) : null;
  }

  findUserById(id: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? mapUser(row) : null;
  }

  /** @throws when the username is already taken (UNIQUE constraint). */
  createUser(input: { username: string; passwordHash: string; isAdmin: boolean }): UserRecord {
    const now = nowMs();
    const id = newId('usr');
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, is_admin, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, input.username, input.passwordHash, input.isAdmin ? 1 : 0, now, now);
    const created = this.findUserById(id);
    if (!created) throw new Error('user row vanished immediately after insert');
    return created;
  }

  setUserPassword(userId: string, passwordHash: string): boolean {
    const result = this.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, nowMs(), userId);
    return asNumber(result.changes, 0) > 0;
  }

  setUserDisabled(userId: string, disabled: boolean): boolean {
    const result = this.db
      .prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?')
      .run(disabled ? 1 : 0, nowMs(), userId);
    return asNumber(result.changes, 0) > 0;
  }

  setUserAdmin(userId: string, isAdmin: boolean): boolean {
    const result = this.db
      .prepare('UPDATE users SET is_admin = ?, updated_at = ? WHERE id = ?')
      .run(isAdmin ? 1 : 0, nowMs(), userId);
    return asNumber(result.changes, 0) > 0;
  }

  deleteUser(userId: string): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return asNumber(result.changes, 0) > 0;
  }

  /** Number of enabled admins — used to refuse removing the last way in. */
  countActiveAdmins(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1 AND disabled = 0')
      .get();
    return asNumber(row && (row as Row).c, 0);
  }

  touchUserLogin(userId: string): void {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowMs(), userId);
  }

  /* -------------------------- auth sessions -------------------------- */

  createAuthSession(input: {
    tokenHash: string;
    userId: string;
    ttlMs: number;
    userAgent?: string | null;
    ip?: string | null;
  }): AuthSessionRecord {
    const now = nowMs();
    const expiresAt = now + input.ttlMs;
    this.db
      .prepare(
        `INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenHash,
        input.userId,
        now,
        expiresAt,
        now,
        b(input.userAgent ?? null),
        b(input.ip ?? null),
      );
    return {
      userId: input.userId,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
    };
  }

  /**
   * Resolves a presented token hash into its session and user.
   *
   * Expiry and the account's disabled flag are both checked here rather than by
   * the caller, so there is no code path that can forget one of them. Returns
   * null for every rejection reason — the caller must not be able to tell an
   * expired session from a deleted account.
   */
  findAuthSession(
    tokenHash: string,
    now = nowMs(),
  ): { session: AuthSessionRecord; user: UserRecord } | null {
    const row = this.db
      .prepare(
        `SELECT s.token_hash, s.user_id, s.created_at, s.expires_at, s.last_seen_at,
                s.user_agent, s.ip,
                u.id AS u_id, u.username, u.password_hash, u.is_admin, u.disabled,
                u.created_at AS u_created_at, u.updated_at AS u_updated_at, u.last_login_at
           FROM auth_sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as Row | undefined;
    if (!row) return null;
    if (asNumber(row.expires_at) <= now) return null;
    if (asNumber(row.disabled, 0) !== 0) return null;

    return {
      session: {
        userId: asString(row.user_id),
        createdAt: asNumber(row.created_at),
        expiresAt: asNumber(row.expires_at),
        lastSeenAt: asNumber(row.last_seen_at),
        userAgent: asOptionalString(row.user_agent) ?? null,
        ip: asOptionalString(row.ip) ?? null,
      },
      user: mapUser({
        id: row.u_id,
        username: row.username,
        password_hash: row.password_hash,
        is_admin: row.is_admin,
        disabled: row.disabled,
        created_at: row.u_created_at,
        updated_at: row.u_updated_at,
        last_login_at: row.last_login_at,
      }),
    };
  }

  /** Slides the idle timestamp. Cheap enough to run on every authenticated call. */
  touchAuthSession(tokenHash: string, now = nowMs()): void {
    this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, tokenHash);
  }

  deleteAuthSession(tokenHash: string): boolean {
    const result = this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash);
    return asNumber(result.changes, 0) > 0;
  }

  /** Invalidates every session a user holds; returns how many were removed. */
  deleteUserAuthSessions(userId: string): number {
    const result = this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
    return asNumber(result.changes, 0);
  }

  pruneAuthSessions(now = nowMs()): number {
    const result = this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
    return asNumber(result.changes, 0);
  }

  countAuthSessions(userId?: string): number {
    const row =
      userId === undefined
        ? this.db.prepare('SELECT COUNT(*) AS c FROM auth_sessions').get()
        : this.db.prepare('SELECT COUNT(*) AS c FROM auth_sessions WHERE user_id = ?').get(userId);
    return asNumber(row && (row as Row).c, 0);
  }

  /* ------------------------- login attempts ------------------------- */

  readLoginAttempt(scope: string, subject: string): LoginAttemptRecord | null {
    const row = this.db
      .prepare('SELECT * FROM login_attempts WHERE scope = ? AND subject = ?')
      .get(scope, subject) as Row | undefined;
    if (!row) return null;
    return {
      failures: asNumber(row.failures),
      firstAt: asNumber(row.first_at),
      lastAt: asNumber(row.last_at),
      lockedUntil: row.locked_until == null ? null : asNumber(row.locked_until),
    };
  }

  /**
   * Records a failed login and returns the resulting counter.
   *
   * The window rolls: failures older than `windowMs` start a fresh count, so a
   * user who mistypes once a month never accumulates a lockout. Once
   * `maxAttempts` is reached the row is stamped with `lockedUntil`.
   */
  recordLoginFailure(
    scope: string,
    subject: string,
    options: { windowMs: number; maxAttempts: number; lockoutMs: number },
  ): LoginAttemptRecord {
    const now = nowMs();
    const existing = this.readLoginAttempt(scope, subject);
    const withinWindow = existing !== null && now - existing.lastAt <= options.windowMs;
    const failures = withinWindow ? existing.failures + 1 : 1;
    const firstAt = withinWindow ? existing.firstAt : now;
    const lockedUntil =
      failures >= options.maxAttempts ? now + options.lockoutMs : (existing?.lockedUntil ?? null);

    this.db
      .prepare(
        `INSERT INTO login_attempts (scope, subject, failures, first_at, last_at, locked_until)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, subject) DO UPDATE SET
           failures = excluded.failures,
           first_at = excluded.first_at,
           last_at = excluded.last_at,
           locked_until = excluded.locked_until`,
      )
      .run(scope, subject, failures, firstAt, now, b(lockedUntil));

    return { failures, firstAt, lastAt: now, lockedUntil };
  }

  clearLoginAttempts(scope: string, subject: string): void {
    this.db.prepare('DELETE FROM login_attempts WHERE scope = ? AND subject = ?').run(scope, subject);
  }

  pruneLoginAttempts(now = nowMs()): number {
    const result = this.db
      .prepare('DELETE FROM login_attempts WHERE last_at < ?')
      .run(now - 24 * 60 * 60 * 1000);
    return asNumber(result.changes, 0);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Row mappers
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function mapUser(row: unknown): UserRecord {
  const rec = row as Row;
  return {
    id: asString(rec.id),
    username: asString(rec.username),
    passwordHash: asString(rec.password_hash),
    isAdmin: asNumber(rec.is_admin, 0) !== 0,
    disabled: asNumber(rec.disabled, 0) !== 0,
    createdAt: asNumber(rec.created_at),
    updatedAt: asNumber(rec.updated_at),
    lastLoginAt: rec.last_login_at == null ? null : asNumber(rec.last_login_at),
  };
}

function mapSession(row: unknown): SessionRecord {
  const rec = row as Row;
  return {
    id: asString(rec.id),
    title: asString(rec.title),
    createdAt: asNumber(rec.created_at),
    updatedAt: asNumber(rec.updated_at),
    metadata: parseJson<Record<string, unknown>>(rec.metadata, {}),
  };
}

function mapMessage(row: unknown): MessageRecord {
  const rec = row as Row;
  const toolCalls = parseJson<ToolCall[] | undefined>(rec.tool_calls, undefined);
  const message: MessageRecord = {
    id: asString(rec.id),
    sessionId: asString(rec.session_id),
    seq: asNumber(rec.seq),
    role: asString(rec.role, 'user') as Role,
    content: typeof rec.content === 'string' ? rec.content : null,
    createdAt: asNumber(rec.created_at),
  };
  const name = asOptionalString(rec.name);
  if (name !== undefined) message.name = name;
  const toolCallId = asOptionalString(rec.tool_call_id);
  if (toolCallId !== undefined) message.toolCallId = toolCallId;
  if (toolCalls && Array.isArray(toolCalls)) message.toolCalls = toolCalls;
  return message;
}

function mapRun(row: unknown): RunRecord {
  const rec = row as Row;
  const run: RunRecord = {
    id: asString(rec.id),
    sessionId: asString(rec.session_id),
    status: asString(rec.status, 'running') as RunStatus,
    provider: asString(rec.provider),
    model: asString(rec.model),
    rounds: asNumber(rec.rounds),
    toolCalls: asNumber(rec.tool_calls),
    promptTokens: asNumber(rec.prompt_tokens),
    completionTokens: asNumber(rec.completion_tokens),
    startedAt: asNumber(rec.started_at),
  };
  const error = asOptionalString(rec.error);
  if (error !== undefined) run.error = error;
  if (rec.ended_at != null) run.endedAt = asNumber(rec.ended_at);
  return run;
}

function mapToolInvocation(row: unknown): ToolInvocationRecord {
  const rec = row as Row;
  const invocation: ToolInvocationRecord = {
    id: asString(rec.id),
    runId: asString(rec.run_id),
    name: asString(rec.name),
    args: parseJson<Record<string, unknown>>(rec.args, {}),
    ok: asNumber(rec.ok, 0) !== 0,
    content: asString(rec.content),
    durationMs: asNumber(rec.duration_ms),
    createdAt: asNumber(rec.created_at),
  };
  const error = asOptionalString(rec.error);
  if (error !== undefined) invocation.error = error;
  return invocation;
}
