/**
 * Admin API backing the web panel.
 *
 * Every route here is guarded by the admin token (or a valid API key when no
 * admin token is configured) — the server applies that check before dispatch.
 * Secrets are never echoed: only counts and booleans describing configuration.
 */

import type { AppDeps } from '../app.ts';
import { lastReloadResult, restartInProgress } from '../lifecycle.ts';
import type { Router } from '../http/router.ts';
import { asObject } from '../http/body.ts';
import { LIMITS, clampInt } from '../http/query.ts';
import { HttpError, sendJson } from '../http/response.ts';

/** Configuration projected for display, with every secret removed. */
function redactedConfig(deps: AppDeps): Record<string, unknown> {
  const { config } = deps;
  return {
    host: config.host,
    port: config.port,
    logLevel: config.logLevel,
    logFormat: config.logFormat,
    corsOrigin: config.corsOrigin,
    maxBodyBytes: config.maxBodyBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    dbPath: config.dbPath,
    apiKeys: { count: config.apiKeys.length, generated: config.generatedKey !== null },
    adminToken: { configured: config.adminToken !== null },
    auth: {
      bootstrapUser: config.auth.bootstrapUser,
      // Never the password itself — only whether the operator supplied one, so
      // the config page can say "will seed a random password" versus "will use it".
      bootstrapPassword: { configured: config.auth.bootstrapPassword !== '' },
      sessionTtlHours: config.auth.sessionTtlMs / 3_600_000,
      cookieName: config.auth.cookieName,
      cookieSecure: config.auth.cookieSecure,
      trustProxy: config.auth.trustProxy,
      maxAttempts: config.auth.maxAttempts,
      lockoutMs: config.auth.lockoutMs,
      attemptWindowMs: config.auth.attemptWindowMs,
    },
    agent: { ...config.agent },
    llm: {
      provider: config.llm.provider,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model,
      timeoutMs: config.llm.timeoutMs,
      apiKey: { configured: config.llm.apiKey !== '' },
      headerNames: Object.keys(config.llm.extraHeaders),
    },
    ollama: { ...config.ollama },
    models: {
      expose: config.models.expose,
      aliases: config.models.aliases,
      allowClientModel: config.models.allowClientModel,
      cacheTtlMs: config.models.cacheTtlMs,
    },
    tools: {
      ...config.tools,
      httpAllowHosts: config.tools.httpAllowHosts,
      fsAllowRoots: config.tools.fsAllowRoots,
    },
    rateLimit: { ...config.rateLimit },
    ws: { ...config.ws },
    onebot: {
      enabled: config.onebot.enabled,
      url: config.onebot.url,
      timeoutMs: config.onebot.timeoutMs,
      // Tokens are reported as booleans; this endpoint must never leak them.
      accessToken: { configured: config.onebot.accessToken !== '' },
      eventToken: { configured: config.onebot.eventToken !== '' },
      inbound: { ...config.onebot.inbound },
      tools: { ...config.onebot.tools },
    },
  };
}

export function registerAdminRoutes(
  router: Router,
  deps: AppDeps,
  routeList: () => Array<{ method: string; pattern: string }>,
): void {
  const { store, registry, provider, config, metrics, limiter } = deps;

  router.get('/admin/api/overview', (ctx) => {
    const counts = store.counts();
    sendJson(ctx.res, 200, {
      version: config.version,
      startedAt: deps.startedAt,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      provider: provider.id,
      model: deps.models.defaultModel,
      models: {
        defaultModel: deps.models.defaultModel,
        discovered: deps.models.discovered.length,
        discoveryOk: deps.models.discoveryOk,
        lastError: deps.models.lastError,
        exposed: deps.models.exposedNames(),
        aliases: Object.keys(config.models.aliases),
        allowClientModel: config.models.allowClientModel,
      },
      tools: {
        total: registry.size,
        enabled: registry.enabled().length,
        names: registry.enabled().map((tool) => tool.name),
      },
      apiKeys: { count: config.apiKeys.length, generated: config.generatedKey !== null },
      rateLimit: limiter.describe(),
      websocket: {
        path: config.ws.path,
        activeConnections: metrics.snapshot().websocket.active,
        maxPerConnection: config.ws.maxConnectionsPerKey,
      },
      store: { counts, dbPath: config.dbPath },
      onebot: config.onebot.enabled
        ? {
            enabled: true,
            url: config.onebot.url,
            inboundReady:
              config.onebot.inbound.enabled && config.onebot.eventToken !== '',
            trigger: config.onebot.inbound.trigger,
            sendingEnabled:
              config.onebot.tools.enabled &&
              (config.onebot.tools.allowGroups.length > 0 ||
                config.onebot.tools.allowUsers.length > 0),
            stats: deps.onebotBridge.stats,
          }
        : { enabled: false },
    });
  });

  /** Full model catalogue with aliases, exposure and upstream metadata. */
  router.get('/admin/api/models', async (ctx) => {
    const force = ctx.url.searchParams.get('refresh') === '1';
    await deps.models.refresh(force);
    sendJson(ctx.res, 200, {
      object: 'list',
      provider: provider.id,
      baseUrl: config.llm.provider === 'ollama' ? config.ollama.url : config.llm.baseUrl,
      defaultModel: deps.models.defaultModel,
      discoveryOk: deps.models.discoveryOk,
      lastError: deps.models.lastError,
      allowClientModel: config.models.allowClientModel,
      expose: config.models.expose,
      aliases: config.models.aliases,
      data: deps.models.describe(),
    });
  });

  router.get('/admin/api/metrics', (ctx) => {
    sendJson(ctx.res, 200, metrics.snapshot());
  });

  router.get('/admin/api/stats', (ctx) => {
    const stats = store.stats();
    sendJson(ctx.res, 200, {
      ...stats,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
    });
  });

  router.get('/admin/api/tools', (ctx) => {
    sendJson(ctx.res, 200, { object: 'list', data: registry.describe() });
  });

  router.get('/admin/api/config', (ctx) => {
    sendJson(ctx.res, 200, { object: 'config', config: redactedConfig(deps) });
  });

  router.get('/admin/api/routes', (ctx) => {
    sendJson(ctx.res, 200, { object: 'list', data: routeList() });
  });

  router.get('/admin/api/sessions', (ctx) => {
    const { fallback, min, max } = LIMITS.sessionList;
    const limit = clampInt(ctx.url.searchParams.get('limit'), fallback, min, max);
    const offset = clampInt(ctx.url.searchParams.get('offset'), 0, 0, 1_000_000);
    const data = store.listSessions(limit, offset).map((session) => ({
      ...session,
      messageCount: store.countMessages(session.id),
    }));
    sendJson(ctx.res, 200, { object: 'list', limit, offset, data });
  });

  router.get('/admin/api/sessions/:id', (ctx) => {
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

  router.delete('/admin/api/sessions/:id', (ctx) => {
    const id = ctx.params.id as string;
    const deleted = store.deleteSession(id);
    if (!deleted) throw new HttpError(404, `Session "${id}" was not found.`, 'session_not_found');
    sendJson(ctx.res, 200, { object: 'session.deleted', id, deleted: true });
  });

  router.put('/admin/api/sessions/:id', (ctx) => {
    const id = ctx.params.id as string;
    if (!store.getSession(id)) {
      throw new HttpError(404, `Session "${id}" was not found.`, 'session_not_found');
    }
    const body = asObject(ctx.body);
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      throw new HttpError(400, 'Field "title" must be a non-empty string.', 'invalid_title');
    }
    store.renameSession(id, body.title.trim());
    sendJson(ctx.res, 200, { object: 'session', session: store.getSession(id) });
  });

  router.get('/admin/api/runs', (ctx) => {
    const { fallback, min, max } = LIMITS.runs;
    const limit = clampInt(ctx.url.searchParams.get('limit'), fallback, min, max);
    sendJson(ctx.res, 200, { object: 'list', data: store.listRuns(limit) });
  });

  router.get('/admin/api/runs/:id', (ctx) => {
    const id = ctx.params.id as string;
    const run = store.getRun(id);
    if (!run) throw new HttpError(404, `Run "${id}" was not found.`, 'run_not_found');
    sendJson(ctx.res, 200, { object: 'run', run, toolInvocations: store.listToolInvocations(id) });
  });

  /* ----------------------------- reload ----------------------------- */

  /**
   * Requests an in-place reload.
   *
   * Answers `202` and reloads afterwards, because the reload either closes this
   * listener or rebinds it — finishing the response first is the only way the
   * caller learns the request was accepted. The outcome is reported by
   * `GET /admin/api/restart` (and by a reloaded `/healthz`), which is what the
   * console polls.
   *
   * `503` when the process did not install a reloader: `bootstrap()` alone
   * builds a server but does not own a lifecycle, as in the test fixtures.
   */
  router.post('/admin/api/restart', (ctx) => {
    const restart = deps.restart;
    if (restart === undefined) {
      throw new HttpError(
        503,
        'This process was started without a reload handler, so it cannot restart itself.',
        'restart_unavailable',
      );
    }
    if (restartInProgress()) {
      throw new HttpError(409, 'A reload is already in progress.', 'restart_in_progress');
    }

    const body = asObject(ctx.body);
    const reason =
      typeof body.reason === 'string' && body.reason.trim() !== ''
        ? body.reason.trim()
        : `requested by ${ctx.auth.key}`;
    const at = Date.now();

    sendJson(ctx.res, 202, { object: 'restart', scheduled: true, at, reason });
    // Let the response reach the socket before its connection is torn down.
    setTimeout(() => void restart(reason), 200);
  });

  /** Whether a reload is running, and how the last one ended. */
  router.get('/admin/api/restart', (ctx) => {
    sendJson(ctx.res, 200, {
      object: 'restart',
      restarting: restartInProgress(),
      last: lastReloadResult(),
      hotReload: config.hotReload,
      available: deps.restart !== undefined,
    });
  });
}
