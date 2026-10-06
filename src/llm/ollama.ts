/**
 * Native Ollama adapter.
 *
 * Talks to Ollama's own `/api/chat` (newline-delimited JSON) rather than its
 * OpenAI-compatible shim, for three reasons:
 *
 *   1. `options` (num_ctx, num_predict) and `keep_alive` are only honoured on
 *      the native API — essential for controlling a local model's memory use.
 *   2. The shim did not exist in older Ollama builds.
 *   3. Native tool calling is more faithful than the translated form.
 *
 * Only the parts Nami needs are implemented: chat streaming, model discovery,
 * version probing and pulling. Nami still *exposes* an OpenAI-compatible
 * surface on top (see routes/openai.ts); this file is the upstream client.
 */

import type { ChatMessage, Usage } from '../core/types.ts';
import type { ChatRequest, LLMProvider, ModelInfo, StreamChunk } from './types.ts';
import { LLMError, toWireTools } from './types.ts';

export interface OllamaProviderOptions {
  /** Native base URL, e.g. `http://127.0.0.1:11434` (no `/v1` suffix). */
  url: string;
  /** May be empty, in which case a model must be discovered or supplied. */
  model: string;
  timeoutMs: number;
  keepAlive: string;
  numCtx: number | null;
  headers?: Record<string, string>;
}

/** One entry from `/api/tags`. */
interface OllamaTag {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: {
    family?: string;
    families?: string[] | null;
    parameter_size?: string;
    quantization_level?: string;
    format?: string;
  };
}

interface OllamaChunk {
  model?: string;
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Message shape accepted by `/api/chat`. */
interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
}

function parseArguments(raw: string): Record<string, unknown> {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Converts internal messages into Ollama's native shape. */
export function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.map((message) => {
    const out: OllamaMessage = { role: message.role, content: message.content ?? '' };

    if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
      out.tool_calls = message.tool_calls.map((call) => ({
        function: {
          name: call.function.name,
          // Ollama wants a real object here; Nami stores the raw JSON string.
          arguments: parseArguments(call.function.arguments),
        },
      }));
    }

    // Ollama matches tool results to the preceding call by name, not by id.
    if (message.role === 'tool' && message.name) out.tool_name = message.name;

    return out;
  });
}

export class OllamaProvider implements LLMProvider {
  readonly id: string = 'ollama';

  private defaultModel: string;
  private readonly nativeUrl: string;
  private readonly timeoutMs: number;
  private readonly keepAlive: string;
  private readonly numCtx: number | null;
  private readonly headers: Record<string, string>;

  constructor(options: OllamaProviderOptions) {
    this.defaultModel = options.model;
    this.nativeUrl = options.url.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.keepAlive = options.keepAlive;
    this.numCtx = options.numCtx;
    this.headers = options.headers ?? {};
  }

  get model(): string {
    return this.defaultModel;
  }

  setDefaultModel(model: string): void {
    if (model.trim() !== '') this.defaultModel = model.trim();
  }

  get baseUrl(): string {
    return this.nativeUrl;
  }

  private url(path: string): string {
    return `${this.nativeUrl}${path}`;
  }

  private timeoutSignal(signal?: AbortSignal, overrideMs?: number): AbortSignal {
    const timeout = AbortSignal.timeout(overrideMs ?? this.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  /** Short probe used at boot; never throws. */
  async version(): Promise<string | null> {
    try {
      const response = await fetch(this.url('/api/version'), {
        headers: this.headers,
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { version?: string };
      return typeof payload.version === 'string' ? payload.version : null;
    } catch {
      return null;
    }
  }

  /** Models currently resident in memory (`/api/ps`). */
  async runningModels(): Promise<Array<{ name: string; sizeVram: number }>> {
    try {
      const response = await fetch(this.url('/api/ps'), {
        headers: this.headers,
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return [];
      const payload = (await response.json()) as {
        models?: Array<{ name?: string; model?: string; size_vram?: number }>;
      };
      return (payload.models ?? []).map((entry) => ({
        name: entry.name ?? entry.model ?? 'unknown',
        sizeVram: entry.size_vram ?? 0,
      }));
    } catch {
      return [];
    }
  }

  async listModelInfo(): Promise<ModelInfo[]> {
    const response = await fetch(this.url('/api/tags'), {
      headers: this.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new LLMError(`Ollama /api/tags returned ${response.status}`, {
        status: response.status,
      });
    }
    const payload = (await response.json()) as { models?: OllamaTag[] };

    return (payload.models ?? [])
      .map((tag) => {
        const id = tag.model ?? tag.name ?? '';
        const info: ModelInfo = {
          id,
          ownedBy: 'ollama',
          meta: {
            ...(tag.size !== undefined ? { sizeBytes: tag.size } : {}),
            ...(tag.details?.parameter_size ? { parameters: tag.details.parameter_size } : {}),
            ...(tag.details?.quantization_level
              ? { quantization: tag.details.quantization_level }
              : {}),
            ...(tag.details?.family ? { family: tag.details.family } : {}),
            ...(tag.digest ? { digest: tag.digest } : {}),
          },
        };
        if (tag.modified_at) {
          const parsed = Date.parse(tag.modified_at);
          if (Number.isFinite(parsed)) info.created = Math.floor(parsed / 1000);
        }
        return info;
      })
      .filter((info) => info.id !== '');
  }

  /**
   * Pulls a model, reporting progress. Used by `npm run ollama`, never on the
   * request path — a silent multi-gigabyte download would be hostile.
   */
  async pull(
    model: string,
    onProgress?: (status: string, completed: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(this.url('/api/pull'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers },
      body: JSON.stringify({ model, stream: true }),
      signal: this.timeoutSignal(signal, 60 * 60_000),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new LLMError(`Ollama refused to pull "${model}": ${detail.slice(0, 300)}`, {
        status: response.status,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (line === '') continue;
          try {
            const event = JSON.parse(line) as {
              status?: string;
              completed?: number;
              total?: number;
              error?: string;
            };
            if (event.error) throw new LLMError(event.error);
            onProgress?.(event.status ?? '', event.completed ?? 0, event.total ?? 0);
          } catch (error) {
            if (error instanceof LLMError) throw error;
            // Ignore malformed progress lines.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const model = request.model?.trim() || this.defaultModel;
    if (model === '') {
      throw new LLMError(
        'No Ollama model selected. Set NAMI_LLM_MODEL, or run `npm run ollama` to pick one.',
        { code: 'model_required' },
      );
    }

    const options: Record<string, unknown> = {};
    if (request.temperature !== undefined) options.temperature = request.temperature;
    if (request.maxTokens !== undefined) options.num_predict = request.maxTokens;
    if (this.numCtx !== null) options.num_ctx = this.numCtx;

    const body: Record<string, unknown> = {
      model,
      messages: toOllamaMessages(request.messages),
      stream: true,
    };
    if (request.tools && request.tools.length > 0) body.tools = toWireTools(request.tools);
    if (Object.keys(options).length > 0) body.options = options;
    if (this.keepAlive !== '') body.keep_alive = this.keepAlive;

    let response: Response;
    try {
      response = await fetch(this.url('/api/chat'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.headers },
        body: JSON.stringify(body),
        signal: this.timeoutSignal(request.signal),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new LLMError(
        `Cannot reach Ollama at ${this.nativeUrl}: ${message}. ` +
          'Is it running? Try `ollama serve`.',
        { code: 'ollama_unreachable' },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let message = detail.slice(0, 300);
      try {
        const parsed = JSON.parse(detail) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        /* keep the raw text */
      }
      throw new LLMError(
        `Ollama rejected the request (${response.status}): ${message}`,
        { status: response.status, code: response.status === 404 ? 'model_not_found' : undefined },
      );
    }
    if (!response.body) throw new LLMError('Ollama returned an empty body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: Usage | null = null;
    let reason: string | null = null;
    let finished = false;

    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (line === '') continue;

          let chunk: OllamaChunk;
          try {
            chunk = JSON.parse(line) as OllamaChunk;
          } catch {
            continue; // tolerate a partial or noisy line
          }

          if (chunk.error) throw new LLMError(chunk.error, { code: 'ollama_error' });

          const content = chunk.message?.content;
          if (typeof content === 'string' && content.length > 0) {
            yield { type: 'text', text: content };
          }

          const toolCalls = chunk.message?.tool_calls;
          if (Array.isArray(toolCalls)) {
            for (let index = 0; index < toolCalls.length; index += 1) {
              const call = toolCalls[index];
              const name = call?.function?.name;
              if (typeof name !== 'string' || name === '') continue;
              yield {
                type: 'tool_call',
                index,
                // Ollama does not issue ids; synthesise one so the agent loop can
                // correlate the tool result with this call.
                id: `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
                name,
                argsDelta: JSON.stringify(call?.function?.arguments ?? {}),
              };
            }
          }

          if (chunk.done) {
            const prompt = chunk.prompt_eval_count ?? 0;
            const completion = chunk.eval_count ?? 0;
            usage = {
              prompt_tokens: prompt,
              completion_tokens: completion,
              total_tokens: prompt + completion,
            };
            reason = chunk.done_reason ?? 'stop';
            finished = true;
            break;
          }
        }
      }
    } finally {
      reader.releaseLock();
      if (!finished) await reader.cancel().catch(() => {});
    }

    yield {
      type: 'finish',
      reason,
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}
