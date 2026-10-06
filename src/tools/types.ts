/**
 * Tool contracts.
 *
 * A tool is a plain object with a JSON Schema and a handler. The registry owns
 * advertisement to the model; the sandbox owns validation and execution.
 */

import type { DangerLevel, JsonSchema } from '../core/types.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { SessionStore } from '../store/store.ts';

export interface ToolContext {
  sessionId: string;
  runId: string;
  /** Aborted when the run is cancelled or the per-tool timeout elapses. */
  signal: AbortSignal;
  log: Logger;
  store: SessionStore;
  config: Config;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Advisory risk label surfaced in the admin panel and event stream. */
  danger?: DangerLevel;
  enabled?: boolean;
  /** May return any JSON-serialisable value; the sandbox stringifies it. */
  run(args: Record<string, unknown>, context: ToolContext): Promise<unknown> | unknown;
}
