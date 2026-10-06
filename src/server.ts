/**
 * HTTP server assembly: middleware, auth, rate limiting, routing, and the
 * WebSocket upgrade hand-off.
 *
 * Order of operations per request:
 *   CORS → request id → auth (by path prefix) → rate limit → route match →
 *   body read → handler → access log + metrics.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { AppDeps } from './app.ts';
import { asObject, parseJsonBody, readRawBody } from './http/body.ts';
import { authenticate, authenticateAdmin, authenticateOptional, maskKey } from './http/auth.ts';
import type { SessionResolution } from './http/auth.ts';
import { HttpError, applyCors, sendError, sendJson, sendText } from './http/response.ts';
import { Router } from './http/router.ts';
import type { AuthInfo, RequestContext } from './http/types.ts';
import { hashSessionToken } from './auth/tokens.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAgentRoutes } from './routes/agent.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerConfigRoutes } from './routes/config.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerLogRoutes } from './routes/logs.ts';
import { registerOneBotRoutes } from './routes/onebot.ts';
import { registerOpenAiRoutes } from './routes/openai.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { buildOpenApiDocument } from './openapi.ts';
import { readAppAsset, readAppIndex } from './web/app.ts';
import { getDocsHtml, getPanelHtml } from './web/panel.ts';
import { WebSocketGateway } from './ws/gateway.ts';

export interface NamiServer {
  server: Server;
  router: Router;
  gateway: WebSocketGateway;
  /** Resolves once the listener is closed. */
  close(): Promise<void>;
}

const ANONYMOUS: AuthInfo = { key: 'anonymous', via: 'none', isAdmin: false };

function needsAuth(pathname: string): 'api' | 'admin' | 'optional' | null {
  if (pathname === '/v1' || pathname.startsWith('/v1/')) return 'api';
  if (pathname.startsWith('/admin/api')) {
    // The login endpoints cannot require a session — obtaining one is the point.
    // They are not simply public either: `/me` and `logout` must still *resolve*
    // a session when one is present, so they use the optional tier.
    return PUBLIC_ADMIN_PATHS.has(pathname) ? 'optional' : 'admin';
  }
  return null;
}

/**
 * Admin endpoints a browser reaches with `EventSource`, which cannot set
 * request headers — so these, and only these, also accept `?key=`.
 */
const QUERY_AUTH_ADMIN_PATHS = new Set(['/admin/api/logs/stream']);

/** Reachable without any credential, by definition. */
const PUBLIC_ADMIN_PATHS = new Set([
  '/admin/api/auth/login',
  '/admin/api/auth/logout',
  '/admin/api/auth/me',
]);

export function createNamiServer(deps: AppDeps): NamiServer {
  const { config, log, metrics, limiter } = deps;

  const router = new Router();

  registerHealthRoutes(router, deps);
  registerOpenAiRoutes(router, deps);
  registerAgentRoutes(router, deps);
  registerSessionRoutes(router, deps);
  registerOneBotRoutes(router, deps);
  registerLogRoutes(router, deps);
  registerConfigRoutes(router, deps);
  // Registered before the other admin routes so `/admin/api/auth/*` can never be
  // shadowed by a parameterised pattern.
  registerAuthRoutes(router, deps);
  registerAdminRoutes(router, deps, () => router.describe());

  /**
   * Turns a session cookie into an authenticated caller.
   *
   * The store owns expiry and the disabled flag, so a session that outlives its
   * TTL or belongs to an account that was switched off is rejected here without
   * this file having to remember either rule. `last_seen_at` slides on use.
   */
  const resolveSession = (token: string): SessionResolution | null => {
    const hash = hashSessionToken(token);
    const found = deps.store.findAuthSession(hash);
    if (!found) return null;
    deps.store.touchAuthSession(hash);
    return {
      user: {
        id: found.user.id,
        username: found.user.username,
        isAdmin: found.user.isAdmin,
      },
      sessionTokenHash: hash,
    };
  };

  // Pages and the machine-readable spec are all unauthenticated: they contain no
  // data, and API consumers need the contract before they have a key.

  /**
   * CSP for the **self-contained** documents (`/admin/classic`, `/docs`).
   *
   * Both carry every byte of their JS and CSS inline, so `'unsafe-inline'` is
   * exactly what they need and nothing else. `default-src 'none'` then stops
   * them from pulling in any external resource at all.
   */
  const inlineHtmlHeaders = (): Record<string, string> => ({
    'cache-control': 'no-cache',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
  });

  /**
   * CSP for the **built WebUI** at `/admin`.
   *
   * This one must differ from {@link inlineHtmlHeaders}, because the SPA is its
   * exact opposite: `index.html` pulls its JS and CSS from external files under
   * `/admin/assets/`. Serving it with the inline-only policy silently blocked
   * the module script and the stylesheet in every browser — a blank page that
   * neither curl (which does not evaluate CSP) nor a status-code assertion can
   * see. Hence `'self'` in both `script-src` and `style-src`.
   *
   * `style-src` keeps `'unsafe-inline'` on purpose: Vuetify writes the active
   * theme's CSS variables into a `<style>` element at runtime.
   */
  const spaHtmlHeaders = (): Record<string, string> => ({
    'cache-control': 'no-cache',
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
  });

  const serveClassicPanel = (ctx: RequestContext): void => {
    sendText(ctx.res, 200, getPanelHtml(), 'text/html; charset=utf-8', inlineHtmlHeaders());
  };
  const serveDocs = (ctx: RequestContext): void => {
    sendText(ctx.res, 200, getDocsHtml(), 'text/html; charset=utf-8', inlineHtmlHeaders());
  };

  // The classic single-file panel stays reachable at /admin/classic. It is both
  // an escape hatch when the SPA misbehaves and the fallback when no WebUI build
  // is present at all.
  router.get('/admin/classic', serveClassicPanel);
  router.get('/docs', serveDocs);
  router.get('/docs/', serveDocs);

  /**
   * Serves the built WebUI and any asset beneath the `/admin` path.
   *
   * Handled ahead of the router on purpose: these are static files, not API
   * routes, and keeping them out of the routing table keeps the OpenAPI drift
   * check meaningful (every registered route must appear in the spec).
   *
   * @returns true when the request was handled here.
   */
  function serveWebUi(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    const path = url.pathname;
    if (path !== '/admin' && !path.startsWith('/admin/')) return false;
    // The API lives under the same prefix and must keep going through the router.
    if (path.startsWith('/admin/api')) return false;
    if (path === '/admin/classic') return false;

    const indexHtml = readAppIndex();
    if (indexHtml === null) return false; // no build: let the router 404

    if (path === '/admin' || path === '/admin/') {
      sendText(res, 200, indexHtml, 'text/html; charset=utf-8', spaHtmlHeaders());
      return true;
    }

    const asset = readAppAsset(path.slice('/admin/'.length));
    if (asset === null) {
      // Unknown path under /admin: hand back the shell so hash routing can take
      // over, rather than a dead end. Only for navigation requests, though —
      // a missing .js must 404 so the failure is visible.
      if (/\.[a-z0-9]+$/i.test(path)) {
        sendError(res, 404, `No such asset: ${path}`, { code: 'not_found' });
        return true;
      }
      sendText(res, 200, indexHtml, 'text/html; charset=utf-8', spaHtmlHeaders());
      return true;
    }

    const headers: Record<string, string> = {
      'content-type': asset.contentType,
      'x-content-type-options': 'nosniff',
      'content-length': String(asset.body.length),
      'cache-control': asset.immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };
    if (!res.headersSent) res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : asset.body);
    return true;
  }

  const openApiDocument = buildOpenApiDocument(deps);
  router.get('/openapi.json', (ctx) => {
    sendJson(ctx.res, 200, openApiDocument, {
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
  });

  const gateway = new WebSocketGateway(deps);

  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    gateway.handleUpgrade(req, socket, head);
  });

  // Reject malformed requests with a proper 400 instead of a socket reset.
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    if (!socket.writable) return;
    const status = error.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? 408 : 400;
    socket.end(
      `HTTP/1.1 ${status} Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  });

  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.max(60_000, config.requestTimeoutMs);
  server.keepAliveTimeout = 65_000;

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let routeLabel = 'unmatched';
    let auth: AuthInfo = ANONYMOUS;

    res.setHeader('x-request-id', requestId);
    res.setHeader('x-nami-version', config.version);
    applyCors(res, req.headers.origin, config.corsOrigin);

    res.on('finish', () => {
      const micros = Number(process.hrtime.bigint() - startedAt) / 1000;
      metrics.recordRequest(routeLabel, res.statusCode);
      log.info('request', {
        method,
        path: url.pathname,
        status: res.statusCode,
        ms: Math.round(micros / 100) / 10,
        route: routeLabel,
        key: maskKey(auth.key),
        requestId,
      });
    });

    const ctxBase = {
      req,
      res,
      url,
      requestId,
      log: log.child({ requestId }),
    };

    try {
      if (method === 'OPTIONS') {
        routeLabel = 'preflight';
        res.writeHead(204).end();
        return;
      }

      // The WebUI and its assets are served ahead of the router and outside the
      // API auth model: they are public static files.
      if ((method === 'GET' || method === 'HEAD') && serveWebUi(req, res, url)) {
        routeLabel = url.pathname.startsWith('/admin/assets/') ? 'webui:asset' : 'webui:page';
        return;
      }

      const authOptions = {
        allowQuery: QUERY_AUTH_ADMIN_PATHS.has(url.pathname),
        resolveSession,
        cookieName: config.auth.cookieName,
      };
      const authKind = needsAuth(url.pathname);
      if (authKind === 'api') {
        auth = authenticate(config, req, url, authOptions);
      } else if (authKind === 'admin') {
        auth = authenticateAdmin(config, req, url, authOptions);
      } else if (authKind === 'optional') {
        // Login endpoints: resolve a session when there is one, but never fail.
        auth = authenticateOptional(config, req, url, authOptions);
      }

      // Unauthenticated calls to the optional tier are not rate-limited: the
      // console polls `/me`, and charging those to the anonymous bucket would
      // throttle a signed-out browser for no benefit.
      if ((authKind === 'api' || authKind === 'admin') && limiter.enabled) {
        const decision = limiter.check(auth.key);
        res.setHeader('x-ratelimit-limit', String(decision.limit));
        res.setHeader('x-ratelimit-remaining', String(decision.remaining));
        if (!decision.allowed) {
          metrics.recordRateLimitRejection();
          res.setHeader('retry-after', String(decision.retryAfterSeconds));
          throw new HttpError(
            429,
            `Rate limit exceeded. Retry in ${decision.retryAfterSeconds}s.`,
            'rate_limited',
          );
        }
      }

      const matched = router.match(method, url.pathname);

      if (matched === null) {
        throw new HttpError(404, `No route matches ${method} ${url.pathname}.`, 'not_found');
      }

      if ('methodMismatch' in matched) {
        res.setHeader('allow', matched.methodMismatch.join(', '));
        throw new HttpError(
          405,
          `Method ${method} is not allowed on ${url.pathname}. Allowed: ${matched.methodMismatch.join(', ')}.`,
          'method_not_allowed',
        );
      }

      routeLabel = matched.pattern;

      // Bodies are read only after a route matched, so 404s stay cheap.
      let rawBody = '';
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        try {
          rawBody = await readRawBody(req, config.maxBodyBytes);
          metrics.recordBytesIn(Buffer.byteLength(rawBody));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(400, 'Failed to read the request body.', 'body_read_failed');
        }
      }

      const context: RequestContext = {
        ...ctxBase,
        params: matched.params,
        route: matched.pattern,
        body: parseJsonBody(rawBody),
        rawBody,
        auth,
      };

      await matched.handler(context);
    } catch (error) {
      metrics.recordError();
      handleError(error, res, requestId, auth, log);
    }
  }

  return {
    server,
    router,
    gateway,
    close(): Promise<void> {
      return new Promise((resolve) => {
        gateway.closeAll();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        // Sockets kept alive by SSE or idle keep-alive would otherwise delay
        // close() indefinitely.
        server.closeIdleConnections?.();
        setTimeout(() => server.closeAllConnections?.(), 500).unref?.();
      });
    },
  };
}

function handleError(
  error: unknown,
  res: ServerResponse,
  requestId: string,
  auth: AuthInfo,
  log: AppDeps['log'],
): void {
  if (res.headersSent) {
    // A stream already started; the only correct move is to end it.
    if (!res.writableEnded) res.end();
    return;
  }

  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) {
      log.warn('request rejected', { status: error.status, code: error.code, requestId });
    }
    sendError(res, error.status, error.message, {
      code: error.code,
      requestId,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  log.error('unhandled request error', { error: message, requestId, key: maskKey(auth.key) });
  sendError(res, 500, 'Internal server error.', { code: 'internal_error', requestId });
}

/** Convenience re-export so callers can build a JSON body without extra imports. */
export { asObject, sendJson };
