/**
 * Tool execution sandbox.
 *
 * Every invocation passes through here, which enforces four things the agent
 * loop must never have to think about:
 *   1. the tool is enabled;
 *   2. the arguments satisfy the declared JSON Schema;
 *   3. the handler cannot run past its timeout, and is cancelled with the run;
 *   4. the result handed back to the model is size-bounded.
 */

import type { ToolResult } from '../core/types.ts';
import type { Tool, ToolContext } from './types.ts';
import { formatIssues, validateArgs } from './validate.ts';

export interface ExecuteToolOptions {
  timeoutMs: number;
  maxResultBytes: number;
}

function serializeResult(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'null';
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

/** Truncates on a UTF-8 byte budget without splitting the text mid-marker. */
export function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  const kept = buffer.subarray(0, maxBytes).toString('utf8');
  return `${kept}\n...[truncated: ${buffer.length - maxBytes} of ${buffer.length} bytes omitted]`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'Error' ? error.message : `${error.name}: ${error.message}`;
  }
  return String(error);
}

export async function executeTool(
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext,
  options: ExecuteToolOptions,
): Promise<ToolResult> {
  const started = performance.now();
  const elapsed = (): number => Math.round((performance.now() - started) * 100) / 100;

  if (tool.enabled === false) {
    return {
      ok: false,
      content: `Tool "${tool.name}" is disabled on this server.`,
      error: 'tool disabled',
      durationMs: elapsed(),
    };
  }

  const issues = validateArgs(tool.parameters, args);
  if (issues.length > 0) {
    const detail = formatIssues(issues);
    return {
      ok: false,
      content: `Invalid arguments for tool "${tool.name}": ${detail}. Fix the arguments and try again.`,
      error: `invalid arguments: ${detail}`,
      durationMs: elapsed(),
    };
  }

  if (context.signal.aborted) {
    return {
      ok: false,
      content: `Tool "${tool.name}" was cancelled before it started.`,
      error: 'aborted',
      durationMs: elapsed(),
    };
  }

  // A dedicated controller lets the timeout abort the handler without
  // disturbing the parent run's signal.
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(context.signal.reason);
  context.signal.addEventListener('abort', forwardAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`tool "${tool.name}" timed out`));
  }, options.timeoutMs);
  timer.unref?.();

  const childContext: ToolContext = { ...context, signal: controller.signal };

  try {
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason ?? new Error('aborted')),
        { once: true },
      );
    });

    const value = await Promise.race([Promise.resolve(tool.run(args, childContext)), aborted]);

    const content = truncateBytes(serializeResult(value), options.maxResultBytes);
    return { ok: true, content, durationMs: elapsed() };
  } catch (error) {
    const message = timedOut
      ? `Tool "${tool.name}" exceeded the ${options.timeoutMs}ms timeout.`
      : describeError(error);
    return {
      ok: false,
      content: `Tool "${tool.name}" failed: ${message}`,
      error: message,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener('abort', forwardAbort);
  }
}
