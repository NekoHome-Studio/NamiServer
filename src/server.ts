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
import { authenticate, authenticateAdmin, maskKey } from './http/auth.ts';
import { HttpError, applyCors, sendError, sendJson, sendText } from './http/response.ts';
import { Router } from './http/router.ts';
import type { AuthInfo, RequestContext } from './http/types.ts';
import { registerAdminRoutes } from './routes/admin.ts';
import { registerAgentRoutes } from './routes/agent.ts';
import { registerHealthRoutes } from './routes/health.ts';
import { registerOneBotRoutes } from './routes/onebot.ts';
import { registerOpenAiRoutes } from './routes/openai.ts';
import { registerSessionRoutes } from './routes/sessions.ts';
import { buildOpenApiDocument } from './openapi.ts';
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

function needsAuth(pathname: string): 'api' | 'admin' | null {
  if (pathname === '/v1' || pathname.startsWith('/v1/')) return 'api';
  if (pathname.startsWith('/admin/api')) return 'admin';
  return null;
}

export function createNamiServer(deps: AppDeps): NamiServer {
  const { config, log, metrics, limiter } = deps;

  const router = new Router();

  registerHealthRoutes(router, deps);
  registerOpenAiRoutes(router, deps);
  registerAgentRoutes(router, deps);
  registerSessionRoutes(router, deps);
  registerOneBotRoutes(router, deps);
  registerAdminRoutes(router, deps, () => router.describe());

  // Pages and the machine-readable spec are all unauthenticated: they contain no
  // data, and API consumers need the contract before they have a key.
  const htmlHeaders = (): Record<string, string> => ({
    'cache-control': 'no-cache',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
    'x-content-type-options': 'nosniff',
  });

  const servePanel = (ctx: RequestContext): void => {
    sendText(ctx.res, 200, getPanelHtml(), 'text/html; charset=utf-8', htmlHeaders());
  };
  const serveDocs = (ctx: RequestContext): void => {
    sendText(ctx.res, 200, getDocsHtml(), 'text/html; charset=utf-8', htmlHeaders());
  };

  router.get('/admin', servePanel);
  router.get('/admin/', servePanel);
  router.get('/docs', serveDocs);
  router.get('/docs/', serveDocs);

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

      const authKind = needsAuth(url.pathname);
      if (authKind === 'api') {
        auth = authenticate(config, req, url);
      } else if (authKind === 'admin') {
        auth = authenticateAdmin(config, req, url);
      }

      if (authKind !== null && limiter.enabled) {
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
