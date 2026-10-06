/**
 * Deterministic offline provider.
 *
 * It exists so the server is fully exercisable with no API key and no network:
 * it streams token-by-token like a real model, and it emits genuine tool calls
 * for a handful of recognised intents so the whole tool loop can be tested
 * end to end.
 */

import type { ChatMessage, ToolCall, Usage } from '../core/types.ts';
import type { ChatRequest, LLMProvider, ModelInfo, StreamChunk } from './types.ts';

export interface MockProviderOptions {
  id?: string;
  model?: string;
  /** Per-chunk delay, giving the UI a realistic progressive reveal. */
  delayMs?: number;
  /** Chunk size in characters. */
  chunkSize?: number;
}

interface Intent {
  tool: string;
  args: Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

function textOf(message: ChatMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  return '';
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Pulls a plausible arithmetic expression out of free-form user text. */
function extractExpression(input: string): string | null {
  const match = input.match(/[-+*/%^().\d\s]{3,}/);
  if (!match) return null;
  const candidate = match[0].trim();
  return /\d/.test(candidate) ? candidate : null;
}

export class MockProvider implements LLMProvider {
  readonly id: string;

  private defaultModel: string;
  private readonly delayMs: number;
  private readonly chunkSize: number;

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? 'mock';
    this.defaultModel = options.model ?? 'nami-mock-1';
    this.delayMs = options.delayMs ?? 8;
    this.chunkSize = Math.max(1, options.chunkSize ?? 6);
  }

  get model(): string {
    return this.defaultModel;
  }

  setDefaultModel(model: string): void {
    if (model.trim() !== '') this.defaultModel = model.trim();
  }

  async listModelInfo(): Promise<ModelInfo[]> {
    return [
      { id: this.defaultModel, ownedBy: this.id },
      { id: 'nami-mock-echo', ownedBy: this.id },
    ];
  }

  private async *emitText(text: string): AsyncGenerator<StreamChunk, void, undefined> {
    for (let offset = 0; offset < text.length; offset += this.chunkSize) {
      await sleep(this.delayMs);
      yield { type: 'text', text: text.slice(offset, offset + this.chunkSize) };
    }
  }

  /** Chooses a tool call for the user's last message, if one applies. */
  private detectIntent(request: ChatRequest, lastUser: string): Intent | null {
    const available = new Set((request.tools ?? []).map((tool) => tool.name));
    const text = lastUser.trim();
    if (text.length === 0 || available.size === 0) return null;

    if (available.has('now') && /(几点|现在时间|当前时间|\btime\b|\bclock\b|今天日期)/i.test(text)) {
      return { tool: 'now', args: {} };
    }

    const echo = text.match(/(?:^|\s)(?:echo|重复|复述)\s*[:：]?\s*([\s\S]+)$/i);
    if (available.has('echo') && echo?.[1]) {
      return { tool: 'echo', args: { text: echo[1].trim() } };
    }

    if (available.has('calc') && /(计算|算一下|算算|\bcalc\b|\beval\b)/i.test(text)) {
      const expression = extractExpression(text);
      if (expression) return { tool: 'calc', args: { expression } };
    }

    const remember = text.match(/(?:记住|remember)\s*[:：]?\s*([^\s=]+)\s*(?:=|是|为|:)?\s*([\s\S]*)$/i);
    if (available.has('memory_write') && remember?.[1]) {
      return {
        tool: 'memory_write',
        args: { key: remember[1], value: (remember[2] ?? '').trim() },
      };
    }

    const recall = text.match(/(?:回忆|recall|还记得)\s*[:：]?\s*([^\s?？]+)/i);
    if (available.has('memory_read') && recall?.[1]) {
      return { tool: 'memory_read', args: { key: recall[1] } };
    }

    return null;
  }

  /** Summarises the tool results that follow the most recent assistant turn. */
  private summariseToolResults(messages: ChatMessage[]): string {
    const results: ChatMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message) continue;
      if (message.role === 'tool') {
        results.unshift(message);
        continue;
      }
      if (message.role === 'assistant') break;
    }

    if (results.length === 0) return '我没有收到可用的工具结果。';

    const lines = results.map((message) => {
      const content = textOf(message).trim() || '(空结果)';
      const label = message.name ? `\`${message.name}\`` : '工具';
      return `- ${label} 返回：${content}`;
    });

    return [
      `工具调用已完成，共 ${results.length} 项：`,
      ...lines,
      '',
      '需要我基于这些结果继续处理吗？',
    ].join('\n');
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const messages = request.messages;
    const last = messages[messages.length - 1];
    const promptText = messages.map(textOf).join('\n');
    const promptTokens = estimateTokens(promptText);
    const effectiveModel = request.model?.trim() || this.defaultModel;

    let output: string;
    let toolCalls: ToolCall[] = [];

    if (last && last.role === 'tool') {
      output = this.summariseToolResults(messages);
    } else {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const userText = textOf(lastUser);
      const intent = this.detectIntent(request, userText);

      if (intent) {
        // The visible text precedes the tool call, mirroring real model output.
        output = `好的，我来调用 \`${intent.tool}\` 工具处理这个请求。`;
        toolCalls = [
          {
            id: `call_${Math.random().toString(36).slice(2, 12)}`,
            type: 'function',
            function: { name: intent.tool, arguments: JSON.stringify(intent.args) },
          },
        ];
      } else {
        const toolNames = (request.tools ?? []).map((tool) => tool.name);
        output = [
          `我是 Nami 的离线 Mock 模型（provider=mock, model=${effectiveModel}），正在为你验证服务器链路。`,
          '',
          `收到你的消息：「${userText.slice(0, 200) || '(空)'}」`,
          '',
          toolNames.length > 0
            ? `当前挂载的工具：${toolNames.map((name) => `\`${name}\``).join('、')}。` +
              '试试「现在几点」「计算 12*(3+4)」「echo 你好」或「记住 key=value」，我就会真正发起一次工具调用。'
            : '当前没有挂载任何工具。',
          '',
          '把 NAMI_LLM_PROVIDER 切换为 ollama 或 openai，即可接入真实模型。',
        ].join('\n');
      }
    }

    yield* this.emitText(output);

    // The finish chunk is skipped when the consumer stops early.
    for (let index = 0; index < toolCalls.length; index += 1) {
      const call = toolCalls[index];
      if (!call) continue;
      yield {
        type: 'tool_call',
        index,
        id: call.id,
        name: call.function.name,
        argsDelta: call.function.arguments,
      };
    }

    const usage: Usage = {
      prompt_tokens: promptTokens,
      completion_tokens: estimateTokens(output),
      total_tokens: promptTokens + estimateTokens(output),
    };

    yield {
      type: 'finish',
      reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      usage,
    };
  }
}
