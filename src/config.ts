/**
 * Environment-driven configuration.
 *
 * Loads `.env` (via Node's built-in `process.loadEnvFile`, falling back to a
 * tiny parser), then reads every tunable from `process.env` with safe defaults
 * so the server boots with zero configuration.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LogLevel } from './logger.ts';
import { LOG_LEVELS } from './logger.ts';

export const VERSION = '1.0.0';

export interface RateLimitConfig {
  enabled: boolean;
  /** Maximum burst size (tokens) per API key. */
  capacity: number;
  /** Tokens replenished per second. */
  refillPerSecond: number;
}

export interface AgentConfig {
  systemPrompt: string;
  maxRounds: number;
  toolTimeoutMs: number;
  maxToolResultBytes: number;
  /** How many stored messages to replay into the model context. */
  maxHistoryMessages: number;
  temperature: number;
  maxTokens: number;
}

export interface LlmConfig {
  provider: 'mock' | 'openai' | 'ollama';
  baseUrl: string;
  apiKey: string;
  /** Empty means "discover at boot and adopt the first available model". */
  model: string;
  timeoutMs: number;
  /** Per-chunk delay for the offline mock model; 0 makes tests instant. */
  mockDelayMs: number;
  /** Extra headers forwarded on every upstream request. */
  extraHeaders: Record<string, string>;
}

/** Ollama-specific knobs. Only meaningful when `provider` is `ollama`. */
export interface OllamaConfig {
  /** Native API base, without the `/v1` suffix. */
  url: string;
  /** How long Ollama keeps the model resident in memory. */
  keepAlive: string;
  /** Context window (`num_ctx`). `null` leaves Ollama's own default alone. */
  numCtx: number | null;
  /** Timeout for discovery probes, kept short so boot is never blocked. */
  probeTimeoutMs: number;
}

/**
 * Model exposure policy for hosting Nami as a shared OpenAI-compatible endpoint.
 */
export interface ModelsConfig {
  /**
   * Client-facing model names to expose. Empty exposes every discovered model.
   * Entries are matched against what the *client* sends, so alias names go here.
   */
  expose: string[];
  /** Client-facing name -> real upstream model, e.g. `gpt-4o-mini=qwen2.5:7b`. */
  aliases: Record<string, string>;
  /** When false, every request uses the server default regardless of `model`. */
  allowClientModel: boolean;
  /** How long a discovery result stays fresh. */
  cacheTtlMs: number;
}

export interface ToolsConfig {
  httpEnabled: boolean;
  httpAllowHosts: string[];
  httpTimeoutMs: number;
  httpMaxBytes: number;
  fsEnabled: boolean;
  fsAllowRoots: string[];
  fsMaxBytes: number;
  memoryEnabled: boolean;
}

export interface WsConfig {
  path: string;
  maxPayloadBytes: number;
  heartbeatMs: number;
  maxConnectionsPerKey: number;
}

/** Accepted values for `NAMI_ONEBOT_TRIGGER`. */
export const ONEBOT_TRIGGERS = ['mention', 'prefix', 'all', 'none'] as const;
export type OneBotTrigger = (typeof ONEBOT_TRIGGERS)[number];

function normaliseTrigger(raw: string): OneBotTrigger {
  const value = raw.trim().toLowerCase();
  return (ONEBOT_TRIGGERS as readonly string[]).includes(value)
    ? (value as OneBotTrigger)
    : 'mention';
}

/**
 * Default QQ persona.
 *
 * QQ renders no Markdown at all, so asking the model for plain prose up front is
 * far more reliable than stripping syntax after the fact.
 */
export const DEFAULT_ONEBOT_SYSTEM_PROMPT =
  '你正在一个 QQ 群里参与对话。请用简短、口语化的中文回答，尽量控制在几句话之内。' +
  '回复必须是纯文本：不要使用 Markdown、不要输出代码块、不要用 ** 加粗、不要输出表格或标题。' +
  '需要调用工具时直接调用，不要先说明你要调用什么。';

/**
 * OneBot v11 connector (SnowLuma, NapCat, LLOneBot, Lagrange, ...).
 *
 * Two independent directions:
 *   - **inbound**: `POST /onebot/event` accepts event reports, runs the agent and
 *     replies through the OneBot HTTP API.
 *   - **outbound**: tools that let the agent act on QQ proactively.
 *
 * Both default to off, because an inbound endpoint that triggers LLM calls and
 * an agent that can send arbitrary messages are both things you want to opt into
 * deliberately.
 */
export interface OneBotConfig {
  enabled: boolean;
  /** OneBot v11 HTTP API base, e.g. `http://127.0.0.1:3000` (no path suffix). */
  url: string;
  /** OneBot `access_token`, sent as `Authorization: Bearer`. */
  accessToken: string;
  /** Shared secret required on inbound reports; inbound stays closed without it. */
  eventToken: string;
  timeoutMs: number;

  inbound: {
    enabled: boolean;
    /** When the bot should answer: @-mention, a text prefix, everything, or never. */
    trigger: OneBotTrigger;
    prefix: string;
    /** Groups allowed to trigger the bot; empty allows every group. */
    allowGroups: string[];
    /** Users allowed to trigger the bot; empty allows every user. */
    allowUsers: string[];
    /** Nami session ids become `<prefix>-group-<id>` / `<prefix>-user-<id>`. */
    sessionPrefix: string;
    systemPrompt: string;
    /** QQ truncates long messages, so replies are split at this size. */
    maxReplyChars: number;
    /** Strip Markdown, which QQ does not render. */
    stripMarkdown: boolean;
    /** Cap on simultaneous QQ-triggered runs. */
    maxConcurrent: number;
  };

  tools: {
    enabled: boolean;
    /** Groups the agent may send to proactively; empty disables sending entirely. */
    allowGroups: string[];
    /** Users the agent may private-message proactively. */
    allowUsers: string[];
  };
}

/**
 * Console account/password authentication.
 *
 * API keys keep working for `/v1/*` and for tooling; this section is about the
 * human logging into the WebUI.
 */
export interface AuthConfig {
  /**
   * Username seeded on first boot. Only used while the `users` table is empty —
   * after that the database is authoritative, so removing the variable cannot
   * silently change (or re-create) an account.
   */
  bootstrapUser: string;
  /**
   * Plain-text password for that first account. Read once, hashed with scrypt,
   * and never stored. Empty means "generate a random one and print it", which
   * keeps a fresh install from coming up with a guessable default.
   */
  bootstrapPassword: string;
  /** How long a console login lasts. */
  sessionTtlMs: number;
  cookieName: string;
  /** `auto` marks the cookie Secure whenever the request looks like HTTPS. */
  cookieSecure: 'auto' | 'always' | 'never';
  /**
   * Trust `X-Forwarded-Proto`. Off by default because any client can send that
   * header; turn it on only behind a reverse proxy you control.
   */
  trustProxy: boolean;
  /** Failures before a lockout, counted per username and per client address. */
  maxAttempts: number;
  lockoutMs: number;
  /** Failures older than this start a fresh count. */
  attemptWindowMs: number;
}

export interface Config {
  version: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  logFormat: 'json' | 'pretty';
  /**
   * Lowest level buffered for the WebUI log page. Deliberately separate from
   * `logLevel`: quieting the console should not empty the UI.
   */
  logCaptureLevel: LogLevel;
  /** Ring-buffer size behind the WebUI log page. */
  logBufferSize: number;

  /** Accepted bearer tokens for `/v1/*`. */
  apiKeys: string[];
  /** Token for `/admin/api/*`; falls back to accepting API keys when unset. */
  adminToken: string | null;
  /** True when auth was auto-generated for a first run. */
  generatedKey: string | null;

  auth: AuthConfig;

  corsOrigin: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;

  dbPath: string;
  /** Absolute path of the `.env` this process would load, exposed for the editor. */
  envPath: string;
  agent: AgentConfig;
  llm: LlmConfig;
  ollama: OllamaConfig;
  models: ModelsConfig;
  tools: ToolsConfig;
  rateLimit: RateLimitConfig;
  ws: WsConfig;
  onebot: OneBotConfig;
}

function loadDotEnv(cwd: string): void {
  const file = resolve(cwd, '.env');
  // Node >= 20.12 exposes loadEnvFile and throws when the file is absent.
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader === 'function') {
    try {
      loader.call(process, file);
      return;
    } catch {
      /* fall through to the manual parser */
    }
  }
  try {
    const text = readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    /* no .env file: defaults apply */
  }
}

/**
 * Reads a string setting.
 *
 * Trims, because a `.env` written on Windows may carry CRLF endings and not
 * every consumer strips the `\r`: Node's `loadEnvFile` does, but Docker Compose
 * parses `env_file` with its own implementation and a `.env` edited in Notepad
 * is a realistic way to get a trailing carriage return into a value. Untrimmed,
 * `NAMI_LLM_PROVIDER=ollama\r` would silently fall back to the mock provider.
 */
function envStr(key: string, fallback: string): string {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function envInt(key: string, fallback: number, min = Number.MIN_SAFE_INTEGER): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Reads one of a fixed set of values; anything else falls back silently. */
function envEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function envList(key: string): string[] {
  const raw = process.env[key];
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the full configuration.
 *
 * Note: this **writes** into `process.env` (that is how `.env` loading works)
 * and never clears keys it did not set. Call it once per process; a second call
 * with a different `env` will still see values from the first. Tests should
 * clear their own `NAMI_*` keys between fixtures.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  const cwd = options.cwd ?? process.cwd();
  if (!options.env) loadDotEnv(cwd);
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value !== undefined) process.env[key] = value;
    }
  }

  const apiKeys = envList('NAMI_API_KEYS');
  let generatedKey: string | null = null;
  if (apiKeys.length === 0) {
    generatedKey = `nami_${randomBytes(24).toString('base64url')}`;
    apiKeys.push(generatedKey);
  }

  const levelRaw = envStr('NAMI_LOG_LEVEL', 'info').toLowerCase();
  const logLevel = (LOG_LEVELS as readonly string[]).includes(levelRaw)
    ? (levelRaw as LogLevel)
    : 'info';

  // `silent` is meaningful for the console but would make the WebUI log page
  // permanently empty, so it is not accepted as a capture level.
  const captureRaw = envStr('NAMI_LOG_CAPTURE_LEVEL', 'info').toLowerCase();
  const logCaptureLevel = ((LOG_LEVELS as readonly string[]).includes(captureRaw) &&
    captureRaw !== 'silent'
    ? captureRaw
    : 'info') as LogLevel;

  const extraHeaders: Record<string, string> = {};
  for (const pair of envList('NAMI_LLM_HEADERS')) {
    const eq = pair.indexOf('=');
    if (eq > 0) extraHeaders[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  // `client=upstream,client2=upstream2`
  const aliases: Record<string, string> = {};
  for (const pair of envList('NAMI_MODEL_ALIASES')) {
    const eq = pair.indexOf('=');
    if (eq > 0) aliases[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }

  const ollamaUrl = envStr('NAMI_OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, '');

  const providerRaw = envStr('NAMI_LLM_PROVIDER', '').toLowerCase();
  // Pointing NAMI_OLLAMA_URL at a server is enough to select the Ollama adapter,
  // so the one-click setup script only has to write one variable.
  const provider: LlmConfig['provider'] =
    providerRaw === 'openai'
      ? 'openai'
      : providerRaw === 'ollama' || (providerRaw === '' && process.env.NAMI_OLLAMA_URL)
        ? 'ollama'
        : 'mock';

  const defaultModel =
    provider === 'mock' ? 'nami-mock-1' : provider === 'ollama' ? '' : 'gpt-4o-mini';
  const defaultBaseUrl = provider === 'ollama' ? `${ollamaUrl}/v1` : 'https://api.openai.com/v1';

  const numCtxRaw = envInt('NAMI_OLLAMA_NUM_CTX', 0, 0);

  const config: Config = {
    version: VERSION,
    host: envStr('NAMI_HOST', '127.0.0.1'),
    port: envInt('NAMI_PORT', 8787, 0),
    logLevel,
    logFormat: envStr('NAMI_LOG_FORMAT', 'pretty') === 'json' ? 'json' : 'pretty',
    logCaptureLevel,
    logBufferSize: envInt('NAMI_LOG_BUFFER_SIZE', 1000, 50),

    apiKeys,
    adminToken: process.env.NAMI_ADMIN_TOKEN?.trim() || null,
    generatedKey,

    auth: {
      bootstrapUser: envStr('NAMI_ADMIN_USER', 'admin'),
      // Not trimmed: a leading/trailing space can be a deliberate part of a
      // passphrase, and `.env` parsing already strips the quoting.
      bootstrapPassword: envStr('NAMI_ADMIN_PASSWORD', ''),
      sessionTtlMs: envInt('NAMI_SESSION_TTL_HOURS', 168, 1) * 3_600_000,
      cookieName: envStr('NAMI_SESSION_COOKIE', 'nami_session'),
      cookieSecure: envEnum('NAMI_COOKIE_SECURE', ['auto', 'always', 'never'] as const, 'auto'),
      trustProxy: envBool('NAMI_TRUST_PROXY', false),
      maxAttempts: envInt('NAMI_LOGIN_MAX_ATTEMPTS', 5, 1),
      lockoutMs: envInt('NAMI_LOGIN_LOCKOUT_SECONDS', 300, 0) * 1000,
      attemptWindowMs: envInt('NAMI_LOGIN_WINDOW_SECONDS', 900, 0) * 1000,
    },

    corsOrigin: envStr('NAMI_CORS_ORIGIN', '*'),
    maxBodyBytes: envInt('NAMI_MAX_BODY_BYTES', 1_048_576, 1024),
    requestTimeoutMs: envInt('NAMI_REQUEST_TIMEOUT_MS', 120_000, 1000),
    shutdownGraceMs: envInt('NAMI_SHUTDOWN_GRACE_MS', 8000, 0),

    dbPath: envStr('NAMI_DB_PATH', resolve(cwd, 'data', 'nami.sqlite')),
    // Overridable so tests (and multi-instance setups) never touch the real
    // `.env`. Note this one is intentionally absent from the config editor:
    // offering to rewrite the path of the file you are editing is a trap.
    envPath: resolve(cwd, envStr('NAMI_ENV_PATH', '.env')),

    agent: {
      systemPrompt: envStr(
        'NAMI_SYSTEM_PROMPT',
        'You are Nami, a concise and reliable assistant running inside the Nami agent server. ' +
          'Use the available tools whenever they let you answer more accurately. ' +
          'When you call a tool, wait for its result before answering.',
      ),
      maxRounds: envInt('NAMI_MAX_TOOL_ROUNDS', 6, 1),
      toolTimeoutMs: envInt('NAMI_TOOL_TIMEOUT_MS', 15_000, 100),
      maxToolResultBytes: envInt('NAMI_MAX_TOOL_RESULT_BYTES', 32_768, 256),
      maxHistoryMessages: envInt('NAMI_MAX_HISTORY_MESSAGES', 40, 2),
      temperature: envFloat('NAMI_TEMPERATURE', 0.7),
      maxTokens: envInt('NAMI_MAX_TOKENS', 1024, 1),
    },

    llm: {
      provider,
      baseUrl: envStr('NAMI_LLM_BASE_URL', defaultBaseUrl).replace(/\/+$/, ''),
      apiKey: envStr('NAMI_LLM_API_KEY', provider === 'ollama' ? 'ollama' : ''),
      model: envStr('NAMI_LLM_MODEL', defaultModel),
      timeoutMs: envInt('NAMI_LLM_TIMEOUT_MS', provider === 'ollama' ? 300_000 : 120_000, 1000),
      mockDelayMs: envInt('NAMI_MOCK_DELAY_MS', 8, 0),
      extraHeaders,
    },

    ollama: {
      url: ollamaUrl,
      keepAlive: envStr('NAMI_OLLAMA_KEEP_ALIVE', '5m'),
      numCtx: numCtxRaw > 0 ? numCtxRaw : null,
      probeTimeoutMs: envInt('NAMI_OLLAMA_PROBE_TIMEOUT_MS', 4000, 200),
    },

    models: {
      expose: envList('NAMI_MODELS_EXPOSE'),
      aliases,
      allowClientModel: envBool('NAMI_ALLOW_CLIENT_MODEL', true),
      cacheTtlMs: envInt('NAMI_MODELS_CACHE_TTL_MS', 30_000, 0),
    },

    tools: {
      httpEnabled: envBool('NAMI_TOOL_HTTP_ENABLED', false),
      httpAllowHosts: envList('NAMI_TOOL_HTTP_ALLOW_HOSTS'),
      httpTimeoutMs: envInt('NAMI_TOOL_HTTP_TIMEOUT_MS', 10_000, 100),
      httpMaxBytes: envInt('NAMI_TOOL_HTTP_MAX_BYTES', 262_144, 1024),
      fsEnabled: envBool('NAMI_TOOL_FS_ENABLED', false),
      fsAllowRoots: envList('NAMI_TOOL_FS_ALLOW_ROOTS').map((p) => resolve(cwd, p)),
      fsMaxBytes: envInt('NAMI_TOOL_FS_MAX_BYTES', 262_144, 1024),
      memoryEnabled: envBool('NAMI_TOOL_MEMORY_ENABLED', true),
    },

    rateLimit: {
      enabled: envBool('NAMI_RATE_LIMIT_ENABLED', true),
      capacity: envInt('NAMI_RATE_LIMIT_BURST', 60, 1),
      refillPerSecond: envFloat('NAMI_RATE_LIMIT_PER_SECOND', 1),
    },

    ws: {
      path: envStr('NAMI_WS_PATH', '/ws'),
      maxPayloadBytes: envInt('NAMI_WS_MAX_PAYLOAD_BYTES', 1_048_576, 1024),
      heartbeatMs: envInt('NAMI_WS_HEARTBEAT_MS', 30_000, 1000),
      maxConnectionsPerKey: envInt('NAMI_WS_MAX_CONNECTIONS_PER_KEY', 8, 1),
    },

    onebot: {
      enabled: envBool('NAMI_ONEBOT_ENABLED', false),
      url: envStr('NAMI_ONEBOT_URL', 'http://127.0.0.1:3000').replace(/\/+$/, ''),
      accessToken: envStr('NAMI_ONEBOT_ACCESS_TOKEN', ''),
      eventToken: envStr('NAMI_ONEBOT_EVENT_TOKEN', ''),
      timeoutMs: envInt('NAMI_ONEBOT_TIMEOUT_MS', 10_000, 100),

      inbound: {
        enabled: envBool('NAMI_ONEBOT_INBOUND_ENABLED', true),
        trigger: normaliseTrigger(envStr('NAMI_ONEBOT_TRIGGER', 'mention')),
        prefix: envStr('NAMI_ONEBOT_PREFIX', '/ai'),
        allowGroups: envList('NAMI_ONEBOT_ALLOW_GROUPS'),
        allowUsers: envList('NAMI_ONEBOT_ALLOW_USERS'),
        sessionPrefix: envStr('NAMI_ONEBOT_SESSION_PREFIX', 'qq'),
        systemPrompt: envStr('NAMI_ONEBOT_SYSTEM_PROMPT', DEFAULT_ONEBOT_SYSTEM_PROMPT),
        maxReplyChars: envInt('NAMI_ONEBOT_MAX_REPLY_CHARS', 1500, 50),
        stripMarkdown: envBool('NAMI_ONEBOT_STRIP_MARKDOWN', true),
        maxConcurrent: envInt('NAMI_ONEBOT_MAX_CONCURRENT', 2, 1),
      },

      tools: {
        enabled: envBool('NAMI_ONEBOT_TOOL_ENABLED', false),
        allowGroups: envList('NAMI_ONEBOT_TOOL_ALLOW_GROUPS'),
        allowUsers: envList('NAMI_ONEBOT_TOOL_ALLOW_USERS'),
      },
    },
  };

  return config;
}
