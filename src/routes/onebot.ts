/**
 * OneBot v11 HTTP surface.
 *
 *   POST /onebot/event              inbound reports (shared-secret auth)
 *   GET  /admin/api/onebot/status   diagnostics, no secrets echoed
 *   POST /admin/api/onebot/event    synchronous simulation, for testing
 *   POST /admin/api/onebot/send     manual send, for testing
 *
 * The public report endpoint answers `204` *before* running the agent: OneBot
 * reporters time out in seconds, while a local model may take a minute.
 */

import type { AppDeps } from '../app.ts';
import type { OneBotEvent } from '../onebot/bridge.ts';
import { constantTimeEqual } from '../http/auth.ts';
import { asObject } from '../http/body.ts';
import type { Router } from '../http/router.ts';
import { HttpError, sendJson } from '../http/response.ts';
import { atSegment, textSegment } from '../onebot/client.ts';

/** Pulls the shared secret from a header or query parameter. */
function readEventToken(
  req: { headers: Record<string, string | string[] | undefined> },
  url: URL,
): string | null {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  const header = req.headers['x-onebot-token'];
  if (typeof header === 'string' && header.trim() !== '') return header.trim();
  const query = url.searchParams.get('access_token') ?? url.searchParams.get('token');
  return query && query.trim() !== '' ? query.trim() : null;
}

export function registerOneBotRoutes(router: Router, deps: AppDeps): void {
  const { config, log } = deps;
  const bridge = deps.onebotBridge;
  const client = deps.onebotClient;
  const onebot = config.onebot;

  /* ------------------------- inbound event reports ------------------------ */

  router.post('/onebot/event', (ctx) => {
    if (!onebot.enabled || !onebot.inbound.enabled) {
      throw new HttpError(
        503,
        'The OneBot inbound bridge is disabled. Set NAMI_ONEBOT_ENABLED=true (and NAMI_ONEBOT_INBOUND_ENABLED).',
        'onebot_disabled',
      );
    }
    // Without a secret the endpoint would be an open, LLM-billing trigger.
    if (onebot.eventToken === '') {
      throw new HttpError(
        503,
        'NAMI_ONEBOT_EVENT_TOKEN is not set, so inbound reports are refused. ' +
          'Configure the same value as the reporter\'s secret/token.',
        'onebot_no_event_token',
      );
    }

    const presented = readEventToken(ctx.req, ctx.url);
    if (presented === null) {
      throw new HttpError(401, 'Missing OneBot report token.', 'missing_event_token');
    }
    if (!constantTimeEqual(presented, onebot.eventToken)) {
      throw new HttpError(401, 'Invalid OneBot report token.', 'invalid_event_token');
    }

    const event = asObject(ctx.body, 'OneBot event') as OneBotEvent;
    const headerSelfId = ctx.req.headers['x-self-id'];
    const selfId = String(
      event.self_id ?? (typeof headerSelfId === 'string' ? headerSelfId : '') ?? '',
    );

    // Answer first, work later: the reporter must not wait for the model.
    ctx.res.writeHead(204).end();

    void bridge
      .process(event, selfId)
      .then((outcome) => {
        if (outcome.handled) {
          log.info('onebot event handled', {
            sessionId: outcome.sessionId,
            chunks: outcome.chunks,
            ms: outcome.durationMs,
          });
        }
      })
      .catch((error: unknown) => {
        log.error('onebot event processing crashed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  });

  /* ------------------------------ diagnostics ---------------------------- */

  router.get('/admin/api/onebot/status', async (ctx) => {
    const probe = await probeConnection(client);
    sendJson(ctx.res, 200, {
      object: 'onebot.status',
      enabled: onebot.enabled,
      url: onebot.url,
      // Secrets are reported as booleans, never echoed.
      accessTokenConfigured: onebot.accessToken !== '',
      eventTokenConfigured: onebot.eventToken !== '',
      inbound: {
        enabled: onebot.inbound.enabled,
        path: '/onebot/event',
        trigger: onebot.inbound.trigger,
        prefix: onebot.inbound.prefix,
        allowGroups: onebot.inbound.allowGroups,
        allowUsers: onebot.inbound.allowUsers,
        sessionPrefix: onebot.inbound.sessionPrefix,
        maxReplyChars: onebot.inbound.maxReplyChars,
        stripMarkdown: onebot.inbound.stripMarkdown,
        maxConcurrent: onebot.inbound.maxConcurrent,
        // A report endpoint with no secret is inert, which surprises people.
        ready: onebot.enabled && onebot.inbound.enabled && onebot.eventToken !== '',
      },
      tools: {
        enabled: onebot.tools.enabled,
        sendingEnabled: onebot.enabled && onebot.tools.enabled,
        allowGroups: onebot.tools.allowGroups,
        allowUsers: onebot.tools.allowUsers,
      },
      bridge: bridge.stats,
      connection: probe,
    });
  });

  /* ------------------------- synchronous simulation ---------------------- */

  router.post('/admin/api/onebot/event', async (ctx) => {
    const body = asObject(ctx.body);
    const selfId = String(ctx.req.headers['x-self-id'] ?? body.self_id ?? '');
    const outcome = await bridge.process(body as OneBotEvent, selfId);
    sendJson(ctx.res, outcome.reason === 'failed' ? 502 : 200, {
      object: 'onebot.event.result',
      ...outcome,
      hint:
        outcome.reason === 'no-trigger'
          ? `The message did not match the trigger rule "${onebot.inbound.trigger}".`
          : outcome.reason === 'from-self'
            ? 'The event sender equals self_id, so it was ignored to avoid a reply loop.'
            : outcome.reason === 'busy'
              ? 'A run for this conversation is already in flight, or the concurrency cap is reached.'
              : undefined,
    });
  });

  /* ------------------------------- manual send --------------------------- */

  router.post('/admin/api/onebot/send', async (ctx) => {
    if (!onebot.enabled) {
      throw new HttpError(503, 'The OneBot connector is disabled (NAMI_ONEBOT_ENABLED).', 'onebot_disabled');
    }
    if (!client) throw new HttpError(503, 'No OneBot client is available.', 'onebot_disabled');

    const body = asObject(ctx.body);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text === '') throw new HttpError(400, 'Field "text" must be a non-empty string.', 'missing_text');

    const groupId = body.group_id !== undefined ? String(body.group_id) : '';
    const userId = body.user_id !== undefined ? String(body.user_id) : '';
    if (groupId === '' && userId === '') {
      throw new HttpError(400, 'Provide either "group_id" or "user_id".', 'missing_target');
    }

    const segments = body.at !== undefined
      ? [atSegment(String(body.at)), textSegment(` ${text}`)]
      : [textSegment(text)];

    const result =
      groupId !== ''
        ? await client.sendGroupMsg(groupId, segments)
        : await client.sendPrivateMsg(userId, segments);

    sendJson(ctx.res, 200, {
      object: 'onebot.sent',
      target: groupId !== '' ? { kind: 'group', id: groupId } : { kind: 'private', id: userId },
      messageId: result?.message_id ?? null,
    });
  });
}

/** Probes the OneBot implementation, never throwing. */
async function probeConnection(client: AppDeps['onebotClient']): Promise<Record<string, unknown>> {
  try {
    const [login, status] = await Promise.all([
      client.getLoginInfo().catch(() => null),
      client.getStatus().catch(() => null),
    ]);
    if (!login && !status) {
      return { reachable: false, error: 'no response to get_login_info / get_status' };
    }
    return {
      reachable: true,
      account: login ? { userId: login.user_id, nickname: login.nickname } : null,
      online: status?.online ?? null,
      good: status?.good ?? null,
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
