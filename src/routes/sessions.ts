/**
 * Session CRUD and transcript retrieval.
 */

import type { AppDeps } from '../app.ts';
import type { Router } from '../http/router.ts';
import { asObject } from '../http/body.ts';
import { LIMITS, clampInt } from '../http/query.ts';
import { HttpError, sendJson } from '../http/response.ts';

export function registerSessionRoutes(router: Router, deps: AppDeps): void {
  const { store } = deps;

  router.get('/v1/sessions', (ctx) => {
    const { fallback, min, max } = LIMITS.sessionList;
    const limit = clampInt(ctx.url.searchParams.get('limit'), fallback, min, max);
    const offset = clampInt(ctx.url.searchParams.get('offset'), 0, 0, 1_000_000);
    const data = store.listSessions(limit, offset).map((session) => ({
      ...session,
      messageCount: store.countMessages(session.id),
    }));
    sendJson(ctx.res, 200, { object: 'list', limit, offset, data });
  });

  router.post('/v1/sessions', (ctx) => {
    const body = asObject(ctx.body);
    const title = typeof body.title === 'string' ? body.title : 'New session';
    const metadata =
      body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : {};
    const session = store.createSession(title, metadata);
    sendJson(ctx.res, 201, { object: 'session', session });
  });

  router.get('/v1/sessions/:id', (ctx) => {
    const id = ctx.params.id as string;
    const session = store.getSession(id);
    if (!session) throw new HttpError(404, `Session "${id}" was not found.`, 'session_not_found');
    const { fallback, min, max } = LIMITS.sessionMessages;
    const limit = clampInt(ctx.url.searchParams.get('limit'), fallback, min, max);
    sendJson(ctx.res, 200, {
      object: 'session',
      session: { ...session, messageCount: store.countMessages(id) },
      messages: store.getMessages(id, limit),
      memory: store.kvList(id),
    });
  });

  router.get('/v1/sessions/:id/messages', (ctx) => {
    const id = ctx.params.id as string;
    if (!store.getSession(id)) {
      throw new HttpError(404, `Session "${id}" was not found.`, 'session_not_found');
    }
    const { fallback, min, max } = LIMITS.sessionMessages;
    const limit = clampInt(ctx.url.searchParams.get('limit'), fallback, min, max);
    sendJson(ctx.res, 200, { object: 'list', sessionId: id, data: store.getMessages(id, limit) });
  });

  router.delete('/v1/sessions/:id', (ctx) => {
    const id = ctx.params.id as string;
    const deleted = store.deleteSession(id);
    if (!deleted) throw new HttpError(404, `Session "${id}" was not found.`, 'session_not_found');
    sendJson(ctx.res, 200, { object: 'session.deleted', id, deleted: true });
  });

  router.get('/v1/runs', (ctx) => {
    const { fallback, min, max } = LIMITS.runs;
    const limit = clampInt(ctx.url.searchParams.get('limit'), fallback, min, max);
    sendJson(ctx.res, 200, { object: 'list', data: store.listRuns(limit) });
  });

  router.get('/v1/runs/:id', (ctx) => {
    const id = ctx.params.id as string;
    const run = store.getRun(id);
    if (!run) throw new HttpError(404, `Run "${id}" was not found.`, 'run_not_found');
    sendJson(ctx.res, 200, {
      object: 'run',
      run,
      toolInvocations: store.listToolInvocations(id),
    });
  });
}
