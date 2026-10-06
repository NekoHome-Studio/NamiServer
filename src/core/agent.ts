/**
 * The agent loop.
 *
 * Consumes a provider stream, forwards text deltas as they arrive, executes any
 * tool calls through the sandbox, feeds the results back, and repeats until the
 * model answers without requesting a tool or the round budget is spent.
 *
 * Everything observable is emitted as an `AgentEvent`, which the HTTP SSE route
 * and the WebSocket gateway both simply relay. Persistence happens here so both
 * transports share identical history semantics.
 */

import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { LLMProvider } from '../llm/types.ts';
import { ToolCallAccumulator } from '../llm/collect.ts';
import { agentEvent } from './types.ts';
import type { AgentEvent, ChatMessage, MessageRecord, RunStatus, ToolCall, ToolResult, Usage } from './types.ts';
import { EMPTY_USAGE } from './types.ts';
import { executeTool } from '../tools/sandbox.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolContext } from '../tools/types.ts';
import type { SessionStore } from '../store/store.ts';

export interface AgentDeps {
  store: SessionStore;
  registry: ToolRegistry;
  provider: LLMProvider;
  config: Config;
  log: Logger;
}

export interface AgentRunInput {
  /** Existing session id, or undefined to start a new session. */
  sessionId?: string;
  input: string;
  system?: string;
  /** Concrete upstream model, already resolved by the ModelRouter. */
  model?: string;
  maxRounds?: number;
  temperature?: number;
  maxTokens?: number;
  /**
   * Explicit conversation context, used by the OpenAI-compatible endpoint where
   * clients resend the whole history on every request. When present it replaces
   * the stored history for this turn (the turn is still persisted).
   */
  history?: ChatMessage[];
}

export function deriveTitle(input: string, max = 60): string {
  const firstLine = input.trim().split(/\r?\n/, 1)[0] ?? '';
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return 'New session';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Drops leading `tool` messages so a truncated history never begins with an
 * orphaned tool result, which strict OpenAI-compatible servers reject.
 */
export function trimHistory(records: MessageRecord[], max: number): MessageRecord[] {
  const window = records.slice(Math.max(0, records.length - max));
  let start = 0;
  while (start < window.length && window[start]?.role === 'tool') start += 1;
  return window.slice(start);
}

export function buildContext(
  records: MessageRecord[],
  store: SessionStore,
  systemPrompt: string,
  maxHistory: number,
): ChatMessage[] {
  const system: ChatMessage = { role: 'system', content: systemPrompt };
  const history = store.toChatMessages(trimHistory(records, maxHistory));
  // A caller-supplied system message wins over the configured default.
  if (history.length > 0 && history[0]?.role === 'system') history.shift();
  return [system, ...history];
}

/**
 * Context built from client-supplied messages. A leading system message is
 * promoted to the system prompt slot; everything else is preserved verbatim.
 */
export function buildContextFromMessages(
  provided: ChatMessage[],
  systemPrompt: string,
): ChatMessage[] {
  const history = [...provided];
  let system = systemPrompt;
  if (history[0]?.role === 'system') {
    const explicit = history.shift();
    if (explicit?.content) system = explicit.content;
  }
  return [{ role: 'system', content: system }, ...history];
}

type ArgsParse = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

export function parseToolArguments(raw: string): ArgsParse {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'arguments must be a JSON object' };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      error: `arguments are not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export interface AgentRunnerOptions {
  deps: AgentDeps;
  signal: AbortSignal;
}

/**
 * Runs one agent turn, streaming events.
 *
 * The generator owns persistence: it appends the user message, every assistant
 * message, and every tool result, and always finalises the run record — even
 * when the consumer disconnects mid-stream.
 */
export async function* runAgent(
  runner: AgentRunnerOptions,
  input: AgentRunInput,
): AsyncGenerator<AgentEvent, void, undefined> {
  const { store, registry, provider, config, log } = runner.deps;
  const { signal } = runner;

  const session = store.ensureSession(input.sessionId, deriveTitle(input.input));
  // The requested model is already resolved; fall back to the provider default.
  const effectiveModel = input.model?.trim() || provider.model;
  const run = store.createRun({
    sessionId: session.id,
    provider: provider.id,
    model: effectiveModel,
  });
  const runLog = log.child({ runId: run.id, sessionId: session.id });

  const maxRounds = Math.max(1, input.maxRounds ?? config.agent.maxRounds);
  const temperature = input.temperature ?? config.agent.temperature;
  const maxTokens = input.maxTokens ?? config.agent.maxTokens;
  const systemPrompt = input.system?.trim() || config.agent.systemPrompt;
  const toolDefinitions = registry.definitions();

  let rounds = 0;
  let toolCallCount = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let output = '';
  let status: RunStatus = 'succeeded';
  let errorMessage: string | undefined;
  let completed = false;

  const startedAt = Date.now();

  try {
    yield agentEvent('run.start', {
      runId: run.id,
      sessionId: session.id,
      provider: provider.id,
      model: effectiveModel,
    });

    store.appendMessage(session.id, { role: 'user', content: input.input });

    // The OpenAI-compatible endpoint supplies its own context; everything else
    // replays the persisted session.
    const messages =
      input.history && input.history.length > 0
        ? buildContextFromMessages(input.history, systemPrompt)
        : buildContext(
            store.getMessages(session.id),
            store,
            systemPrompt,
            config.agent.maxHistoryMessages,
          );

    for (let round = 0; round < maxRounds; round += 1) {
      if (signal.aborted) {
        status = 'cancelled';
        errorMessage = 'cancelled by client';
        break;
      }

      rounds += 1;
      const accumulator = new ToolCallAccumulator();
      let text = '';
      let usage: Usage = EMPTY_USAGE;

      const stream = provider.stream({
        messages,
        tools: toolDefinitions,
        temperature,
        maxTokens,
        signal,
        model: effectiveModel,
      });

      for await (const chunk of stream) {
        if (chunk.type === 'text') {
          text += chunk.text;
          yield agentEvent('delta', { text: chunk.text });
        } else if (chunk.type === 'tool_call') {
          accumulator.push(chunk.index, chunk.id, chunk.name, chunk.argsDelta);
        } else {
          usage = chunk.usage;
        }
      }

      promptTokens += usage.prompt_tokens;
      completionTokens += usage.completion_tokens;

      const toolCalls: ToolCall[] = accumulator.finish();

      store.appendMessage(session.id, {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });

      const assistantMessage: ChatMessage = { role: 'assistant', content: text.length > 0 ? text : null };
      if (toolCalls.length > 0) assistantMessage.tool_calls = toolCalls;
      messages.push(assistantMessage);

      if (toolCalls.length === 0) {
        output = text;
        completed = true;
        break;
      }

      for (const call of toolCalls) {
        const toolName = call.function.name;
        const parsed = parseToolArguments(call.function.arguments);
        const args = parsed.ok ? parsed.args : {};
        const tool = registry.get(toolName);

        yield agentEvent('tool.call', {
          id: call.id,
          name: toolName,
          args,
          danger: tool?.danger ?? 'safe',
        });

        let result: ToolResult;
        if (!parsed.ok) {
          result = {
            ok: false,
            content: `Tool "${toolName}" was not executed: ${parsed.error}. Re-issue the call with valid JSON arguments.`,
            error: parsed.error,
            durationMs: 0,
          };
        } else if (!tool) {
          const available = registry
            .enabled()
            .map((entry) => entry.name)
            .join(', ');
          result = {
            ok: false,
            content: `Tool "${toolName}" does not exist. Available tools: ${available}.`,
            error: 'unknown tool',
            durationMs: 0,
          };
        } else {
          const context: ToolContext = {
            sessionId: session.id,
            runId: run.id,
            signal,
            log: runLog.child({ tool: toolName }),
            store,
            config,
          };
          result = await executeTool(tool, args, context, {
            timeoutMs: config.agent.toolTimeoutMs,
            maxResultBytes: config.agent.maxToolResultBytes,
          });
        }

        toolCallCount += 1;

        store.createToolInvocation({
          runId: run.id,
          name: toolName,
          args,
          ok: result.ok,
          content: result.content,
          ...(result.error !== undefined ? { error: result.error } : {}),
          durationMs: result.durationMs,
        });

        store.appendMessage(session.id, {
          role: 'tool',
          content: result.content,
          toolCallId: call.id,
          name: toolName,
        });

        messages.push({
          role: 'tool',
          content: result.content,
          tool_call_id: call.id,
          name: toolName,
        });

        yield agentEvent('tool.result', {
          id: call.id,
          name: toolName,
          ok: result.ok,
          content: result.content,
          ...(result.error !== undefined ? { error: result.error } : {}),
          durationMs: result.durationMs,
        });
      }
    }

    if (!completed && status === 'succeeded') {
      // Round budget exhausted: surface it instead of silently stopping.
      const note = `\n\n[reached the ${maxRounds}-round tool budget without a final answer]`;
      output = `${output}${note}`.trim();
      yield agentEvent('delta', { text: note });
      runLog.warn('round budget exhausted', { maxRounds, toolCalls: toolCallCount });
    }

    const endedAt = Date.now();
    yield agentEvent('run.end', {
      runId: run.id,
      sessionId: session.id,
      output,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      rounds,
      toolCalls: toolCallCount,
      durationMs: endedAt - startedAt,
    });

    runLog.info('run finished', {
      rounds,
      toolCalls: toolCallCount,
      ms: endedAt - startedAt,
      outputChars: output.length,
    });
  } catch (error) {
    const aborted = signal.aborted;
    status = aborted ? 'cancelled' : 'failed';
    errorMessage = error instanceof Error ? error.message : String(error);
    runLog.error('run failed', { status, error: errorMessage });
    yield agentEvent('error', {
      message: errorMessage,
      code: aborted ? 'cancelled' : 'run_failed',
    });
  } finally {
    // Ran even when the consumer abandons the stream, so no run is left 'running'.
    if (!completed && status === 'succeeded') status = 'cancelled';
    store.finishRun(run.id, {
      status,
      rounds,
      toolCalls: toolCallCount,
      promptTokens,
      completionTokens,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    });
  }
}
