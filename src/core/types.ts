/**
 * Shared data types for the Nami agent server.
 *
 * This module is intentionally free of runtime imports so it can be referenced
 * from every layer without creating dependency cycles.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** OpenAI-shaped tool call emitted by a model. */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    /** Raw JSON string, exactly as the model produced it. */
    arguments: string;
  };
}

/** OpenAI-shaped chat message. */
export interface ChatMessage {
  role: Role;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export const EMPTY_USAGE: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/** The subset of JSON Schema the sandbox validator understands. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  default?: unknown;
}

export type DangerLevel = 'safe' | 'caution' | 'dangerous';

/** Tool metadata advertised to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  danger: DangerLevel;
  /** Disabled tools are advertised to nobody and reject direct invocation. */
  enabled: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** Stringified tool output handed back to the model. */
  content: string;
  error?: string;
  durationMs: number;
}

/* ------------------------------------------------------------------ *
 * Session persistence records
 * ------------------------------------------------------------------ */

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  seq: number;
  role: Role;
  content: string | null;
  name?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  createdAt: number;
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunRecord {
  id: string;
  sessionId: string;
  status: RunStatus;
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

export interface ToolInvocationRecord {
  id: string;
  runId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  content: string;
  error?: string;
  durationMs: number;
  createdAt: number;
}

/* ------------------------------------------------------------------ *
 * Console accounts and login sessions
 * ------------------------------------------------------------------ */

/**
 * A console account.
 *
 * `passwordHash` is present here because the store returns rows as-is; it must
 * never reach a response body. The route layer maps to `PublicUser` for that,
 * which is why the two types are separate rather than one with an optional field.
 */
export interface UserRecord {
  id: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

/** A user as it is safe to serialise: everything except the hash. */
export interface PublicUser {
  id: string;
  username: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

/** One browser login session. */
export interface AuthSessionRecord {
  userId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  userAgent: string | null;
  ip: string | null;
}

/** Failure counter backing the login lockout. */
export interface LoginAttemptRecord {
  failures: number;
  firstAt: number;
  lastAt: number;
  lockedUntil: number | null;
}

/* ------------------------------------------------------------------ *
 * Agent event stream
 * ------------------------------------------------------------------ */

export interface AgentEventMap {
  'run.start': { runId: string; sessionId: string; provider: string; model: string };
  'delta': { text: string };
  'tool.call': { id: string; name: string; args: Record<string, unknown>; danger: DangerLevel };
  'tool.result': {
    id: string;
    name: string;
    ok: boolean;
    content: string;
    error?: string;
    durationMs: number;
  };
  'run.end': {
    runId: string;
    sessionId: string;
    output: string;
    usage: Usage;
    rounds: number;
    toolCalls: number;
    durationMs: number;
  };
  'error': { message: string; code?: string };
}

export type AgentEventType = keyof AgentEventMap;

export type AgentEvent = {
  [K in AgentEventType]: { type: K; data: AgentEventMap[K] };
}[AgentEventType];

/** Convenience constructor that keeps the discriminant and payload in sync. */
export function agentEvent<K extends AgentEventType>(
  type: K,
  data: AgentEventMap[K],
): { type: K; data: AgentEventMap[K] } {
  return { type, data };
}
