/**
 * Liveness and readiness probes. Both are intentionally unauthenticated so
 * container orchestrators and load balancers can reach them.
 */

import type { AppDeps } from '../app.ts';
import type { Router } from '../http/router.ts';
import { sendJson } from '../http/response.ts';

export function registerHealthRoutes(router: Router, deps: AppDeps): void {
  const { config, store, provider, registry, metrics } = deps;

  router.get('/healthz', (ctx) => {
    // Liveness: the process is up and the event loop is responsive.
    sendJson(ctx.res, 200, {
      status: 'ok',
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      node: process.version,
      pid: process.pid,
    });
  });

  router.get('/readyz', (ctx) => {
    const checks: Record<string, string> = {};
    let ready = true;

    try {
      store.counts();
      checks.database = 'ok';
    } catch (error) {
      checks.database = error instanceof Error ? error.message : 'unavailable';
      ready = false;
    }

    checks.provider = provider.id;
    const defaultModel = deps.models.defaultModel;
    checks.model = defaultModel === '' ? 'none selected' : defaultModel;
    checks.models =
      deps.models.discoveryOk
        ? `${deps.models.discovered.length} available`
        : (deps.models.lastError ?? 'not probed');

    // Without a usable model the server cannot answer anything, so it is not ready.
    if (defaultModel === '') ready = false;
    checks.tools = `${registry.enabled().length}/${registry.size} enabled`;
    checks.apiKeys = config.apiKeys.length > 0 ? 'configured' : 'missing';
    if (config.apiKeys.length === 0) ready = false;

    sendJson(ctx.res, ready ? 200 : 503, {
      ready,
      checks,
      uptimeSeconds: metrics.snapshot().uptimeSeconds,
    });
  });
}
