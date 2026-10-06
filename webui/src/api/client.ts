/**
 * Typed client for the Nami HTTP API.
 *
 * Two things are deliberate:
 *
 *   1. **The credential is sent as both `Authorization: Bearer` and
 *      `X-Admin-Token`.** One input field then works whether the server has an
 *      admin token configured or only API keys, which is what a single-login
 *      console needs.
 *   2. **Credentials are never logged or echoed.** Errors surface the server's
 *      own message, which never contains one.
 */

import { ref, type Ref } from 'vue';

/* ------------------------------------------------------------------ *
 * Wire types — kept in sync with src/routes/**
 * ------------------------------------------------------------------ */

export interface HealthResponse {
  status: string;
  version: string;
  uptimeSeconds: number;
  node: string;
  pid: number;
}

export interface ReadyzResponse {
  ready: boolean;
  checks: Record<string, string>;
  uptimeSeconds: number;
}

export interface ModelEntry {
  id: string;
  ownedBy: string;
  created?: number;
  aliases: string[];
  exposed: boolean;
  isDefault: boolean;
  meta?: Record<string, unknown>;
}

export interface ModelsResponse {
  object: string;
  provider: string;
  baseUrl: string;
  defaultModel: string;
  discoveryOk: boolean;
  lastError: string | null;
  allowClientModel: boolean;
  expose: string[];
  aliases: Record<string, string>;
  data: ModelEntry[];
}

export interface OpenAiModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  nami?: Record<string, unknown>;
}

export interface ToolEntry {
  name: string;
  description: string;
  danger: 'safe' | 'caution' | 'dangerous';
  enabled: boolean;
  implemented: boolean;
  parameters: Record<string, unknown>;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
  messageCount?: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Message {
  id: string;
  sessionId: string;
  seq: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  createdAt: number;
}

export interface SessionDetail {
  object: string;
  session: Session;
  messages: Message[];
  memory: Record<string, unknown>;
}

export interface Run {
  id: string;
  sessionId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  provider: string;
  model: string;
  rounds: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface MetricsSnapshot {
  startedAt: number;
  uptimeSeconds: number;
  requests: {
    total: number;
    byStatus: Record<string, number>;
    byRoute: Record<string, number>;
    rejectedAuth: number;
    rejectedRateLimit: number;
    errors: number;
  };
  agent: {
    runsStarted: number;
    runsCompleted: number;
    runsFailed: number;
    runsCancelled: number;
    toolCalls: number;
    deltaEvents: number;
    streamedChars: number;
  };
  websocket: {
    connectionsOpened: number;
    connectionsClosed: number;
    active: number;
    messagesIn: number;
    messagesOut: number;
  };
  onebot: {
    eventsReceived: number;
    eventsHandled: number;
    eventsSkipped: number;
    repliesSent: number;
    failures: number;
  };
  transfer: { requestBytes: number; responseBytes: number };
}

export interface OverviewResponse {
  version: string;
  startedAt: number;
  uptimeSeconds: number;
  provider: string;
  model: string;
  models: {
    defaultModel: string;
    discovered: number;
    discoveryOk: boolean;
    lastError: string | null;
    exposed: string[];
    aliases: string[];
    allowClientModel: boolean;
  };
  tools: { total: number; enabled: number; names: string[] };
  apiKeys: { count: number; generated: boolean };
  rateLimit: { enabled: boolean; burst: number; perSecond: number; trackedKeys: number };
  websocket: { path: string; activeConnections: number; maxPerConnection: number };
  store: { counts: Record<string, number>; dbPath: string };
  onebot:
    | { enabled: false }
    | {
        enabled: true;
        url: string;
        inboundReady: boolean;
        trigger: string;
        sendingEnabled: boolean;
        stats: Record<string, number | string | null>;
      };
}

export interface ToolUsageStat {
  name: string;
  calls: number;
  failures: number;
  avgMs: number;
}

export interface StatsResponse {
  counts: { sessions: number; messages: number; runs: number; toolInvocations: number };
  recentRuns: Run[];
  toolUsage: ToolUsageStat[];
  uptimeSeconds: number;
}

export interface LogEntry {
  seq: number;
  time: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  msg: string;
  fields: Record<string, unknown>;
}

export interface LogsResponse {
  object: string;
  data: LogEntry[];
  captureLevel: string;
  availableLevels: string[];
  buffered: number;
  capacity: number;
  dropped: number;
  lastSeq: number;
}

export interface OneBotStatus {
  object: string;
  enabled: boolean;
  url: string;
  accessTokenConfigured: boolean;
  eventTokenConfigured: boolean;
  inbound: {
    enabled: boolean;
    path: string;
    trigger: string;
    prefix: string;
    allowGroups: string[];
    allowUsers: string[];
    sessionPrefix: string;
    maxReplyChars: number;
    stripMarkdown: boolean;
    maxConcurrent: number;
    ready: boolean;
  };
  tools: {
    enabled: boolean;
    sendingEnabled: boolean;
    allowGroups: string[];
    allowUsers: string[];
  };
  bridge: {
    received: number;
    handled: number;
    skipped: number;
    replies: number;
    busy: number;
    failures: number;
    lastEventAt: number | null;
    lastReason: string | null;
    activeRuns: number;
  };
  connection: {
    reachable: boolean;
    account?: { userId: number; nickname: string } | null;
    online?: boolean | null;
    good?: boolean | null;
    error?: string;
  };
}

export interface PublicConfig {
  host: string;
  port: number;
  logLevel: string;
  logFormat: string;
  logCaptureLevel: string;
  logBufferSize: number;
  corsOrigin: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  dbPath: string;
  apiKeys: { count: number; generated: boolean };
  adminToken: { configured: boolean };
  agent: Record<string, unknown>;
  llm: {
    provider: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
    apiKey: { configured: boolean };
    headerNames: string[];
  };
  ollama: Record<string, unknown>;
  models: Record<string, unknown>;
  tools: Record<string, unknown>;
  rateLimit: Record<string, unknown>;
  ws: Record<string, unknown>;
  onebot: Record<string, unknown>;
}

export interface ConfigResponse {
  object: string;
  config: PublicConfig;
}

/** A single editable setting, as described by the server. */
export interface ConfigField {
  key: string;
  group: string;
  type: 'string' | 'int' | 'float' | 'bool' | 'list' | 'enum';
  secret: boolean;
  restartRequired: boolean;
  options?: readonly string[];
  description: string;
  /** Current effective value; always `null` for secrets. */
  value: string | number | boolean | string[] | null;
  /** Secrets only: whether a value is currently configured. Never the value. */
  configured?: boolean;
}

export interface ConfigSchemaResponse {
  object: string;
  fields: ConfigField[];
  /** Group names in the server's declaration order, for stable form layout. */
  groups: string[];
  envFile: { path: string; exists: boolean; writable: boolean };
  /** Server-supplied explanation of the restart requirement. */
  note?: string;
}

export interface ConfigSaveResult {
  object: string;
  written: string;
  applied: Array<{ key: string; from: string | null; to: string; secret: boolean }>;
  restartRequired: boolean;
  note?: string;
}

/* ------------------------------------------------------------------ *
 * Agent event stream (SSE over POST)
 * ------------------------------------------------------------------ */

export type AgentEvent =
  | { type: 'run.start'; data: { runId: string; sessionId: string; provider: string; model: string } }
  | { type: 'delta'; data: { text: string } }
  | {
      type: 'tool.call';
      data: { id: string; name: string; args: Record<string, unknown>; danger: string };
    }
  | {
      type: 'tool.result';
      data: { id: string; name: string; ok: boolean; content: string; error?: string; durationMs: number };
    }
  | {
      type: 'run.end';
      data: {
        runId: string;
        sessionId: string;
        output: string;
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        rounds: number;
        toolCalls: number;
        durationMs: number;
      };
    }
  | { type: 'error'; data: { message: string; code?: string } };

export interface AgentRunRequest {
  input: string;
  sessionId?: string;
  model?: string;
  system?: string;
  maxRounds?: number;
  temperature?: number;
  maxTokens?: number;
}

/* ------------------------------------------------------------------ *
 * Errors and client
 * ------------------------------------------------------------------ */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  /**
   * Structured per-field detail, when the endpoint provides it.
   *
   * The config editor's 400 response carries an array of `{ key, message }` here
   * while its human-readable `message` is deliberately generic — without this
   * the operator would see "some settings were rejected" and have to guess which.
   */
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, requestId?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (requestId !== undefined) this.requestId = requestId;
    if (details !== undefined) this.details = details;
  }

  /** True when the credential is missing, wrong, or lacks admin rights. */
  get isAuthProblem(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** `details` narrowed to the field-error shape, when that is what it is. */
  get fieldErrors(): Array<{ key: string; message: string }> {
    if (!Array.isArray(this.details)) return [];
    return this.details.filter(
      (entry): entry is { key: string; message: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { key?: unknown }).key === 'string' &&
        typeof (entry as { message?: unknown }).message === 'string',
    );
  }
}

const STORAGE_KEY = 'nami.credential';

export class NamiClient {
  /** Reactive so the shell can react to sign-in/out. */
  readonly credential: Ref<string> = ref('');

  constructor() {
    try {
      this.credential.value = localStorage.getItem(STORAGE_KEY) ?? '';
    } catch {
      // Private-mode or storage disabled: the console still works, it just
      // will not remember the credential across reloads.
      this.credential.value = '';
    }
  }

  get authenticated(): boolean {
    return this.credential.value.trim() !== '';
  }

  setCredential(value: string): void {
    const trimmed = value.trim();
    this.credential.value = trimmed;
    try {
      if (trimmed === '') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      /* storage unavailable */
    }
  }

  clearCredential(): void {
    this.setCredential('');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra };
    const credential = this.credential.value.trim();
    if (credential !== '') {
      // Both, so a single field satisfies either auth scheme on the server.
      headers.authorization = `Bearer ${credential}`;
      headers['x-admin-token'] = credential;
    }
    return headers;
  }

  /** Performs a request and decodes the standard error envelope. */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(path, { ...init, headers: this.headers(init.headers as Record<string, string>) });
    } catch (error) {
      throw new ApiError(0, 'network_error', error instanceof Error ? error.message : String(error));
    }

    const text = await response.text();
    let payload: unknown = undefined;
    if (text !== '') {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
    }

    if (!response.ok) {
      const envelope = (
        payload as
          | { error?: { message?: string; code?: string; request_id?: string; details?: unknown } }
          | undefined
      )?.error;
      throw new ApiError(
        response.status,
        envelope?.code ?? `http_${response.status}`,
        envelope?.message ?? `请求失败（HTTP ${response.status}）`,
        envelope?.request_id,
        envelope?.details,
      );
    }

    return payload as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  private json<T>(path: string, method: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /* ---------------------------- endpoints ---------------------------- */

  health(): Promise<HealthResponse> {
    return this.get('/healthz');
  }

  readyz(): Promise<ReadyzResponse> {
    return this.get('/readyz');
  }

  overview(): Promise<OverviewResponse> {
    return this.get('/admin/api/overview');
  }

  metrics(): Promise<MetricsSnapshot> {
    return this.get('/admin/api/metrics');
  }

  stats(): Promise<StatsResponse> {
    return this.get('/admin/api/stats');
  }

  models(refresh = false): Promise<ModelsResponse> {
    return this.get(`/admin/api/models${refresh ? '?refresh=1' : ''}`);
  }

  openaiModels(): Promise<{ object: string; data: OpenAiModel[] }> {
    return this.get('/v1/models');
  }

  tools(): Promise<{ object: string; data: ToolEntry[] }> {
    return this.get('/admin/api/tools');
  }

  sessions(limit = 100): Promise<{ object: string; data: Session[] }> {
    return this.get(`/admin/api/sessions?limit=${limit}`);
  }

  session(id: string): Promise<SessionDetail> {
    return this.get(`/admin/api/sessions/${encodeURIComponent(id)}`);
  }

  deleteSession(id: string): Promise<{ deleted: boolean }> {
    return this.request(`/admin/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  renameSession(id: string, title: string): Promise<unknown> {
    return this.json(`/admin/api/sessions/${encodeURIComponent(id)}`, 'PUT', { title });
  }

  runs(limit = 30): Promise<{ object: string; data: Run[] }> {
    return this.get(`/admin/api/runs?limit=${limit}`);
  }

  run(id: string): Promise<{ object: string; run: Run; toolInvocations: unknown[] }> {
    return this.get(`/admin/api/runs/${encodeURIComponent(id)}`);
  }

  config(): Promise<ConfigResponse> {
    return this.get('/admin/api/config');
  }

  configSchema(): Promise<ConfigSchemaResponse> {
    return this.get('/admin/api/config/schema');
  }

  saveConfig(changes: Record<string, string>, options: { create?: boolean } = {}): Promise<ConfigSaveResult> {
    return this.json('/admin/api/config', 'PUT', { changes, confirm: true, ...options });
  }

  logs(limit = 300, level?: string): Promise<LogsResponse> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (level) params.set('level', level);
    return this.get(`/admin/api/logs?${params.toString()}`);
  }

  clearLogs(): Promise<{ cleared: number }> {
    return this.request('/admin/api/logs', { method: 'DELETE' });
  }

  onebotStatus(): Promise<OneBotStatus> {
    return this.get('/admin/api/onebot/status');
  }

  onebotSend(body: { text: string; group_id?: string; user_id?: string; at?: string }): Promise<unknown> {
    return this.json('/admin/api/onebot/send', 'POST', body);
  }

  onebotSimulate(event: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json('/admin/api/onebot/event', 'POST', event);
  }

  openapi(): Promise<Record<string, unknown>> {
    return this.get('/openapi.json');
  }

  /* --------------------------- streaming ---------------------------- */

  /**
   * Streams one agent turn.
   *
   * Uses `fetch` rather than `EventSource` because the endpoint is a POST with
   * a JSON body, which `EventSource` cannot express. Frames are parsed from a
   * growing text buffer, so a network chunk boundary in the middle of a frame
   * is handled correctly.
   */
  async streamAgentRun(
    body: AgentRunRequest,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch('/v1/agent/run', {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json', accept: 'text/event-stream' }),
      body: JSON.stringify({ ...body, stream: true }),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      let message = `请求失败（HTTP ${response.status}）`;
      let code = `http_${response.status}`;
      let details: unknown;
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; code?: string; details?: unknown } };
        if (parsed.error?.message) message = parsed.error.message;
        if (parsed.error?.code) code = parsed.error.code;
        details = parsed.error?.details;
      } catch {
        /* keep the generic message */
      }
      throw new ApiError(response.status, code, message, undefined, details);
    }
    if (!response.body) throw new ApiError(0, 'no_body', '服务器没有返回流式响应体');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');

          let eventName = 'message';
          const dataLines: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) continue;
          try {
            const data = JSON.parse(dataLines.join('\n')) as unknown;
            onEvent({ type: eventName, data } as AgentEvent);
          } catch {
            /* ignore a malformed frame rather than killing the stream */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Subscribes to the live log tail.
   *
   * `from` resumes after a sequence number, which the browser also sends
   * automatically as `Last-Event-ID` when it reconnects on its own.
   */
  subscribeLogs(
    handlers: { onEntry: (entry: LogEntry) => void; onError?: (error: Event) => void },
    options: { level?: string; from?: number } = {},
  ): () => void {
    // EventSource cannot set headers, so the credential travels as a query
    // parameter — the only auth route the server accepts for a browser SSE
    // connection.
    const params = new URLSearchParams();
    const credential = this.credential.value.trim();
    if (credential !== '') params.set('key', credential);
    if (options.level) params.set('level', options.level);
    if (options.from && options.from > 0) params.set('since', String(options.from));

    const source = new EventSource(`/admin/api/logs/stream?${params.toString()}`);
    source.addEventListener('log', (event) => {
      try {
        handlers.onEntry(JSON.parse((event as MessageEvent).data) as LogEntry);
      } catch {
        /* ignore malformed frames */
      }
    });
    if (handlers.onError) source.addEventListener('error', handlers.onError);

    return () => source.close();
  }
}

/** Shared singleton; the shell and every view use the same credential. */
export const api = new NamiClient();
