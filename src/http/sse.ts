/**
 * Server-Sent Events writer with keep-alive comments.
 *
 * Used by `/v1/agent/run?stream=true` and by the OpenAI-compatible streaming
 * endpoint, so both transports share one implementation.
 */

import type { ServerResponse } from 'node:http';

export interface SseOptions {
  /** Comment interval; `0` disables heartbeats. */
  heartbeatMs?: number;
  extraHeaders?: Record<string, string>;
}

export class SseStream {
  private readonly res: ServerResponse;
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(res: ServerResponse, options: SseOptions = {}) {
    this.res = res;

    if (!res.headersSent) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Disable proxy buffering (nginx) so deltas arrive immediately.
        'x-accel-buffering': 'no',
        ...options.extraHeaders,
      });
    }
    res.flushHeaders?.();

    const interval = options.heartbeatMs ?? 15_000;
    if (interval > 0) {
      this.heartbeat = setInterval(() => this.comment('keep-alive'), interval);
      this.heartbeat.unref?.();
    }
  }

  get isClosed(): boolean {
    return this.closed || this.res.writableEnded || this.res.destroyed;
  }

  /** Emits one named event. Returns false once the socket is gone. */
  send(event: string, data: unknown, id?: string): boolean {
    if (this.isClosed) return false;
    try {
      let frame = '';
      if (id !== undefined) frame += `id: ${id}\n`;
      frame += `event: ${event}\n`;
      // JSON.stringify keeps the payload on a single line: raw newlines would
      // otherwise terminate the SSE field early.
      frame += `data: ${JSON.stringify(data ?? null)}\n\n`;
      this.res.write(frame);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  /**
   * Emits a data-only frame with no `event:` field.
   *
   * OpenAI's streaming format is bare `data:` lines, so the compatible endpoint
   * must not inject named events that strict clients would misparse.
   */
  data(payload: unknown): boolean {
    if (this.isClosed) return false;
    try {
      this.res.write(`data: ${JSON.stringify(payload ?? null)}\n\n`);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  /** Emits a literal, unencoded data line (used for the `[DONE]` sentinel). */
  rawData(text: string): boolean {
    if (this.isClosed) return false;
    try {
      this.res.write(`data: ${text}\n\n`);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  comment(text: string): void {
    if (this.isClosed) return;
    try {
      this.res.write(`: ${text}\n\n`);
    } catch {
      this.closed = true;
    }
  }

  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.closed = true;
    if (!this.res.writableEnded && !this.res.destroyed) {
      try {
        this.res.end();
      } catch {
        /* socket already gone */
      }
    }
  }
}
