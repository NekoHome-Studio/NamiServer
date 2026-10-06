/**
 * Native agent endpoint.
 *
 * `POST /v1/agent/run` is the richest interface Nami exposes: it streams the
 * full `AgentEvent` vocabulary (run lifecycle, text deltas, tool calls and tool
 * results) over SSE, or returns the complete turn as JSON when `stream` is off.
 */

import type { AppDeps } from '../app.ts';
import { runAgent } from '../core/agent.ts';
import type { Router } from '../http/router.ts';
import { asObject } from '../http/body.ts';
import { HttpError, sendJson } from '../http/response.ts';
import { SseStream } from '../http/sse.ts';

export function registerAgentRoutes(router: Router, deps: AppDeps): void {
  const { store, registry, provider, models, config, log, metrics } = deps;

  router.post('/v1/agent/run', async (ctx) => {
    const body = asObject(ctx.body);
    const input = typeof body.input === 'string' ? body.input : typeof body.message === 'string' ? body.message : '';
    if (input.trim() === '') {
      throw new HttpError(400, 'Field "input" must be a non-empty string.', 'missing_input');
    }

    const resolution = models.resolve(typeof body.model === 'string' ? body.model : undefined);
    if (!resolution.ok) {
      throw new HttpError(
        resolution.code === 'model_not_allowed' ? 403 : 404,
        resolution.message,
        resolution.code,
      );
    }

    const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;
    const wantsStream = body.stream !== false;
    const maxRounds = typeof body.maxRounds === 'number' ? Math.min(20, Math.max(1, Math.trunc(body.maxRounds))) : undefined;

    const controller = new AbortController();
    ctx.req.on('close', () => controller.abort(new Error('client disconnected')));

    const runInput = {
      input,
      model: resolution.model,
      ...(sessionId ? { sessionId } : {}),
      ...(typeof body.system === 'string' ? { system: body.system } : {}),
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(typeof body.maxTokens === 'number' ? { maxTokens: Math.max(1, Math.trunc(body.maxTokens)) } : {}),
    };

    const events = runAgent(
      { deps: { store, registry, provider, config, log }, signal: controller.signal },
      runInput,
    );

    metrics.recordRunStart();

    if (!wantsStream) {
      // Drain the run and return the final turn as a single JSON document.
      let result: Record<string, unknown> = {};
      let output = '';
      // Named distinctly from the `run.end` event's `toolCalls` counter, which
      // the spread below would otherwise overwrite.
      const toolCallDetails: unknown[] = [];

      for await (const event of events) {
        if (event.type === 'run.start') result.runId = event.data.runId;
        if (event.type === 'run.start') result.sessionId = event.data.sessionId;
        if (event.type === 'delta') output += event.data.text;
        if (event.type === 'tool.call') toolCallDetails.push(event.data);
        if (event.type === 'tool.result') metrics.recordToolCall();
        if (event.type === 'run.end') {
          result = { ...result, ...event.data };
          output = event.data.output;
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
        object: 'agent.run',
        output,
        toolCallDetails,
        ...result,
      });
      return;
    }

    const sse = new SseStream(ctx.res, { heartbeatMs: 15_000 });
    ctx.req.on('close', () => sse.close());

    try {
      for await (const event of events) {
        if (event.type === 'delta') metrics.recordDelta(event.data.text.length);
        if (event.type === 'tool.result') metrics.recordToolCall();
        if (event.type === 'run.end') metrics.recordRunEnd('succeeded');
        if (event.type === 'error') {
          metrics.recordRunEnd(controller.signal.aborted ? 'cancelled' : 'failed');
        }
        if (!sse.send(event.type, event.data)) {
          controller.abort(new Error('client disconnected'));
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sse.send('error', { message, code: 'stream_failed' });
      log.error('agent stream failed', { error: message, requestId: ctx.requestId });
    } finally {
      sse.close();
    }
  });
}
