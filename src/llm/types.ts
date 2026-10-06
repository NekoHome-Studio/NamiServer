/**
 * Provider-agnostic LLM contract.
 *
 * Streaming is the single primitive: non-streaming callers accumulate a stream
 * through `collectTurn`, which keeps every adapter small and guarantees the
 * agent loop and the OpenAI-compatible endpoint see identical semantics.
 */

import type { ChatMessage, ToolCall, ToolDefinition, Usage } from '../core/types.ts';

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Per-request model override, already resolved by the ModelRouter. Falls back
   * to the provider's default model when absent.
   */
  model?: string;
}

/**
 * A model the upstream provider reports as available.
 *
 * `meta` carries provider-specific detail (Ollama's parameter count, file size,
 * quantization, ...) that the admin panel surfaces but the agent never needs.
 */
export interface ModelInfo {
  id: string;
  ownedBy: string;
  /** Epoch seconds, when the provider reports a creation/modification time. */
  created?: number;
  meta?: Record<string, unknown>;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call';
      index: number;
      id?: string;
      name?: string;
      argsDelta?: string;
    }
  | { type: 'finish'; reason: string | null; usage: Usage };

export interface AssistantTurn {
  content: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: string | null;
}

export interface LLMProvider {
  readonly id: string;
  /** Model used when a request does not name one. */
  readonly model: string;
  /** Adopts a discovered model as the default; used at boot. */
  setDefaultModel(model: string): void;
  stream(request: ChatRequest): AsyncGenerator<StreamChunk, void, undefined>;
  /** Available models, with whatever metadata the provider can supply. */
  listModelInfo(): Promise<ModelInfo[]>;
}

export class LLMError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'LLMError';
    if (options.status !== undefined) this.status = options.status;
    if (options.code !== undefined) this.code = options.code;
  }
}

/** Converts internal tool definitions into the OpenAI `tools` wire shape. */
export function toWireTools(
  definitions: ToolDefinition[],
): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  return definitions.map((definition) => ({
    type: 'function' as const,
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
    },
  }));
}
