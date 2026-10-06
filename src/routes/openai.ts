/**
 * OpenAI-compatible surface.
 *
 * Two modes, chosen by whether the caller supplies their own `tools`:
 *
 *  - **Proxy mode** (client sent `tools`): the request is forwarded and any
 *    tool calls are returned to the caller to execute, exactly like OpenAI.
 *    Nami cannot execute tools it does not host, so it does not try.
 *  - **Agent mode** (no client tools): the full server-side agent loop runs,
 *    with Nami's registered tools, and the caller simply sees the streamed
 *    answer. Tool activity is visible on `/v1/agent/run` and `/ws`.
 */

import { randomBytes } from 'node:crypto';
import type { AppDeps } from '../app.ts';
import { runAgent } from '../core/agent.ts';
import type { ChatMessage, JsonSchema, Role, ToolCall, ToolDefinition, Usage } from '../core/types.ts';
import { EMPTY_USAGE } from '../core/types.ts';
import { collectTurn } from '../llm/collect.ts';
import type { Router } from '../http/router.ts';
import { asObject } from '../http/body.ts';
import { HttpError, sendJson } from '../http/response.ts';
import { SseStream } from '../http/sse.ts';

const ROLES: Role[] = ['system', 'user', 'assistant', 'tool'];

function randomId(prefix: string): string {
  return `${prefix}${randomBytes(12).toString('hex')}`;
}

function normalizeContent(raw: unknown, index: number): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;

  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const part of raw) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      if (part && typeof part === 'object') {
        const record = part as Record<string, unknown>;
        if (typeof record.text === 'string') parts.push(record.text);
      }
    }
    return parts.join('');
  }

  throw new HttpError(
    400,
    `messages[${index}].content must be a string, an array of content parts, or null.`,
    'invalid_messages',
  );
}

function normalizeToolCall(raw: unknown, path: string): ToolCall {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, `${path} must be an object.`, 'invalid_messages');
  }
  const record = raw as Record<string, unknown>;
  const fn = record.function;
  if (!fn || typeof fn !== 'object') {
    throw new HttpError(400, `${path}.function must be an object.`, 'invalid_messages');
  }
  const fnRecord = fn as Record<string, unknown>;
  const name = typeof fnRecord.name === 'string' ? fnRecord.name : '';
  if (name === '') throw new HttpError(400, `${path}.function.name is required.`, 'invalid_messages');

  const args =
    typeof fnRecord.arguments === 'string'
      ? fnRecord.arguments
      : JSON.stringify(fnRecord.arguments ?? {});

  return {
    id: typeof record.id === 'string' && record.id !== '' ? record.id : randomId('call_'),
    type: 'function',
    function: { name, arguments: args },
  };
}

export function toChatMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'Field "messages" must be an array.', 'invalid_messages');
  }
  if (raw.length === 0) {
    throw new HttpError(400, 'Field "messages" must not be empty.', 'invalid_messages');
  }

  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(400, `messages[${index}] must be an object.`, 'invalid_messages');
    }
    const record = entry as Record<string, unknown>;
    const role = String(record.role ?? '');
    if (!ROLES.includes(role as Role)) {
      throw new HttpError(
        400,
        `messages[${index}].role must be one of ${ROLES.join(', ')}.`,
        'invalid_messages',
      );
    }

    const message: ChatMessage = {
      role: role as Role,
      content: normalizeContent(record.content, index),
    };

    if (typeof record.name === 'string') message.name = record.name;
    if (typeof record.tool_call_id === 'string') message.tool_call_id = record.tool_call_id;

    if (role === 'assistant' && Array.isArray(record.tool_calls) && record.tool_calls.length > 0) {
      message.tool_calls = record.tool_calls.map((call, callIndex) =>
        normalizeToolCall(call, `messages[${index}].tool_calls[${callIndex}]`),
      );
    }

    return message;
  });
}

/** Converts client-supplied wire tools into internal tool definitions. */
export function toToolDefinitions(raw: unknown): ToolDefinition[] {
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'Field "tools" must be an array.', 'invalid_tools');
  }
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new HttpError(400, `tools[${index}] must be an object.`, 'invalid_tools');
    }
    const record = entry as Record<string, unknown>;
    const fn = record.function;
    const fnRecord = fn && typeof fn === 'object' ? (fn as Record<string, unknown>) : record;
    const name = typeof fnRecord.name === 'string' ? fnRecord.name : '';
    if (name === '') {
      throw new HttpError(400, `tools[${index}] is missing function.name.`, 'invalid_tools');
    }
    return {
      name,
      description: typeof fnRecord.description === 'string' ? fnRecord.description : '',
      parameters: (fnRecord.parameters as JsonSchema | undefined) ?? { type: 'object', properties: {} },
      danger: 'safe',
      enabled: true,
    };
  });
}

interface ChunkChoice {
  index: number;
  delta: Record<string, unknown>;
  finish_reason: string | null;
}

function chunkPayload(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  const choice: ChunkChoice = { index: 0, delta, finish_reason: finishReason };
  return { id, object: 'chat.completion.chunk', created, model, choices: [choice] };
}

export function registerOpenAiRoutes(router: Router, deps: AppDeps): void {
  const { store, registry, provider, models, config, log, metrics } = deps;

  router.get('/v1/models', async (ctx) => {
    await models.refresh();
    const catalogue = models.listForApi();
    sendJson(ctx.res, 200, {
      object: 'list',
      data: catalogue.map((model) => ({
        id: model.id,
        object: 'model',
        created: model.created ?? Math.floor(deps.startedAt / 1000),
        owned_by: model.ownedBy,
        // Non-standard, additive: reveals aliasing and size/quantization so a
        // client can tell an alias from the real upstream model.
        ...(model.meta ? { nami: model.meta } : {}),
      })),
    });
  });

  router.post('/v1/chat/completions', async (ctx) => {
    const body = asObject(ctx.body);
    const messages = toChatMessages(body.messages);

    // Resolve the requested model before doing any work, so an unknown or
    // unexposed name fails fast with an OpenAI-shaped 404/403.
    const resolution = models.resolve(typeof body.model === 'string' ? body.model : undefined);
    if (!resolution.ok) {
      throw new HttpError(
        resolution.code === 'model_not_allowed' ? 403 : 404,
        resolution.message,
        resolution.code,
      );
    }
    // Echo what the client asked for, so an alias is invisible to it.
    const requestedModel = resolution.requested ?? resolution.model;
    const effectiveModel = resolution.model;

    const wantsStream = body.stream === true;
    const temperature = typeof body.temperature === 'number' ? body.temperature : undefined;

    const rawMaxTokens =
      typeof body.max_tokens === 'number'
        ? body.max_tokens
        : typeof body.max_completion_tokens === 'number'
          ? body.max_completion_tokens
          : undefined;
    const maxTokens = rawMaxTokens !== undefined ? Math.max(1, Math.trunc(rawMaxTokens)) : undefined;

    const includeUsage =
      !!body.stream_options &&
      typeof body.stream_options === 'object' &&
      (body.stream_options as Record<string, unknown>).include_usage === true;

    const clientTools =
      Array.isArray(body.tools) && body.tools.length > 0 ? toToolDefinitions(body.tools) : [];

    const headerSession = ctx.req.headers['x-nami-session'];
    const sessionId =
      typeof body.session_id === 'string' && body.session_id !== ''
        ? body.session_id
        : typeof headerSession === 'string' && headerSession !== ''
          ? headerSession
          : undefined;

    const controller = new AbortController();
    ctx.req.on('close', () => controller.abort(new Error('client disconnected')));

    const id = randomId('chatcmpl-');
    const created = Math.floor(Date.now() / 1000);

    /* ----------------------- proxy mode (client tools) ---------------------- */

    if (clientTools.length > 0) {
      if (wantsStream) {
        const sse = new SseStream(ctx.res, { heartbeatMs: 0 });
        ctx.req.on('close', () => sse.close());
        let finishReason: string | null = null;
        let usage: Usage = EMPTY_USAGE;

        try {
          sse.data(chunkPayload(id, created, requestedModel, { role: 'assistant', content: '' }));

          for await (const chunk of provider.stream({
            messages,
            tools: clientTools,
            model: effectiveModel,
            ...(temperature !== undefined ? { temperature } : {}),
            ...(maxTokens !== undefined ? { maxTokens } : {}),
            signal: controller.signal,
          })) {
            if (chunk.type === 'text') {
              sse.data(chunkPayload(id, created, requestedModel, { content: chunk.text }));
            } else if (chunk.type === 'tool_call') {
              const toolDelta: Record<string, unknown> = { index: chunk.index };
              if (chunk.id) toolDelta.id = chunk.id;
              toolDelta.type = 'function';
              const fn: Record<string, unknown> = {};
              if (chunk.name) fn.name = chunk.name;
              if (chunk.argsDelta) fn.arguments = chunk.argsDelta;
              toolDelta.function = fn;
              sse.data(chunkPayload(id, created, requestedModel, { tool_calls: [toolDelta] }));
            } else {
              finishReason = chunk.reason;
              usage = chunk.usage;
            }
          }

          sse.data(chunkPayload(id, created, requestedModel, {}, finishReason ?? 'stop'));
          if (includeUsage) {
            sse.data({
              id,
              object: 'chat.completion.chunk',
              created,
              model: requestedModel,
              choices: [],
              usage,
            });
          }
          sse.rawData('[DONE]');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.warn('openai proxy stream failed', { error: message, requestId: ctx.requestId });
          sse.rawData(JSON.stringify({ error: { message, type: 'server_error', code: 'stream_failed' } }));
        } finally {
          sse.close();
        }
        return;
      }

      const turn = await collectTurn(provider, {
        messages,
        tools: clientTools,
        model: effectiveModel,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        signal: controller.signal,
      });

      const message: Record<string, unknown> = { role: 'assistant', content: turn.content };
      if (turn.toolCalls.length > 0) message.tool_calls = turn.toolCalls;

      sendJson(ctx.res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: requestedModel,
        choices: [
          {
            index: 0,
            message,
            finish_reason: turn.toolCalls.length > 0 ? 'tool_calls' : 'stop',
            logprobs: null,
          },
        ],
        usage: turn.usage,
      });
      return;
    }

    /* --------------------------- agent mode --------------------------- */

    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const input = lastUser?.content ?? '';

    const events = runAgent(
      { deps: { store, registry, provider, config, log }, signal: controller.signal },
      {
        input,
        history: messages,
        model: effectiveModel,
        ...(sessionId ? { sessionId } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      },
    );

    metrics.recordRunStart();

    if (!wantsStream) {
      let output = '';
      let usage: Usage = EMPTY_USAGE;
      let finishReason: string | null = null;

      for await (const event of events) {
        if (event.type === 'delta') output += event.data.text;
        if (event.type === 'tool.result') metrics.recordToolCall();
        if (event.type === 'run.end') {
          output = event.data.output;
          usage = event.data.usage;
          finishReason = 'stop';
          metrics.recordRunEnd('succeeded');
        }
        if (event.type === 'error') {
          metrics.recordRunEnd(controller.signal.aborted ? 'cancelled' : 'failed');
          throw new HttpError(
            controller.signal.aborted ? 499 : 502,
            event.data.message,
            event.data.code ?? 'run_failed',
          );
        }
      }

      sendJson(ctx.res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: requestedModel,
        choices: [
          { index: 0, message: { role: 'assistant', content: output }, finish_reason: finishReason ?? 'stop', logprobs: null },
        ],
        usage,
      });
      return;
    }

    const sse = new SseStream(ctx.res, { heartbeatMs: 0 });
    ctx.req.on('close', () => sse.close());
    let usage: Usage = EMPTY_USAGE;

    try {
      sse.data(chunkPayload(id, created, requestedModel, { role: 'assistant', content: '' }));

      for await (const event of events) {
        if (event.type === 'delta') {
          metrics.recordDelta(event.data.text.length);
          sse.data(chunkPayload(id, created, requestedModel, { content: event.data.text }));
        } else if (event.type === 'tool.result') {
          metrics.recordToolCall();
        } else if (event.type === 'run.end') {
          usage = event.data.usage;
          metrics.recordRunEnd('succeeded');
        } else if (event.type === 'error') {
          metrics.recordRunEnd(controller.signal.aborted ? 'cancelled' : 'failed');
        }
      }

      sse.data(chunkPayload(id, created, requestedModel, {}, 'stop'));
      if (includeUsage) {
        sse.data({
          id,
          object: 'chat.completion.chunk',
          created,
          model: requestedModel,
          choices: [],
          usage,
        });
      }
      sse.rawData('[DONE]');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('openai agent stream failed', { error: message, requestId: ctx.requestId });
      sse.rawData(JSON.stringify({ error: { message, type: 'server_error', code: 'stream_failed' } }));
    } finally {
      sse.close();
    }
  });
}
