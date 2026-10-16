/**
 * WebSocket access management, for the console.
 *
 *   GET    /admin/api/ws         endpoint, limits, and whether a token is set
 *   POST   /admin/api/ws/token   mint a token, write it to `.env`, return it once
 *   DELETE /admin/api/ws/token   blank it, reverting `/ws` to API-key auth
 *
 * Why a dedicated endpoint instead of only the config editor: every other secret
 * is write-only on purpose — the console can set one and never read it back. A
 * WebSocket credential is different, because it has to be *copied into a client*,
 * and the browser cannot set a header on a WebSocket handshake, so it ends up in
 * the query string. Minting it here and showing it exactly once is the same
 * bargain as the first-boot API key, and it keeps the "secrets are never read
 * back" rule intact for everything already stored.
 *
 * Both mutating endpoints demand `confirm: true`, for the same reason the config
 * editor does: rotating this credential disconnects every WebSocket client, and
 * that should not be one stray request away.
 */

import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { AppDeps } from '../app.ts';
import { readEnvFile, upsertEnv } from '../env-file.ts';
import { asObject } from '../http/body.ts';
import type { Router } from '../http/router.ts';
import { HttpError, sendJson } from '../http/response.ts';

/** Bytes of entropy behind a generated token; 24 bytes → 32 base64url chars. */
const TOKEN_BYTES = 24;

/** Environment variable the token lives in. */
const KEY = 'NAMI_WS_TOKEN';

/** Mints `nami_ws_<32 base64url chars>`. */
function generateWsToken(): string {
  return `nami_ws_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

/** Rejects a mutation that did not carry the explicit confirmation flag. */
function requireConfirmation(body: Record<string, unknown>): void {
  if (body.confirm !== true) {
    throw new HttpError(
      400,
      'Refusing to change the WebSocket token without "confirm": true.',
      'confirmation_required',
    );
  }
}

export function registerWsRoutes(router: Router, deps: AppDeps): void {
  const { config, metrics } = deps;

  const writeToken = (value: string): void => {
    let content: string;
    try {
      content = upsertEnv(readEnvFile(config.envPath), { [KEY]: value }).content;
    } catch (error) {
      throw new HttpError(
        500,
        `Failed to prepare ${config.envPath}: ${error instanceof Error ? error.message : String(error)}`,
        'ws_token_write_failed',
      );
    }
    try {
      writeFileSync(config.envPath, content, 'utf8');
    } catch (error) {
      throw new HttpError(
        500,
        `Could not write ${config.envPath}: ${error instanceof Error ? error.message : String(error)}. ` +
          'Check that the process owns the file and its directory.',
        'ws_token_write_failed',
      );
    }
  };

  router.get('/admin/api/ws', (ctx) => {
    const snapshot = metrics.snapshot();
    sendJson(ctx.res, 200, {
      object: 'ws',
      path: config.ws.path,
      // Whether a dedicated token is in force, never the token itself.
      tokenConfigured: config.ws.token !== null,
      activeConnections: snapshot.websocket.active,
      connectionsOpened: snapshot.websocket.connectionsOpened,
      messagesIn: snapshot.websocket.messagesIn,
      messagesOut: snapshot.websocket.messagesOut,
      maxConnectionsPerKey: config.ws.maxConnectionsPerKey,
      heartbeatMs: config.ws.heartbeatMs,
      maxPayloadBytes: config.ws.maxPayloadBytes,
      envPath: config.envPath,
      hotReload: config.hotReload,
    });
  });

  router.post('/admin/api/ws/token', (ctx) => {
    requireConfirmation(asObject(ctx.body));
    const token = generateWsToken();
    writeToken(token);
    // The token itself is deliberately absent from this log line.
    deps.log.info('generated a WebSocket token', { env: config.envPath });

    sendJson(ctx.res, 201, {
      object: 'ws.token',
      token,
      written: config.envPath,
      hotReload: config.hotReload,
      note: config.hotReload
        ? '已写入并触发热重载，约 1 秒后 /ws 只认这个令牌。令牌只显示这一次，请立刻复制。'
        : '已写入，但热重载已关闭：请点「重启」使其生效。令牌只显示这一次，请立刻复制。',
    });
  });

  router.delete('/admin/api/ws/token', (ctx) => {
    requireConfirmation(asObject(ctx.body));
    // Blanking the value, rather than deleting the line, keeps `.env` readable:
    // the empty assignment is exactly how the setting is documented.
    writeToken('');
    deps.log.info('removed the WebSocket token; /ws falls back to API keys', {
      env: config.envPath,
    });

    sendJson(ctx.res, 200, {
      object: 'ws.token',
      removed: true,
      written: config.envPath,
      hotReload: config.hotReload,
      note: config.hotReload
        ? '已清空并触发热重载，约 1 秒后 /ws 重新接受 API Key。'
        : '已清空，但热重载已关闭：请点「重启」使其生效。',
    });
  });
}
