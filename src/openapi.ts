/**
 * OpenAPI 3.1 description of Nami's HTTP surface.
 *
 * Hand-written rather than generated, because the prose is the point: a hosted
 * API is only usable if consumers can read what each endpoint does. The smoke
 * test asserts that this document covers every registered route, so it cannot
 * silently drift away from the implementation.
 */

import type { AppDeps } from './app.ts';

type Json = Record<string, unknown>;

const ERROR_SCHEMA: Json = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['message', 'type', 'code'],
      properties: {
        message: { type: 'string', description: 'Human-readable explanation.' },
        type: {
          type: 'string',
          enum: ['invalid_request_error', 'server_error'],
        },
        code: { type: 'string', description: 'Stable machine-readable code.' },
        request_id: { type: 'string', format: 'uuid' },
        details: {},
      },
    },
  },
};

const TOOL_CALL_SCHEMA: Json = {
  type: 'object',
  required: ['id', 'type', 'function'],
  properties: {
    id: { type: 'string' },
    type: { type: 'string', const: 'function' },
    function: {
      type: 'object',
      required: ['name', 'arguments'],
      properties: {
        name: { type: 'string' },
        arguments: {
          type: 'string',
          description: 'JSON-encoded arguments, exactly as the model produced them.',
        },
      },
    },
  },
};

const CHAT_MESSAGE_SCHEMA: Json = {
  type: 'object',
  required: ['role'],
  properties: {
    role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
    content: {
      description: 'String, or an array of content parts with a `text` field.',
      oneOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'object', properties: { text: { type: 'string' } } } },
        { type: 'null' },
      ],
    },
    name: { type: 'string', description: 'Tool name, on `tool` messages.' },
    tool_call_id: { type: 'string' },
    tool_calls: { type: 'array', items: TOOL_CALL_SCHEMA },
  },
};

const USAGE_SCHEMA: Json = {
  type: 'object',
  properties: {
    prompt_tokens: { type: 'integer' },
    completion_tokens: { type: 'integer' },
    total_tokens: { type: 'integer' },
  },
};

const AGENT_EVENT_SCHEMA: Json = {
  type: 'object',
  description: 'One Server-Sent Event frame: a JSON payload under a named `event`.',
  required: ['type', 'data'],
  properties: {
    type: {
      type: 'string',
      enum: ['run.start', 'delta', 'tool.call', 'tool.result', 'run.end', 'error'],
    },
    data: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        sessionId: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        text: { type: 'string', description: 'Incremental text, on `delta`.' },
        id: { type: 'string' },
        name: { type: 'string' },
        args: { type: 'object', additionalProperties: true },
        danger: { type: 'string', enum: ['safe', 'caution', 'dangerous'] },
        ok: { type: 'boolean' },
        content: { type: 'string' },
        error: { type: 'string' },
        durationMs: { type: 'number' },
        output: { type: 'string', description: 'Final answer, on `run.end`.' },
        usage: USAGE_SCHEMA,
        rounds: { type: 'integer' },
        toolCalls: { type: 'integer', description: 'Number of tool calls made.' },
        message: { type: 'string', description: 'On `error`.' },
        code: { type: 'string' },
      },
    },
  },
};

const SESSION_SCHEMA: Json = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    createdAt: { type: 'integer', description: 'Epoch milliseconds.' },
    updatedAt: { type: 'integer' },
    metadata: { type: 'object', additionalProperties: true },
    messageCount: { type: 'integer' },
  },
};

const MESSAGE_SCHEMA: Json = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    sessionId: { type: 'string' },
    seq: { type: 'integer', description: 'Monotonic position within the session.' },
    role: { type: 'string', enum: ['system', 'user', 'assistant', 'tool'] },
    content: { type: ['string', 'null'] },
    name: { type: 'string' },
    toolCalls: { type: 'array', items: TOOL_CALL_SCHEMA },
    toolCallId: { type: 'string' },
    createdAt: { type: 'integer' },
  },
};

const RUN_SCHEMA: Json = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    sessionId: { type: 'string' },
    status: { type: 'string', enum: ['running', 'succeeded', 'failed', 'cancelled'] },
    provider: { type: 'string' },
    model: { type: 'string' },
    rounds: { type: 'integer' },
    toolCalls: { type: 'integer' },
    promptTokens: { type: 'integer' },
    completionTokens: { type: 'integer' },
    error: { type: 'string' },
    startedAt: { type: 'integer' },
    endedAt: { type: 'integer' },
  },
};

const MODEL_SCHEMA: Json = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Model name to pass as `model`.' },
    object: { type: 'string', const: 'model' },
    created: { type: 'integer' },
    owned_by: { type: 'string' },
    nami: {
      type: 'object',
      additionalProperties: true,
      description:
        'Non-standard additions: `aliasOf` when the id is an alias, plus size, parameters and quantization when the provider reports them.',
    },
  },
};

const TOOL_SCHEMA: Json = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    danger: { type: 'string', enum: ['safe', 'caution', 'dangerous'] },
    enabled: { type: 'boolean' },
    implemented: { type: 'boolean' },
    parameters: { type: 'object', additionalProperties: true, description: 'JSON Schema.' },
  },
};

function jsonResponse(description: string, schema: Json): Json {
  return { description, content: { 'application/json': { schema } } };
}

function errorResponse(description: string): Json {
  return { description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
}

const BEARER = [{ bearerAuth: [] }];

/** Builds the full OpenAPI document for this deployment. */
export function buildOpenApiDocument(deps: AppDeps): Json {
  const { config, provider, models } = deps;
  const defaultModel = models.defaultModel || '(none selected)';

  return {
    openapi: '3.1.0',
    info: {
      title: 'Nami Agent Server',
      version: config.version,
      summary: 'Self-hosted agent runtime with an OpenAI-compatible surface.',
      description: [
        'Nami hosts an agent loop (LLM + sandboxed tools + persisted sessions) and',
        'exposes it three ways:',
        '',
        '- **OpenAI-compatible** `POST /v1/chat/completions`, so any OpenAI client works by changing `base_url`.',
        '- **Native agent events** `POST /v1/agent/run`, which streams tool calls and results.',
        '- **WebSocket** `' + config.ws.path + '`, a bidirectional channel with the same event vocabulary.',
        '',
        `Current provider: \`${provider.id}\`. Default model: \`${defaultModel}\`.`,
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'This deployment' }],
    tags: [
      { name: 'Health', description: 'Unauthenticated liveness and readiness probes.' },
      { name: 'OpenAI', description: 'Drop-in compatible with the OpenAI API.' },
      { name: 'Agent', description: 'Native agent interface with full event detail.' },
      { name: 'Sessions', description: 'Persisted conversations, transcripts and run history.' },
      { name: 'OneBot', description: 'QQ bridging through SnowLuma or any OneBot v11 implementation.' },
      { name: 'Logs', description: 'Recent server logs and a live tail, as shown in the WebUI.' },
      { name: 'Admin', description: 'Operational endpoints backing the web panel.' },
      { name: 'Docs', description: 'This document and its human-readable rendering.' },
    ],
    security: BEARER,
    paths: {
      '/healthz': {
        get: {
          tags: ['Health'],
          summary: 'Liveness probe',
          description: 'No authentication. Returns 200 while the process is responsive.',
          security: [],
          responses: { '200': jsonResponse('Process is alive.', { type: 'object' }) },
        },
      },
      '/readyz': {
        get: {
          tags: ['Health'],
          summary: 'Readiness probe',
          description:
            'No authentication. Returns 503 when the database is unreachable, no model is usable, or no API key is configured.',
          security: [],
          responses: {
            '200': jsonResponse('Ready to serve.', { type: 'object' }),
            '503': jsonResponse('Not ready; see `checks`.', { type: 'object' }),
          },
        },
      },
      '/v1/models': {
        get: {
          tags: ['OpenAI'],
          summary: 'List selectable models',
          description:
            'Every model a client may pass as `model`, including alias names. Alias entries carry `nami.aliasOf`.',
          responses: {
            '200': jsonResponse('Model catalogue.', {
              type: 'object',
              properties: { object: { type: 'string', const: 'list' }, data: { type: 'array', items: { $ref: '#/components/schemas/Model' } } },
            }),
            '401': errorResponse('Missing or invalid API key.'),
          },
        },
      },
      '/v1/chat/completions': {
        post: {
          tags: ['OpenAI'],
          summary: 'Create a chat completion',
          description: [
            'Two modes, selected by whether the request carries `tools`:',
            '',
            '- **Proxy mode** (`tools` present): forwarded upstream, and any tool calls are returned to',
            '  the caller to execute — Nami cannot run tools it does not host.',
            '- **Agent mode** (no `tools`): the full server-side agent loop runs with the tools this',
            '  deployment has registered; the caller sees only the streamed answer.',
            '',
            'Set `stream: true` for SSE. Add `stream_options.include_usage` to receive a final chunk',
            'carrying token usage.',
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['messages'],
                  properties: {
                    model: {
                      type: 'string',
                      description: `Model to use. Defaults to \`${defaultModel}\`. Unknown or unexposed names are rejected.`,
                    },
                    messages: { type: 'array', items: { $ref: '#/components/schemas/ChatMessage' } },
                    stream: { type: 'boolean', default: false },
                    stream_options: {
                      type: 'object',
                      properties: { include_usage: { type: 'boolean' } },
                    },
                    temperature: { type: 'number' },
                    max_tokens: { type: 'integer' },
                    tools: {
                      type: 'array',
                      description: 'Supplying tools switches the request to proxy mode.',
                      items: { type: 'object', additionalProperties: true },
                    },
                    session_id: {
                      type: 'string',
                      description:
                        'Non-standard. Groups the turn into a persisted session; may also be sent as the `x-nami-session` header.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Completion, or an SSE stream of `chat.completion.chunk` frames ending in `[DONE]`.',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            '400': errorResponse('Malformed messages array.'),
            '401': errorResponse('Missing or invalid API key.'),
            '403': errorResponse('Model is not exposed by this server.'),
            '404': errorResponse('Model does not exist.'),
            '429': errorResponse('Rate limit exceeded.'),
          },
        },
      },
      '/v1/agent/run': {
        post: {
          tags: ['Agent'],
          summary: 'Run one agent turn',
          description:
            'The richest interface. With `stream: true` (the default) it emits named SSE events; with `stream: false` it drains the run and returns one JSON document.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['input'],
                  properties: {
                    input: { type: 'string', description: 'The user message.' },
                    sessionId: { type: 'string', description: 'Continue an existing session; omit to start one.' },
                    model: { type: 'string' },
                    system: { type: 'string', description: 'Overrides the configured system prompt.' },
                    stream: { type: 'boolean', default: true },
                    maxRounds: { type: 'integer', minimum: 1, maximum: 20 },
                    temperature: { type: 'number' },
                    maxTokens: { type: 'integer' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'SSE stream of `run.start`, `delta`, `tool.call`, `tool.result`, `run.end` and `error` events. With `stream: false`, a JSON document containing `output`, `toolCallDetails`, `usage`, `rounds` and `toolCalls` (a count).',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            '400': errorResponse('Missing or empty `input`.'),
            '401': errorResponse('Missing or invalid API key.'),
            '404': errorResponse('Model does not exist.'),
          },
        },
      },
      '/v1/sessions': {
        get: {
          tags: ['Sessions'],
          summary: 'List sessions',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: { '200': jsonResponse('Session list, newest first.', { type: 'object' }) },
        },
        post: {
          tags: ['Sessions'],
          summary: 'Create a session',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { title: { type: 'string' }, metadata: { type: 'object', additionalProperties: true } },
                },
              },
            },
          },
          responses: { '201': jsonResponse('Session created.', { $ref: '#/components/schemas/Session' }) },
        },
      },
      '/v1/sessions/{id}': {
        get: {
          tags: ['Sessions'],
          summary: 'Get a session with its transcript',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 500, maximum: 2000 } },
          ],
          responses: {
            '200': jsonResponse('Session, messages and memory.', { type: 'object' }),
            '404': errorResponse('Session not found.'),
          },
        },
        delete: {
          tags: ['Sessions'],
          summary: 'Delete a session',
          description: 'Also removes its messages, runs, tool invocations and memory.',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': jsonResponse('Session deleted.', { type: 'object' }),
            '404': errorResponse('Session not found.'),
          },
        },
      },
      '/v1/sessions/{id}/messages': {
        get: {
          tags: ['Sessions'],
          summary: 'Get a session transcript',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 500 } },
          ],
          responses: {
            '200': jsonResponse('Messages in chronological order.', {
              type: 'object',
              properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Message' } } },
            }),
            '404': errorResponse('Session not found.'),
          },
        },
      },
      '/v1/runs': {
        get: {
          tags: ['Sessions'],
          summary: 'List agent runs',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }],
          responses: { '200': jsonResponse('Runs, newest first.', { type: 'object' }) },
        },
      },
      '/v1/runs/{id}': {
        get: {
          tags: ['Sessions'],
          summary: 'Get a run with its tool invocations',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': jsonResponse('Run detail.', { type: 'object' }),
            '404': errorResponse('Run not found.'),
          },
        },
      },
      '/admin': {
        get: {
          tags: ['Admin'],
          summary: 'WebUI 控制台',
          description:
            'Vue + Vuetify 单页应用，构建产物提交在 `src/web/app`（因此运行无需安装、无需构建）。前端使用 hash 路由，所以任意 `/admin` 子路径都返回同一份外壳。该路径由服务器在路由分发之前直接处理，不经过 API 鉴权——页面本身不含数据，它调用的 `/admin/api/*` 才需要凭证。',
          security: [],
          responses: {
            '200': { description: 'HTML shell.', content: { 'text/html': { schema: { type: 'string' } } } },
          },
        },
      },
      '/admin/classic': {
        get: {
          tags: ['Admin'],
          summary: '经典单文件面板（逃生通道）',
          description:
            '不依赖前端构建的旧版面板。当 `src/web/app` 缺失时，`/admin` 也会自动回退到它。',
          security: [],
          responses: {
            '200': { description: 'HTML panel.', content: { 'text/html': { schema: { type: 'string' } } } },
          },
        },
      },
      '/onebot/event': {
        post: {
          tags: ['OneBot'],
          summary: 'Receive an OneBot v11 event report',
          description: [
            'Point your OneBot implementation (SnowLuma, NapCat, LLOneBot, Lagrange, ...) HTTP',
            'event reporting at this URL.',
            '',
            'Authentication is a shared secret, **not** an API key: send the value of',
            '`NAMI_ONEBOT_EVENT_TOKEN` as `Authorization: Bearer <token>`, `X-OneBot-Token`, or',
            '`?access_token=`. Inbound stays closed while that variable is unset, because an open',
            'report endpoint is an open model-billing trigger.',
            '',
            'The response is `204 No Content`, returned **before** the agent runs — reporters time',
            'out in seconds while a local model may take a minute. The reply is delivered',
            'asynchronously through the OneBot HTTP API.',
          ].join('\n'),
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  description: 'A standard OneBot v11 event object.',
                  properties: {
                    post_type: { type: 'string', description: '`message`, `notice`, `request` or `meta_event`.' },
                    message_type: { type: 'string', enum: ['private', 'group'] },
                    self_id: { type: 'integer' },
                    user_id: { type: 'integer' },
                    group_id: { type: 'integer' },
                    message_id: { type: 'integer' },
                    raw_message: { type: 'string' },
                    message: {
                      description: 'OneBot message: a CQ-code string or an array of segments.',
                      oneOf: [
                        { type: 'string' },
                        {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: { type: { type: 'string' }, data: { type: 'object', additionalProperties: true } },
                          },
                        },
                      ],
                    },
                    sender: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: {
            '204': { description: 'Accepted; the agent runs in the background.' },
            '401': errorResponse('Missing or invalid report token.'),
            '503': errorResponse('The OneBot connector or inbound bridge is disabled, or no report token is configured.'),
          },
        },
      },
      '/admin/api/onebot/status': {
        get: {
          tags: ['OneBot'],
          summary: 'OneBot connector status',
          description:
            'Configuration (tokens reported as booleans only), bridge counters, and a live probe of the OneBot implementation.',
          responses: { '200': jsonResponse('Connector status.', { type: 'object' }) },
        },
      },
      '/admin/api/onebot/event': {
        post: {
          tags: ['OneBot'],
          summary: 'Simulate an inbound event',
          description:
            'Runs the full inbound path synchronously and returns the outcome, so the bridge can be tested without a live QQ account. Requires admin credentials rather than the report token.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
          },
          responses: {
            '200': jsonResponse('Outcome: `handled`, `reason`, `sessionId`, `chunks`, `durationMs`.', { type: 'object' }),
            '502': errorResponse('The run failed.'),
          },
        },
      },
      '/admin/api/onebot/send': {
        post: {
          tags: ['OneBot'],
          summary: 'Send a QQ message manually',
          description: 'Diagnostic escape hatch. Bypasses the agent but not the OneBot connector switch.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['text'],
                  properties: {
                    text: { type: 'string' },
                    group_id: { type: 'string' },
                    user_id: { type: 'string' },
                    at: { type: 'string', description: 'Optional QQ id to @-mention.' },
                  },
                },
              },
            },
          },
          responses: {
            '200': jsonResponse('Sent; includes the OneBot `messageId`.', { type: 'object' }),
            '400': errorResponse('Missing text or target.'),
            '503': errorResponse('The OneBot connector is disabled.'),
          },
        },
      },
      '/admin/api/logs': {
        get: {
          tags: ['Logs'],
          summary: 'Recent log entries',
          description:
            'Reads the in-memory ring buffer. Credentials are redacted on the way in, so they cannot appear here.',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 1000 } },
            {
              name: 'level',
              in: 'query',
              schema: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
              description: 'Only return entries at or above this level. Defaults to the capture level.',
            },
          ],
          responses: {
            '200': jsonResponse('Entries plus buffer metadata.', { type: 'object' }),
            '400': errorResponse('Unknown level.'),
          },
        },
        delete: {
          tags: ['Logs'],
          summary: 'Clear the log buffer',
          responses: { '200': jsonResponse('How many entries were cleared.', { type: 'object' }) },
        },
      },
      '/admin/api/logs/stream': {
        get: {
          tags: ['Logs'],
          summary: 'Live log tail (SSE)',
          description: [
            'Server-Sent Events stream of `log` events. Each frame carries the entry as JSON and',
            'its `seq` as the SSE event id, so a reconnecting `EventSource` resumes via',
            '`Last-Event-ID` (or `?since=`) without gaps or duplicates.',
          ].join('\n'),
          parameters: [
            {
              name: 'level',
              in: 'query',
              schema: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
            },
            {
              name: 'since',
              in: 'query',
              schema: { type: 'integer' },
              description: 'Resume after this sequence number.',
            },
          ],
          responses: { '200': { description: 'SSE stream.', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
        },
      },
      '/admin/api/overview': {
        get: {
          tags: ['Admin'],
          summary: 'Server overview',
          description: 'Requires the admin token, or any valid API key when no admin token is configured.',
          responses: { '200': jsonResponse('Version, provider, models, tools, limits.', { type: 'object' }) },
        },
      },
      '/admin/api/models': {
        get: {
          tags: ['Admin'],
          summary: 'Model catalogue with routing detail',
          parameters: [{ name: 'refresh', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Force a re-probe.' }],
          responses: { '200': jsonResponse('Discovered models, aliases and exposure.', { type: 'object' }) },
        },
      },
      '/admin/api/stats': {
        get: {
          tags: ['Admin'],
          summary: 'Stored record counts and tool usage',
          responses: { '200': jsonResponse('Counts, recent runs, per-tool statistics.', { type: 'object' }) },
        },
      },
      '/admin/api/metrics': {
        get: {
          tags: ['Admin'],
          summary: 'Process counters',
          responses: { '200': jsonResponse('Requests, agent, WebSocket and transfer counters.', { type: 'object' }) },
        },
      },
      '/admin/api/tools': {
        get: {
          tags: ['Admin'],
          summary: 'Registered tools',
          responses: { '200': jsonResponse('Tool list including disabled ones.', { type: 'object' }) },
        },
      },
      '/admin/api/runs': {
        get: {
          tags: ['Admin'],
          summary: 'Recent runs',
          responses: { '200': jsonResponse('Run list.', { type: 'object' }) },
        },
      },
      '/admin/api/runs/{id}': {
        get: {
          tags: ['Admin'],
          summary: 'Run detail with tool invocations',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': jsonResponse('Run detail.', { type: 'object' }) },
        },
      },
      '/admin/api/sessions': {
        get: {
          tags: ['Admin'],
          summary: 'List sessions',
          responses: { '200': jsonResponse('Session list.', { type: 'object' }) },
        },
      },
      '/admin/api/sessions/{id}': {
        get: {
          tags: ['Admin'],
          summary: 'Get a session with transcript and memory',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': jsonResponse('Session detail.', { type: 'object' }) },
        },
        put: {
          tags: ['Admin'],
          summary: 'Rename a session',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } },
          },
          responses: { '200': jsonResponse('Updated session.', { type: 'object' }) },
        },
        delete: {
          tags: ['Admin'],
          summary: 'Delete a session',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': jsonResponse('Deleted.', { type: 'object' }) },
        },
      },
      '/admin/api/config': {
        get: {
          tags: ['Admin'],
          summary: '生效中的配置（密钥已脱敏）',
          description: '只读快照。要编辑请用 `GET /admin/api/config/schema` 取字段描述，再 `PUT` 写回。',
          responses: { '200': jsonResponse('Configuration with keys replaced by booleans.', { type: 'object' }) },
        },
        put: {
          tags: ['Admin'],
          summary: '写入配置到 .env',
          description: [
            '写入 `.env`，保留注释与无关配置，可重复执行。三条硬性约束：',
            '',
            '- 必须携带 `confirm: true`，避免误写的请求体悄悄改掉运行环境；',
            '- 只允许写 `NAMI_*` 键；',
            '- 值按字段类型校验，**任一非法则整体拒绝**，不会部分写入。',
            '',
            '**不做热重载**：所有字段都标记为 `restartRequired`，必须重启 Nami 才生效。',
            '密钥的新值在响应里以 `***` 回显——接口永远不会把密钥原文吐出来，也永远读不回它。',
          ].join('\n'),
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['changes', 'confirm'],
                  properties: {
                    changes: {
                      type: 'object',
                      additionalProperties: { type: ['string', 'number', 'boolean'] },
                      description: '键为 NAMI_* 环境变量名，值为新值（列表用逗号分隔）。',
                    },
                    confirm: { type: 'boolean', const: true, description: '显式确认。' },
                  },
                },
              },
            },
          },
          responses: {
            '200': jsonResponse('写入结果与被改动的键（密钥值以 *** 代替）。', { type: 'object' }),
            '400': errorResponse('缺少确认、键非法或值未通过校验（此时不会写入任何内容）。'),
            '500': errorResponse('.env 不可写。'),
          },
        },
      },
      '/admin/api/config/schema': {
        get: {
          tags: ['Admin'],
          summary: '可编辑配置项的完整描述',
          description:
            '每一项的类型、分组、说明、可选值与当前生效值，外加 `.env` 文件路径与可写性。密钥类配置项的值恒为 `null`，只给出 `configured` 布尔。',
          responses: { '200': jsonResponse('字段列表与 .env 文件信息。', { type: 'object' }) },
        },
      },
      '/admin/api/routes': {
        get: {
          tags: ['Admin'],
          summary: 'Registered routes',
          responses: { '200': jsonResponse('Method and pattern for every route.', { type: 'object' }) },
        },
      },
      '/openapi.json': {
        get: {
          tags: ['Docs'],
          summary: 'This document',
          security: [],
          responses: { '200': jsonResponse('OpenAPI 3.1 document.', { type: 'object' }) },
        },
      },
      '/docs': {
        get: {
          tags: ['Docs'],
          summary: 'Human-readable API reference',
          security: [],
          responses: { '200': { description: 'HTML reference.', content: { 'text/html': { schema: { type: 'string' } } } } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An API key from `NAMI_API_KEYS`. Admin endpoints additionally accept `X-Admin-Token`. The WebSocket endpoint also accepts `?key=` because browsers cannot set headers on a WebSocket handshake.',
        },
      },
      schemas: {
        Error: ERROR_SCHEMA,
        Model: MODEL_SCHEMA,
        ChatMessage: CHAT_MESSAGE_SCHEMA,
        ToolCall: TOOL_CALL_SCHEMA,
        Tool: TOOL_SCHEMA,
        Usage: USAGE_SCHEMA,
        AgentEvent: AGENT_EVENT_SCHEMA,
        Session: SESSION_SCHEMA,
        Message: MESSAGE_SCHEMA,
        Run: RUN_SCHEMA,
      },
    },
  };
}

/** Endpoint inventory used by the drift test and the docs page. */
export function listDocumentedRoutes(document: Json): string[] {
  const paths = (document.paths ?? {}) as Record<string, Record<string, unknown>>;
  const out: string[] = [];
  for (const [path, operations] of Object.entries(paths)) {
    for (const method of Object.keys(operations)) {
      out.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}
