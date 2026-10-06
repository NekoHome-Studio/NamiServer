/**
 * Provider factory.
 *
 * `mock` is the default so a fresh checkout is fully functional offline;
 * `ollama` targets a local Ollama daemon; `openai` covers any OpenAI-compatible
 * endpoint (OpenAI, DeepSeek, Groq, vLLM, LM Studio, ...).
 */

import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import { MockProvider } from './mock.ts';
import { OllamaProvider } from './ollama.ts';
import { OpenAiProvider } from './openai.ts';
import type { LLMProvider } from './types.ts';

export function createProvider(config: Config, log?: Logger): LLMProvider {
  if (config.llm.provider === 'ollama') {
    log?.info('using the native Ollama adapter', {
      url: config.ollama.url,
      model: config.llm.model || '(auto-discover)',
      keepAlive: config.ollama.keepAlive,
      numCtx: config.ollama.numCtx ?? '(ollama default)',
    });
    return new OllamaProvider({
      url: config.ollama.url,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
      keepAlive: config.ollama.keepAlive,
      numCtx: config.ollama.numCtx,
      headers: config.llm.extraHeaders,
    });
  }

  if (config.llm.provider === 'openai') {
    if (config.llm.apiKey === '') {
      log?.warn(
        'NAMI_LLM_PROVIDER=openai but NAMI_LLM_API_KEY is empty; ' +
          'this is fine for local servers (Ollama, LM Studio, vLLM) but will fail against hosted APIs.',
        { baseUrl: config.llm.baseUrl, model: config.llm.model },
      );
    }
    return new OpenAiProvider({
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
      headers: config.llm.extraHeaders,
    });
  }

  return new MockProvider({ model: config.llm.model, delayMs: config.llm.mockDelayMs });
}

export { MockProvider } from './mock.ts';
export { OllamaProvider } from './ollama.ts';
export { OpenAiProvider } from './openai.ts';
export { ModelRouter } from './router.ts';
export type { ModelEntry, Resolution } from './router.ts';
export { collectTurn, ToolCallAccumulator } from './collect.ts';
export type { AssistantTurn, ChatRequest, LLMProvider, ModelInfo, StreamChunk } from './types.ts';
export { LLMError, toWireTools } from './types.ts';
