/**
 * Log endpoints backing the WebUI's live log page.
 *
 *   GET    /admin/api/logs          recent entries (bounded, filterable)
 *   GET    /admin/api/logs/stream   live tail over SSE
 *   DELETE /admin/api/logs          clear the ring buffer
 *
 * Entries are redacted inside the bus, not here, so every consumer of the
 * buffer is safe by construction.
 */

import type { AppDeps } from '../app.ts';
import { isLogLevel, logLevelRank } from '../logbus.ts';
import type { LogEntry } from '../logbus.ts';
import type { LogLevel } from '../logger.ts';
import type { Router } from '../http/router.ts';
import { HttpError, sendJson } from '../http/response.ts';
import { SseStream } from '../http/sse.ts';

const LEVEL_ABOVE: Record<string, string> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

function parseLevel(raw: string | null): LogLevel | undefined {
  if (raw === null || raw === '') return undefined;
  const value = raw.toLowerCase();
  if (!isLogLevel(value) || value === 'silent') {
    throw new HttpError(
      400,
      `Unknown level "${raw}". Use one of: debug, info, warn, error.`,
      'invalid_level',
    );
  }
  return value;
}

function passes(entry: LogEntry, minLevel: LogLevel | undefined): boolean {
  if (!minLevel) return true;
  return logLevelRank(entry.level) >= logLevelRank(minLevel);
}

export function registerLogRoutes(router: Router, deps: AppDeps): void {
  const { logs } = deps;

  router.get('/admin/api/logs', (ctx) => {
    const minLevel = parseLevel(ctx.url.searchParams.get('level'));
    const limitRaw = Number(ctx.url.searchParams.get('limit') ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.min(1000, Math.max(1, Math.trunc(limitRaw))) : 200;

    sendJson(ctx.res, 200, {
      object: 'list',
      data: logs.recent(limit, minLevel),
      captureLevel: logs.captureThreshold,
      availableLevels: Object.keys(LEVEL_ABOVE),
      buffered: logs.size,
      capacity: logs.capacity,
      dropped: logs.droppedCount,
      lastSeq: logs.lastSeq,
    });
  });

  router.get('/admin/api/logs/stream', (ctx) => {
    const minLevel = parseLevel(ctx.url.searchParams.get('level'));
    // `Last-Event-ID` lets a reconnecting EventSource resume without gaps.
    const headerSeq = Number(ctx.req.headers['last-event-id'] ?? 0);
    const querySeq = Number(ctx.url.searchParams.get('since') ?? 0);
    const resumeFrom = Number.isFinite(headerSeq) && headerSeq > 0
      ? headerSeq
      : Number.isFinite(querySeq) && querySeq > 0
        ? querySeq
        : 0;

    const sse = new SseStream(ctx.res, { heartbeatMs: 15_000 });

    // Backfill: everything missed since `resumeFrom`, or the recent tail for a
    // fresh connection.
    const backfill = resumeFrom > 0 ? logs.since(resumeFrom, 500) : logs.recent(200, minLevel);
    for (const entry of backfill) {
      if (!passes(entry, minLevel)) continue;
      if (!sse.send('log', entry, String(entry.seq))) break;
    }

    let unsubscribe: (() => void) | null = null;
    const detach = (): void => {
      unsubscribe?.();
      unsubscribe = null;
      sse.close();
    };

    unsubscribe = logs.subscribe((entry) => {
      if (sse.isClosed) {
        detach();
        return;
      }
      if (!passes(entry, minLevel)) return;
      if (!sse.send('log', entry, String(entry.seq))) detach();
    });

    ctx.req.on('close', detach);
    ctx.req.on('error', detach);
  });

  router.delete('/admin/api/logs', (ctx) => {
    const cleared = logs.size;
    logs.clear();
    sendJson(ctx.res, 200, { object: 'logs.cleared', cleared });
  });
}
