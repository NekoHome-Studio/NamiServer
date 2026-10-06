/**
 * Incremental tool-call assembly.
 *
 * OpenAI-compatible servers stream tool calls as fragments keyed by `index`:
 * the id and function name usually arrive once in the first fragment while the
 * JSON arguments trickle in across many later fragments. This accumulates them
 * into well-formed `ToolCall` values.
 */

import type { ToolCall } from '../core/types.ts';
import type { AssistantTurn, ChatRequest, LLMProvider, StreamChunk } from './types.ts';
import { EMPTY_USAGE } from '../core/types.ts';

interface PartialCall {
  id?: string;
  name?: string;
  args: string;
}

export class ToolCallAccumulator {
  private readonly partials = new Map<number, PartialCall>();

  push(index: number, id?: string, name?: string, argsDelta?: string): void {
    let slot = this.partials.get(index);
    if (!slot) {
      slot = { args: '' };
      this.partials.set(index, slot);
    }
    if (id) slot.id = id;
    if (name) slot.name = name;
    if (argsDelta) slot.args += argsDelta;
  }

  get size(): number {
    return this.partials.size;
  }

  /** Emits tool calls in ascending index order, dropping nameless fragments. */
  finish(): ToolCall[] {
    const indices = [...this.partials.keys()].sort((a, b) => a - b);
    const calls: ToolCall[] = [];
    for (const index of indices) {
      const slot = this.partials.get(index);
      if (!slot || !slot.name) continue;
      calls.push({
        id: slot.id ?? `call_${index}_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: {
          name: slot.name,
          // Some servers omit arguments entirely for zero-argument tools.
          arguments: slot.args.trim() === '' ? '{}' : slot.args,
        },
      });
    }
    return calls;
  }
}

/** Drains a provider stream into a single assistant turn. */
export async function collectTurn(
  provider: LLMProvider,
  request: ChatRequest,
): Promise<AssistantTurn> {
  const accumulator = new ToolCallAccumulator();
  let text = '';
  let reason: string | null = null;
  let usage = EMPTY_USAGE;

  for await (const chunk of provider.stream(request) as AsyncGenerator<StreamChunk>) {
    if (chunk.type === 'text') {
      text += chunk.text;
    } else if (chunk.type === 'tool_call') {
      accumulator.push(chunk.index, chunk.id, chunk.name, chunk.argsDelta);
    } else {
      reason = chunk.reason;
      usage = chunk.usage;
    }
  }

  return {
    content: text.length > 0 ? text : null,
    toolCalls: accumulator.finish(),
    usage,
    finishReason: reason,
  };
}
