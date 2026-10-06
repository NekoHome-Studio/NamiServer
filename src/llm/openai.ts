/**
 * Adapter for any OpenAI-compatible `/chat/completions` endpoint
 * (OpenAI, DeepSeek, Groq, Ollama, vLLM, LM Studio, ...).
 */

import type { Usage } from '../core/types.ts';
import type { ChatRequest, LLMProvider, ModelInfo, StreamChunk } from './types.ts';
import { LLMError, toWireTools } from './types.ts';

export interface OpenAiProviderOptions {
  id?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  /** Send `stream_options.include_usage`; auto-disabled if the server rejects it. */
  streamUsage?: boolean;
  /** Extra top-level fields merged into every request body. */
  extraBody?: Record<string, unknown>;
}

interface WireToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: WireToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  error?: { message?: string; type?: string; code?: string };
}

function normaliseUsage(raw: WireChunk['usage']): Usage {
  const prompt = Number(raw?.prompt_tokens ?? 0) || 0;
  const completion = Number(raw?.completion_tokens ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(raw?.total_tokens ?? prompt + completion) || prompt + completion,
  };
}

export class OpenAiProvider implements LLMProvider {
  readonly id: string;

  private defaultModel: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly extraBody: Record<string, unknown>;
  private streamUsage: boolean;

  constructor(options: OpenAiProviderOptions) {
    this.id = options.id ?? 'openai';
    this.defaultModel = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.headers = options.headers ?? {};
    this.extraBody = options.extraBody ?? {};
    this.streamUsage = options.streamUsage ?? true;
  }

  /** Model used when a request does not name one. */
  get model(): string {
    return this.defaultModel;
  }

  setDefaultModel(model: string): void {
    if (model.trim() !== '') this.defaultModel = model.trim();
  }

  /** Resolves the effective model for a request, or throws a usable error. */
  protected resolveModel(request: ChatRequest): string {
    const model = request.model?.trim() || this.defaultModel;
    if (model === '') {
      throw new LLMError(
        'No model selected. Set NAMI_LLM_MODEL, or pass "model" in the request.',
        { code: 'model_required' },
      );
    }
    return model;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.headers,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  /** Combines the configured timeout with the caller's cancellation signal. */
  private timeoutSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private buildBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      ...this.extraBody,
      model: this.resolveModel(request),
      messages: request.messages,
      stream,
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.tools && request.tools.length > 0) {
      body.tools = toWireTools(request.tools);
      body.tool_choice = 'auto';
    }
    if (stream && this.streamUsage) body.stream_options = { include_usage: true };
    return body;
  }

  private async post(
    request: ChatRequest,
    stream: boolean,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.requestHeaders(),
      body: JSON.stringify(body),
      signal: this.timeoutSignal(request.signal),
    });
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk, void, undefined> {
    let response = await this.post(request, true, this.buildBody(request, true));

    // Some OpenAI-compatible servers reject `stream_options`. Detect that
    // specific 4xx once, then stop sending it for the lifetime of this adapter.
    if (!response.ok && this.streamUsage && response.status >= 400 && response.status < 500) {
      const detail = await response.text().catch(() => '');
      if (/stream_options/i.test(detail)) {
        this.streamUsage = false;
        response = await this.post(request, true, this.buildBody(request, true));
      } else {
        throw new LLMError(`upstream ${response.status}: ${truncate(detail)}`, {
          status: response.status,
        });
      }
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new LLMError(`upstream ${response.status}: ${truncate(detail)}`, {
        status: response.status,
      });
    }
    if (!response.body) {
      throw new LLMError('upstream returned an empty body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reason: string | null = null;
    let usage: Usage | null = null;
    let finished = false;

    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');

          if (line === '' || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            finished = true;
            break;
          }

          let parsed: WireChunk;
          try {
            parsed = JSON.parse(payload) as WireChunk;
          } catch {
            continue; // tolerate keep-alive or partial noise
          }

          if (parsed.error) {
            throw new LLMError(parsed.error.message ?? 'upstream stream error', {
              code: parsed.error.code ?? parsed.error.type,
            });
          }
          if (parsed.usage) usage = normaliseUsage(parsed.usage);

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          if (typeof choice.delta?.content === 'string' && choice.delta.content.length > 0) {
            yield { type: 'text', text: choice.delta.content };
          }

          const deltas = choice.delta?.tool_calls;
          if (Array.isArray(deltas)) {
            for (const delta of deltas) {
              const chunk: StreamChunk = {
                type: 'tool_call',
                index: typeof delta.index === 'number' ? delta.index : 0,
              };
              if (delta.id) chunk.id = delta.id;
              if (delta.function?.name) chunk.name = delta.function.name;
              if (delta.function?.arguments) chunk.argsDelta = delta.function.arguments;
              yield chunk;
            }
          }

          if (choice.finish_reason) reason = choice.finish_reason;
        }
      }
    } finally {
      reader.releaseLock();
      // Abort the socket when the consumer breaks out early.
      if (!finished) await reader.cancel().catch(() => {});
    }

    yield {
      type: 'finish',
      reason,
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  async listModelInfo(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(this.url('/models'), {
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 15_000)),
      });
      if (!response.ok) return this.fallbackModels();
      const payload = (await response.json()) as {
        data?: Array<{ id?: string; created?: number; owned_by?: string }>;
      };
      const models: ModelInfo[] = (payload.data ?? [])
        .filter((entry) => typeof entry.id === 'string' && entry.id !== '')
        .map((entry) => {
          const info: ModelInfo = { id: entry.id as string, ownedBy: entry.owned_by ?? this.id };
          if (typeof entry.created === 'number') info.created = entry.created;
          return info;
        });
      return models.length > 0 ? models : this.fallbackModels();
    } catch {
      // Discovery must never take the server down; the configured model still works.
      return this.fallbackModels();
    }
  }

  /** Last-resort listing so the endpoint is never empty. */
  private fallbackModels(): ModelInfo[] {
    return this.defaultModel === '' ? [] : [{ id: this.defaultModel, ownedBy: this.id }];
  }
}

function truncate(text: string, max = 400): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}
