/**
 * WebSocket gateway: the bidirectional transport for `/ws`.
 *
 * JSON control channel. The client sends `user_message` (and optionally
 * `cancel`, `ping`, `history`, `sessions`); the server replies with the same
 * event vocabulary the SSE endpoint uses, flattened as `{ type, ...data }`.
 *
 *   client -> { type: 'user_message', content: string, sessionId?: string }
 *   server -> { type: 'run.start' | 'delta' | 'tool.call' | 'tool.result'
 *                    | 'run.end' | 'error' | 'ready' | 'pong'
 *                    | 'history' | 'sessions' | 'cancelled', ... }
 */

import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { LLMProvider } from '../llm/types.ts';
import type { SessionStore } from '../store/store.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { runAgent } from '../core/agent.ts';
import { authenticate, maskKey } from '../http/auth.ts';
import { HttpError } from '../http/response.ts';
import { buildHandshake } from './frames.ts';
import { WebSocketConnection } from './connection.ts';

export interface WebSocketGatewayDeps {
  config: Config;
  log: Logger;
  store: SessionStore;
  registry: ToolRegistry;
  provider: LLMProvider;
  metrics: Metrics;
}

interface ClientState {
  sessionId: string | null;
  abort: AbortController | null;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  426: 'Upgrade Required',
  429: 'Too Many Requests',
};

function writeHttpError(socket: Socket, status: number, message: string, code: string): void {
  const body = JSON.stringify({ error: { message, type: 'invalid_request_error', code } });
  const response = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'content-type: application/json; charset=utf-8',
    `content-length: ${Buffer.byteLength(body)}`,
    'connection: close',
    '\r\n',
    body,
  ].join('\r\n');
  try {
    socket.write(response);
  } catch {
    /* peer already gone */
  }
  socket.destroy();
}

export class WebSocketGateway {
  private readonly deps: WebSocketGatewayDeps;
  private readonly connections = new Set<WebSocketConnection>();
  private readonly perKey = new Map<string, number>();

  constructor(deps: WebSocketGatewayDeps) {
    this.deps = deps;
  }

  get activeConnections(): number {
    return this.connections.size;
  }

  /** Handles an HTTP `upgrade` event for the configured WebSocket path. */
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const { config, log, metrics } = this.deps;

    // Attach a listener immediately: a socket error before the handshake would
    // otherwise surface as an unhandled 'error' event.
    socket.on('error', () => socket.destroy());

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== config.ws.path) {
      writeHttpError(socket, 404, `No WebSocket endpoint at ${url.pathname}`, 'not_found');
      return;
    }

    let auth;
    try {
      auth = authenticate(config, req, url, { allowQuery: true });
    } catch (error) {
      const httpError = error instanceof HttpError ? error : null;
      metrics.recordAuthRejection();
      writeHttpError(
        socket,
        httpError?.status ?? 401,
        httpError?.message ?? 'Authentication failed',
        httpError?.code ?? 'unauthorized',
      );
      return;
    }

    const limit = config.ws.maxConnectionsPerKey;
    const open = this.perKey.get(auth.key) ?? 0;
    if (open >= limit) {
      writeHttpError(
        socket,
        429,
        `Too many concurrent WebSocket connections (limit ${limit} per key)`,
        'too_many_connections',
      );
      return;
    }

    const handshake = buildHandshake(req);
    if (!handshake.ok) {
      writeHttpError(socket, handshake.status, handshake.message, 'invalid_handshake');
      return;
    }

    socket.write(handshake.response);

    const connection = new WebSocketConnection(socket, {
      maxPayloadBytes: config.ws.maxPayloadBytes,
      heartbeatMs: config.ws.heartbeatMs,
    });
    const log$ = log.child({ ws: true, key: maskKey(auth.key), peer: connection.remoteAddress });
    const state: ClientState = { sessionId: null, abort: null };

    this.connections.add(connection);
    this.perKey.set(auth.key, open + 1);
    metrics.recordWsOpen();

    connection.on({
      onMessage: (text) => {
        metrics.recordWsIn();
        this.handleClientMessage(connection, state, text, log$);
      },
      onError: (error) => {
        log$.warn('websocket error', { error: error.message });
      },
      onClose: (code, reason) => {
        state.abort?.abort(new Error('client disconnected'));
        state.abort = null;
        this.connections.delete(connection);
        const remaining = (this.perKey.get(auth.key) ?? 1) - 1;
        if (remaining <= 0) this.perKey.delete(auth.key);
        else this.perKey.set(auth.key, remaining);
        metrics.recordWsClose();
        log$.info('websocket closed', { code, reason });
      },
    });

    connection.sendJson({
      type: 'ready',
      provider: this.deps.provider.id,
      model: this.deps.provider.model,
      tools: this.deps.registry.enabled().map((tool) => tool.name),
      protocol: 1,
      heartbeatMs: config.ws.heartbeatMs,
    });

    // Bytes that shared the upgrade packet are protocol data, not handshake.
    connection.ingest(head);

    log$.info('websocket opened');
  }

  private handleClientMessage(
    connection: WebSocketConnection,
    state: ClientState,
    text: string,
    log: Logger,
  ): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('message must be a JSON object');
      }
      message = parsed as Record<string, unknown>;
    } catch (error) {
      connection.sendJson({
        type: 'error',
        message: `Invalid message: ${error instanceof Error ? error.message : String(error)}`,
        code: 'invalid_message',
      });
      return;
    }

    const type = String(message.type ?? '');

    switch (type) {
      case 'ping':
        connection.sendJson({ type: 'pong', ts: Date.now() });
        return;

      case 'cancel':
        if (state.abort) {
          state.abort.abort(new Error('cancelled by client'));
          state.abort = null;
          connection.sendJson({ type: 'cancelled', sessionId: state.sessionId });
        } else {
          connection.sendJson({ type: 'error', message: 'No run is in progress.', code: 'idle' });
        }
        return;

      case 'history': {
        const sessionId = typeof message.sessionId === 'string' ? message.sessionId : state.sessionId;
        if (!sessionId) {
          connection.sendJson({ type: 'error', message: 'sessionId is required.', code: 'bad_request' });
          return;
        }
        const limit = Number(message.limit ?? 100) || 100;
        connection.sendJson({
          type: 'history',
          sessionId,
          messages: this.deps.store.getMessages(sessionId, Math.min(500, Math.max(1, limit))),
        });
        return;
      }

      case 'sessions': {
        const limit = Number(message.limit ?? 50) || 50;
        connection.sendJson({
          type: 'sessions',
          data: this.deps.store.listSessions(Math.min(200, Math.max(1, limit)), 0),
        });
        return;
      }

      case 'user_message':
        break;

      default:
        connection.sendJson({
          type: 'error',
          message: `Unsupported message type "${type || '(missing)'}". Expected one of: user_message, cancel, ping, history, sessions.`,
          code: 'unsupported_type',
        });
        return;
    }

    const content = typeof message.content === 'string' ? message.content : '';
    if (content.trim() === '') {
      connection.sendJson({ type: 'error', message: 'content must be a non-empty string.', code: 'bad_request' });
      return;
    }

    if (state.abort) {
      connection.sendJson({
        type: 'error',
        message: 'A run is already in progress on this connection. Send {"type":"cancel"} first.',
        code: 'run_in_progress',
      });
      return;
    }

    const sessionId =
      typeof message.sessionId === 'string' && message.sessionId !== ''
        ? message.sessionId
        : state.sessionId ?? undefined;

    const controller = new AbortController();
    state.abort = controller;

    void this.runTurn(connection, state, controller, {
      input: content,
      ...(sessionId ? { sessionId } : {}),
      ...(typeof message.system === 'string' ? { system: message.system } : {}),
      ...(typeof message.maxRounds === 'number' ? { maxRounds: message.maxRounds } : {}),
    }, log);
  }

  private async runTurn(
    connection: WebSocketConnection,
    state: ClientState,
    controller: AbortController,
    input: { input: string; sessionId?: string; system?: string; maxRounds?: number },
    log: Logger,
  ): Promise<void> {
    const { provider, registry, store, config, metrics } = this.deps;
    metrics.recordRunStart();

    try {
      const events = runAgent(
        { deps: { store, registry, provider, config, log }, signal: controller.signal },
        input,
      );

      for await (const event of events) {
        if (event.type === 'run.start') state.sessionId = event.data.sessionId;
        if (event.type === 'delta') metrics.recordDelta(event.data.text.length);
        if (event.type === 'tool.call') metrics.recordToolCall();
        if (event.type === 'run.end') metrics.recordRunEnd('succeeded');
        if (event.type === 'error') {
          metrics.recordRunEnd(controller.signal.aborted ? 'cancelled' : 'failed');
        }

        const delivered = connection.sendJson({
          type: event.type,
          ...(event.data as Record<string, unknown>),
        });
        if (delivered) metrics.recordWsOut();
        if (!delivered) {
          // Socket is gone: stop the run instead of burning model tokens.
          controller.abort(new Error('client disconnected'));
          break;
        }
      }
    } catch (error) {
      metrics.recordRunEnd('failed');
      log.error('websocket run failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      connection.sendJson({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        code: 'run_failed',
      });
    } finally {
      if (state.abort === controller) state.abort = null;
    }
  }

  /** Terminates every open connection, used during shutdown. */
  closeAll(code = 1001, reason = 'server shutting down'): void {
    for (const connection of this.connections) {
      connection.close(code, reason);
    }
    this.connections.clear();
    this.perKey.clear();
  }
}
