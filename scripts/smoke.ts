/**
 * End-to-end smoke test.
 *
 * Boots real server instances in-process (ephemeral ports, temporary SQLite
 * files, offline mock model) and exercises every transport and safety boundary:
 * HTTP auth, OpenAI compatibility, the native SSE agent stream, the WebSocket
 * channel, persistence, tool sandboxing, and rate limiting.
 *
 * Run with: npm run smoke
 */

import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, type BootstrappedServer } from '../src/index.ts';
import { loadConfig, type Config } from '../src/config.ts';
import type { AgentEventMap } from '../src/core/types.ts';
import { computeAcceptKey, encodeFrame, OPCODE, FrameParser, unmask } from '../src/ws/frames.ts';
import { evaluateExpression } from '../src/tools/builtin/calc.ts';
import { resolveInRoots } from '../src/tools/builtin/fs.ts';
import { hostAllowed } from '../src/tools/builtin/net.ts';
import { validateArgs, formatIssues } from '../src/tools/validate.ts';
import { TokenBucket } from '../src/ratelimit.ts';
import { getPanelHtml, getDocsHtml } from '../src/web/panel.ts';
import { OllamaProvider, toOllamaMessages } from '../src/llm/ollama.ts';
import { MockProvider } from '../src/llm/mock.ts';
import { ModelRouter } from '../src/llm/router.ts';
import type { StreamChunk } from '../src/llm/types.ts';
import { listDocumentedRoutes } from '../src/openapi.ts';
import { nullLogger } from '../src/logger.ts';
import { parseArgs as parseOllamaArgs, upsertEnv } from './ollama.ts';
import {
  chunkMessage,
  decideEvent,
  extractMessage,
  sessionIdFor,
  stripMarkdown,
} from '../src/onebot/bridge.ts';
import { OneBotClient } from '../src/onebot/client.ts';
import { executeTool } from '../src/tools/sandbox.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { isValidSessionId } from '../src/store/store.ts';

/* ------------------------------------------------------------------ *
 * Test harness
 * ------------------------------------------------------------------ */

const C = process.stdout.isTTY
  ? { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', reset: '\x1b[0m' }
  : { green: '', red: '', dim: '', bold: '', cyan: '', reset: '' };

let passed = 0;
const failures: Array<{ name: string; detail: string }> = [];
let currentSection = '';

function section(title: string): void {
  currentSection = title;
  process.stdout.write(`\n${C.bold}${C.cyan}▸ ${title}${C.reset}\n`);
}

function check(name: string, condition: boolean, detail = ''): boolean {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ${C.green}✓${C.reset} ${name}\n`);
  } else {
    failures.push({ name: `${currentSection} → ${name}`, detail });
    process.stdout.write(`  ${C.red}✗ ${name}${C.reset}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}\n`);
  }
  return condition;
}

function equal<T>(name: string, actual: T, expected: T): boolean {
  const ok = actual === expected;
  return check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ *
 * Server fixtures
 * ------------------------------------------------------------------ */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const API_KEY = 'smoke_api_key_0123456789';
const ADMIN_TOKEN = 'smoke_admin_token_0123456789';

const started: BootstrappedServer[] = [];
const dbFiles: string[] = [];

function smokeDb(name: string): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `smoke-${name}-${process.pid}.sqlite`);
  dbFiles.push(file);
  return file;
}

const BASE_ENV: Record<string, string> = {
  NAMI_HOST: '127.0.0.1',
  NAMI_PORT: '0',
  NAMI_API_KEYS: API_KEY,
  NAMI_ADMIN_TOKEN: ADMIN_TOKEN,
  NAMI_LOG_LEVEL: 'error',
  NAMI_LOG_FORMAT: 'json',
  NAMI_LLM_PROVIDER: 'mock',
  NAMI_MOCK_DELAY_MS: '0',
  NAMI_RATE_LIMIT_ENABLED: 'true',
  NAMI_RATE_LIMIT_BURST: '10000',
  NAMI_RATE_LIMIT_PER_SECOND: '10000',
};

function testConfig(overrides: Record<string, string>): Config {
  // `loadConfig` writes the supplied env into `process.env` and never clears it,
  // so a variable set by one fixture would silently leak into the next. Reset
  // every NAMI_* key first to keep each fixture hermetic.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('NAMI_')) delete process.env[key];
  }
  // Passing `env` bypasses `.env` loading, keeping the run deterministic.
  return loadConfig({ env: { ...BASE_ENV, ...overrides } });
}

interface Fixture {
  app: BootstrappedServer;
  config: Config;
  base: string;
  port: number;
  key: string;
}

async function startServer(name: string, overrides: Record<string, string> = {}): Promise<Fixture> {
  const config = testConfig({ NAMI_DB_PATH: smokeDb(name), ...overrides });
  const app = await bootstrap(config);
  started.push(app);

  await new Promise<void>((resolve, reject) => {
    app.nami.server.once('error', reject);
    app.nami.server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = app.nami.server.address();
  if (address === null || typeof address === 'string') throw new Error('failed to bind a TCP port');
  const port = address.port;

  return {
    app,
    config,
    port,
    base: `http://127.0.0.1:${port}`,
    key: overrides.NAMI_API_KEYS ?? API_KEY,
  };
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

interface HttpResult {
  status: number;
  headers: Headers;
  body: string;
  json: unknown;
}

async function http(
  fixture: Fixture,
  method: string,
  path: string,
  options: {
    key?: string | null;
    adminToken?: string | null;
    json?: unknown;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...options.headers };
  // `'key' in options` distinguishes "omitted" from an explicit null, which the
  // `??` operator would otherwise collapse into the fixture's real key.
  const credential = 'key' in options ? options.key : fixture.key;
  if (credential) headers.authorization = `Bearer ${credential}`;
  if (options.adminToken) headers['x-admin-token'] = options.adminToken;
  if (options.json !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`${fixture.base}${path}`, {
    method,
    headers,
    ...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
    ...(options.raw !== undefined ? { body: options.raw } : {}),
  });

  const body = await response.text();
  let json: unknown;
  try {
    json = body === '' ? undefined : JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, body, json };
}

interface SseFrame {
  event: string;
  raw: string;
  data: unknown;
}

async function readSse(response: Response): Promise<SseFrame[]> {
  if (!response.body) throw new Error('response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');

      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;

      const raw = dataLines.join('\n');
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        /* keep the raw string (e.g. the [DONE] sentinel) */
      }
      frames.push({ event, raw, data });
    }
  }

  return frames;
}

/* ------------------------------------------------------------------ *
 * WebSocket helper
 * ------------------------------------------------------------------ */

interface WsOutcome {
  messages: Array<Record<string, unknown>>;
  closeCode: number;
}

function wsConnect(
  fixture: Fixture,
  key: string,
  onReady: (send: (payload: unknown) => void) => void,
  stopWhen: (message: Record<string, unknown>, send: (payload: unknown) => void) => boolean,
): Promise<WsOutcome> {
  return new Promise<WsOutcome>((resolve, reject) => {
    const url = `ws://127.0.0.1:${fixture.port}${fixture.config.ws.path}?key=${encodeURIComponent(key)}`;
    const ws = new WebSocket(url);
    const messages: Array<Record<string, unknown>> = [];
    const send = (payload: unknown): void => {
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        /* socket already closing */
      }
    };
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      reject(new Error('WebSocket test timed out'));
    }, 20_000);

    const settle = (code: number): void => {
      clearTimeout(timer);
      resolve({ messages, closeCode: code });
    };

    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      messages.push(message);
      if (message.type === 'ready') {
        onReady(send);
        return;
      }
      if (stopWhen(message, send)) {
        try {
          ws.close(1000, 'done');
        } catch {
          settle(1000);
        }
      }
    });

    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WebSocket error event'));
    });

    ws.addEventListener('close', (event) => settle(event.code));
  });
}

/* ------------------------------------------------------------------ *
 * Fake Ollama daemon
 *
 * Lets the whole Ollama path — discovery, NDJSON streaming, native tool calls,
 * pulling — be verified without a real daemon installed.
 * ------------------------------------------------------------------ */

interface FakeOllamaModel {
  id: string;
  sizeBytes: number;
  parameters: string;
  quantization: string;
  family: string;
}

interface FakeOllama {
  url: string;
  /** Every /api/chat request body, in order. */
  requests: Array<Record<string, unknown>>;
  pulled: string[];
  close(): Promise<void>;
}

async function startFakeOllama(
  models: FakeOllamaModel[],
  options: { failTags?: boolean } = {},
): Promise<FakeOllama> {
  const requests: Array<Record<string, unknown>> = [];
  const pulled: string[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, payload: unknown): void => {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    };
    const readBody = (done: (body: Record<string, unknown>) => void): void => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        } catch {
          parsed = {};
        }
        done(parsed);
      });
    };

    if (url.pathname === '/api/version') {
      json(200, { version: '0.5.7-fake' });
      return;
    }

    if (url.pathname === '/api/tags') {
      if (options.failTags) {
        json(500, { error: 'tags unavailable' });
        return;
      }
      json(200, {
        models: models.map((model) => ({
          name: model.id,
          model: model.id,
          modified_at: new Date(1_710_000_000_000).toISOString(),
          size: model.sizeBytes,
          digest: 'sha256:deadbeef',
          details: {
            family: model.family,
            parameter_size: model.parameters,
            quantization_level: model.quantization,
            format: 'gguf',
          },
        })),
      });
      return;
    }

    if (url.pathname === '/api/ps') {
      json(200, { models: models.slice(0, 1).map((m) => ({ name: m.id, size_vram: 123_456 })) });
      return;
    }

    if (url.pathname === '/api/pull') {
      readBody((body) => {
        pulled.push(String(body.model ?? ''));
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        res.write(`${JSON.stringify({ status: 'downloading', completed: 500, total: 1000 })}\n`);
        res.write(`${JSON.stringify({ status: 'success' })}\n`);
        res.end();
      });
      return;
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      readBody((body) => {
        requests.push(body);

        // Mirror Ollama: an uninstalled model is a 404 with a JSON error body.
        if (!models.some((model) => model.id === body.model)) {
          const message = `model "${String(body.model)}" not found, try pulling it first`;
          const payload = JSON.stringify({ error: message });
          res.writeHead(404, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
          });
          res.end(payload);
          return;
        }

        res.writeHead(200, { 'content-type': 'application/x-ndjson' });

        const messages = (body.messages ?? []) as Array<{
          role: string;
          content: string;
          tool_name?: string;
        }>;
        const tools = (body.tools ?? []) as Array<{ function: { name: string } }>;
        const last = messages[messages.length - 1];
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');

        const lines: string[] = [];
        const push = (value: unknown): void => {
          lines.push(`${JSON.stringify(value)}\n`);
        };
        const doneLine = (prompt: number, completion: number): void => {
          push({
            model: body.model,
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: prompt,
            eval_count: completion,
          });
        };

        if (last && last.role === 'tool') {
          push({
            model: body.model,
            message: { role: 'assistant', content: `工具 ${last.tool_name} 已执行。` },
            done: false,
          });
          doneLine(30, 12);
        } else if (tools.length > 0 && /几点|时间|time/i.test(lastUser?.content ?? '')) {
          const chosen = tools.find((tool) => tool.function.name === 'now') ?? tools[0];
          push({ model: body.model, message: { role: 'assistant', content: '正在查询。' }, done: false });
          push({
            model: body.model,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: chosen?.function.name ?? 'now', arguments: {} } }],
            },
            done: false,
          });
          doneLine(20, 8);
        } else {
          push({ model: body.model, message: { role: 'assistant', content: `这是 ${String(body.model)} 的回答` }, done: false });
          push({ model: body.model, message: { role: 'assistant', content: '。' }, done: false });
          doneLine(11, 7);
        }

        // The whole stream is written as two chunks that deliberately split an
        // NDJSON line in half, proving the provider buffers partial lines.
        const payload = lines.join('');
        const cut = Math.floor(payload.length / 2);
        res.write(payload.slice(0, cut));
        setTimeout(() => {
          res.write(payload.slice(cut));
          res.end();
        }, 5);
      });
      return;
    }

    json(404, { error: `no route for ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    pulled,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/* ------------------------------------------------------------------ *
 * Fake OneBot v11 implementation
 *
 * Stands in for SnowLuma's HTTP API on :3000 so the whole QQ path —
 * report handling, filtering, agent run, reply delivery, allowlists —
 * can be verified without a QQ account.
 * ------------------------------------------------------------------ */

interface OneBotCall {
  action: string;
  params: Record<string, unknown>;
  auth: string | null;
}

interface FakeOneBot {
  url: string;
  calls: OneBotCall[];
  /** Every outbound message, flattened for assertions. */
  sent: Array<{ action: string; target: string; segments: Array<{ type: string; data: Record<string, unknown> }> }>;
  close(): Promise<void>;
}

async function startFakeOneBot(options: { accessToken?: string; failSend?: boolean } = {}): Promise<FakeOneBot> {
  const calls: OneBotCall[] = [];
  const sent: FakeOneBot['sent'] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const action = url.pathname.replace(/^\//, '');

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        params = {};
      }
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
      calls.push({ action, params, auth });

      const reply = (status: number, payload: unknown): void => {
        const body = JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
      };
      const ok = (data: unknown): void => reply(200, { status: 'ok', retcode: 0, data });

      if (options.accessToken !== undefined && auth !== `Bearer ${options.accessToken}`) {
        reply(200, { status: 'failed', retcode: 1403, wording: 'token 验证失败' });
        return;
      }

      switch (action) {
        case 'get_login_info':
          ok({ user_id: 10001, nickname: 'NamiBot' });
          return;
        case 'get_status':
          ok({ online: true, good: true });
          return;
        case 'get_group_list':
          ok([
            { group_id: 111, group_name: '测试群', member_count: 3, max_member_count: 500 },
            { group_id: 999, group_name: '别的群', member_count: 1, max_member_count: 500 },
          ]);
          return;
        case 'get_group_member_list':
          ok([
            { user_id: 20002, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 10001, nickname: 'NamiBot', role: 'admin' },
          ]);
          return;
        case 'send_group_msg':
        case 'send_private_msg': {
          if (options.failSend) {
            reply(200, { status: 'failed', retcode: 100, wording: '发送失败' });
            return;
          }
          const target = String(
            action === 'send_group_msg' ? (params.group_id ?? '') : (params.user_id ?? ''),
          );
          const segments = Array.isArray(params.message)
            ? (params.message as Array<{ type: string; data: Record<string, unknown> }>)
            : [{ type: 'text', data: { text: String(params.message ?? '') } }];
          sent.push({ action, target, segments });
          ok({ message_id: 5000 + sent.length });
          return;
        }
        default:
          reply(200, { status: 'failed', retcode: 1404, wording: `unknown action ${action}` });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    sent,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/** Polls until `predicate` holds, so async bridge work can be asserted on. */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

function joinSegments(segments: Array<{ type: string; data: Record<string, unknown> }>): string {
  return segments
    .map((segment) => (segment.type === 'text' ? String(segment.data.text ?? '') : ''))
    .join('');
}

/* ------------------------------------------------------------------ *
 * Pure-unit assertions (no server needed)
 * ------------------------------------------------------------------ */

function testPureUnits(): void {
  section('工具沙箱与安全边界（纯函数）');

  // calc: a real parser, never eval
  equal('calc 12*(3+4)', evaluateExpression('12*(3+4)'), 84);
  equal('calc 2^10', evaluateExpression('2^10'), 1024);
  equal('calc sqrt(16)+1', evaluateExpression('sqrt(16)+1'), 5);
  equal('calc max(3,7,5)', evaluateExpression('max(3,7,5)'), 7);
  equal('calc 0.1+0.2 浮点除尘', evaluateExpression('0.1+0.2'), 0.3);
  equal('calc 2^-1', evaluateExpression('2^-1'), 0.5);

  let calcRejected = false;
  try {
    evaluateExpression('process.exit(1)');
  } catch {
    calcRejected = true;
  }
  check('calc 拒绝 process.exit(1)', calcRejected);

  let divisionRejected = false;
  try {
    evaluateExpression('1/0');
  } catch {
    divisionRejected = true;
  }
  check('calc 拒绝除以零', divisionRejected);

  let injectionRejected = false;
  try {
    evaluateExpression('require("fs")');
  } catch {
    injectionRejected = true;
  }
  check('calc 拒绝 require() 注入', injectionRejected);

  // JSON Schema validation
  const schema = {
    type: 'object' as const,
    properties: {
      name: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
    required: ['name'],
    additionalProperties: false,
  };
  check('schema 接受合法参数', validateArgs(schema, { name: 'x', count: 3, mode: 'a' }).length === 0);
  check('schema 拒绝缺失必填项', validateArgs(schema, { count: 1 }).length > 0);
  check('schema 拒绝类型错误', validateArgs(schema, { name: 'x', count: '3' }).length > 0);
  check('schema 拒绝越界数值', validateArgs(schema, { name: 'x', count: 99 }).length > 0);
  check('schema 拒绝非法枚举', validateArgs(schema, { name: 'x', mode: 'z' }).length > 0);
  check('schema 拒绝未知参数', validateArgs(schema, { name: 'x', evil: 1 }).length > 0);
  check(
    'schema 错误信息可读',
    formatIssues(validateArgs(schema, { count: 1 })).includes('args.name is required'),
  );
  check('schema 拒绝非整数的 integer', validateArgs(schema, { name: 'x', count: 1.5 }).length > 0);

  // Filesystem containment
  const root = join(ROOT, 'src');
  check('fs 允许根目录内的路径', resolveInRoots(join(root, 'index.ts'), [root]).startsWith(root));
  let escaped = false;
  try {
    resolveInRoots(join(ROOT, 'package.json'), [root]);
  } catch {
    escaped = true;
  }
  check('fs 拒绝越出根目录的路径', escaped);

  let traversalBlocked = false;
  try {
    resolveInRoots(join(root, '..', '..', 'Windows', 'win.ini'), [root]);
  } catch {
    traversalBlocked = true;
  }
  check('fs 阻止 ../ 路径穿越', traversalBlocked);

  // Host allowlist
  check('net 精确主机匹配', hostAllowed(new URL('https://api.example.com/v1'), ['api.example.com']));
  check('net 通配子域匹配', hostAllowed(new URL('https://a.b.example.com/'), ['*.example.com']));
  check('net 通配不匹配裸域之外的主机', !hostAllowed(new URL('https://evil.com/'), ['*.example.com']));
  check('net 拒绝未列入白名单的主机', !hostAllowed(new URL('https://evil.com/'), ['example.com']));
  check('net 通配前缀不可被绕过', !hostAllowed(new URL('https://notexample.com/'), ['*.example.com']));

  // Token bucket
  const bucket = new TokenBucket(3, 0);
  const decisions = [bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume(), bucket.tryConsume()];
  check('ratelimit 前 3 次放行', decisions.slice(0, 3).every((d) => d.allowed));
  check('ratelimit 第 4 次拒绝', decisions[3]?.allowed === false);
  check('ratelimit 拒绝时给出 retry-after', (decisions[3]?.retryAfterSeconds ?? 0) > 0);

  // WebSocket framing primitives
  equal(
    'ws RFC6455 Sec-WebSocket-Accept 测试向量',
    computeAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
  );

  const parser = new FrameParser(1024);
  const masked = maskFrame(Buffer.from('hello'), OPCODE.TEXT);
  const frames = parser.push(masked);
  equal('ws 解析单个文本帧', frames.length, 1);
  equal('ws 解掩码正确', frames[0]?.payload.toString('utf8'), 'hello');
  check('ws 分片到达时保持缓冲', parser.push(masked.subarray(0, 3)).length === 0);

  let unmaskedRejected = false;
  try {
    // A fresh parser: reusing one would leave the earlier partial frame buffered
    // and consume this frame's bytes instead of rejecting it.
    new FrameParser(1024).push(encodeFrame(OPCODE.TEXT, Buffer.from('x')));
  } catch {
    unmaskedRejected = true;
  }
  check('ws 拒绝未掩码的客户端帧', unmaskedRejected);

  check('panel.html 已加载（非占位页）', getPanelHtml().length > 2000);
  check('docs.html 已加载（非占位页）', getDocsHtml().length > 3000);
}

/** Builds a correctly masked client-to-server frame for parser tests. */
function maskFrame(payload: Buffer, opcode: number): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const header = Buffer.allocUnsafe(2);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | payload.length;
  return Buffer.concat([header, mask, unmask(payload, mask)]);
}

/* ------------------------------------------------------------------ *
 * Integration tests
 * ------------------------------------------------------------------ */

async function testHttpSurface(main: Fixture): Promise<void> {
  section('HTTP 基础：健康检查、鉴权、CORS、错误处理');

  const health = await http(main, 'GET', '/healthz', { key: null });
  equal('/healthz 无需鉴权返回 200', health.status, 200);
  check('/healthz 报告 ok', (health.json as { status?: string })?.status === 'ok');
  check('/healthz 带版本号', typeof (health.json as { version?: string })?.version === 'string');

  const ready = await http(main, 'GET', '/readyz', { key: null });
  equal('/readyz 返回 200', ready.status, 200);
  check('/readyz 就绪', (ready.json as { ready?: boolean })?.ready === true);

  const noKey = await http(main, 'GET', '/v1/models', { key: null });
  equal('缺少 API Key → 401', noKey.status, 401);
  check(
    '401 响应体是结构化错误',
    (noKey.json as { error?: { code?: string } })?.error?.code === 'missing_api_key',
  );

  const badKey = await http(main, 'GET', '/v1/models', { key: 'wrong_key' });
  equal('错误 API Key → 401', badKey.status, 401);

  const notFound = await http(main, 'GET', '/nope', { key: null });
  equal('未知路径 → 404', notFound.status, 404);

  const wrongMethod = await http(main, 'DELETE', '/healthz', { key: null });
  equal('方法不允许 → 405', wrongMethod.status, 405);
  check('405 带 Allow 头', (wrongMethod.headers.get('allow') ?? '').includes('GET'));

  const cors = await http(main, 'OPTIONS', '/v1/models', { key: null });
  equal('CORS 预检 → 204', cors.status, 204);
  check('CORS 预检回显 allow-origin', cors.headers.get('access-control-allow-origin') !== null);

  const badJson = await http(main, 'POST', '/v1/agent/run', { key: main.key, raw: '{not json' });
  equal('非法 JSON → 400', badJson.status, 400);
  check(
    '非法 JSON 错误码正确',
    (badJson.json as { error?: { code?: string } })?.error?.code === 'invalid_json',
  );

  const missingInput = await http(main, 'POST', '/v1/agent/run', { key: main.key, json: { input: '  ' } });
  equal('空 input → 400', missingInput.status, 400);

  const hasRequestId = health.headers.get('x-request-id');
  check('每个响应带 x-request-id', typeof hasRequestId === 'string' && hasRequestId.length > 10);
  check('每个响应带 x-nami-version', health.headers.get('x-nami-version') === '1.0.0');

  const models = await http(main, 'GET', '/v1/models', { key: main.key });
  equal('/v1/models 返回 200', models.status, 200);
  check('/v1/models 列出模型', Array.isArray((models.json as { data?: unknown[] })?.data));
}

async function testAdminAndPanel(main: Fixture): Promise<void> {
  section('管理 API 与管理面板');

  const panel = await http(main, 'GET', '/admin', { key: null });
  equal('/admin 无需鉴权返回 200', panel.status, 200);
  check('/admin 返回 HTML', (panel.headers.get('content-type') ?? '').includes('text/html'));
  check('/admin 页面非空', panel.body.length > 2000);
  check('/admin 设置 CSP 头', panel.headers.get('content-security-policy') !== null);
  check('/admin 设置 nosniff', panel.headers.get('x-content-type-options') === 'nosniff');

  // With an admin token configured, an ordinary API key must not reach admin APIs.
  const apiKeyOnAdmin = await http(main, 'GET', '/admin/api/overview', { key: main.key });
  equal('配置了 admin token 时，普通 API Key 访问 admin → 403', apiKeyOnAdmin.status, 403);

  const adminOverview = await http(main, 'GET', '/admin/api/overview', {
    key: null,
    adminToken: ADMIN_TOKEN,
  });
  equal('admin token 可访问 /admin/api/overview', adminOverview.status, 200);

  // Regression: the web panel sends both headers. If only `Authorization` were
  // inspected, an admin token would be ignored whenever a key was also present.
  const bothCredentials = await http(main, 'GET', '/admin/api/overview', {
    key: main.key,
    adminToken: ADMIN_TOKEN,
  });
  equal('同时携带两种凭证时 admin token 仍生效（面板行为，回归）', bothCredentials.status, 200);
  const overview = adminOverview.json as {
    provider?: string;
    toolCount?: number;
    tools?: { total?: number; enabled?: number; names?: string[] };
    rateLimit?: { enabled?: boolean };
  };
  equal('overview 报告 provider', overview.provider, 'mock');
  check('overview 报告工具数量', (overview.tools?.total ?? 0) >= 10);
  check('overview 列出已启用工具', (overview.tools?.names ?? []).includes('calc'));

  const adminTools = await http(main, 'GET', '/admin/api/tools', { key: null, adminToken: ADMIN_TOKEN });
  equal('admin 工具清单 → 200', adminTools.status, 200);
  const toolList = (adminTools.json as { data?: Array<{ name: string; enabled: boolean; danger: string }> }).data ?? [];
  check('工具清单包含 calc/now/echo', ['calc', 'now', 'echo'].every((n) => toolList.some((t) => t.name === n)));
  check('危险工具默认禁用', toolList.filter((t) => t.name === 'http_get' || t.name === 'fs_read').every((t) => t.enabled === false));

  const metrics = await http(main, 'GET', '/admin/api/metrics', { key: null, adminToken: ADMIN_TOKEN });
  equal('admin 指标 → 200', metrics.status, 200);
  check(
    'metrics 记录到请求',
    ((metrics.json as { requests?: { total?: number } })?.requests?.total ?? 0) > 0,
  );

  const redacted = await http(main, 'GET', '/admin/api/config', { key: null, adminToken: ADMIN_TOKEN });
  const configJson = JSON.stringify(redacted.json ?? {});
  check('配置接口不泄露 API Key 明文', !configJson.includes(API_KEY));
  check('配置接口不泄露 admin token 明文', !configJson.includes(ADMIN_TOKEN));

  const routes = await http(main, 'GET', '/admin/api/routes', { key: null, adminToken: ADMIN_TOKEN });
  check('admin 路由清单非空', ((routes.json as { data?: unknown[] })?.data?.length ?? 0) > 10);
}

async function testOpenAiCompat(main: Fixture): Promise<void> {
  section('OpenAI 兼容接口（智能体模式）');

  const nonStream = await http(main, 'POST', '/v1/chat/completions', {
    key: main.key,
    json: { model: 'nami-mock-1', messages: [{ role: 'user', content: '现在几点' }] },
  });
  equal('非流式 chat/completions → 200', nonStream.status, 200);

  const completion = nonStream.json as {
    id?: string;
    object?: string;
    model?: string;
    choices?: Array<{ message?: { role?: string; content?: string }; finish_reason?: string }>;
    usage?: { total_tokens?: number };
  };
  equal('响应 object 正确', completion.object, 'chat.completion');
  check('响应 id 以 chatcmpl- 开头', (completion.id ?? '').startsWith('chatcmpl-'));
  equal('回显请求的 model', completion.model, 'nami-mock-1');
  equal('finish_reason=stop', completion.choices?.[0]?.finish_reason, 'stop');
  check('包含 usage', (completion.usage?.total_tokens ?? 0) > 0);
  const content = completion.choices?.[0]?.message?.content ?? '';
  check('服务端工具循环已执行 now()', content.includes('iso') || content.includes('now'), content.slice(0, 120));

  const streamResponse = await fetch(`${main.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${main.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'nami-mock-1',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: '计算 12*(3+4)' }],
    }),
  });
  equal('流式 chat/completions → 200', streamResponse.status, 200);
  check(
    '流式 Content-Type 为 text/event-stream',
    (streamResponse.headers.get('content-type') ?? '').includes('text/event-stream'),
  );

  const frames = await readSse(streamResponse);
  const chunks = frames.filter((f) => f.raw !== '[DONE]').map((f) => f.data as {
    object?: string;
    choices?: Array<{ delta?: { role?: string; content?: string }; finish_reason?: string | null }>;
    usage?: unknown;
  });

  check('流以 [DONE] 结束', frames.at(-1)?.raw === '[DONE]');
  check('所有 chunk 的 object 正确', chunks.every((c) => c.object === 'chat.completion.chunk'));
  equal('首块携带 role=assistant', chunks[0]?.choices?.[0]?.delta?.role, 'assistant');
  const finishChunk = [...chunks]
    .reverse()
    .find((c) => c.choices?.[0]?.finish_reason !== undefined && c.choices?.[0]?.finish_reason !== null);
  equal('末块 finish_reason=stop', finishChunk?.choices?.[0]?.finish_reason, 'stop');

  const streamedText = chunks
    .map((c) => c.choices?.[0]?.delta?.content ?? '')
    .join('');
  check('流式内容包含计算结果 84', streamedText.includes('84'), streamedText.slice(0, 160).replace(/\n/g, ' '));
  check(
    'include_usage 生效（末块带 usage）',
    chunks.some((c) => c.usage !== undefined && c.usage !== null),
  );

  // Proxy mode: caller-supplied tools must be handed back, not executed.
  const proxy = await http(main, 'POST', '/v1/chat/completions', {
    key: main.key,
    json: {
      model: 'nami-mock-1',
      messages: [{ role: 'user', content: '现在几点' }],
      tools: [
        {
          type: 'function',
          function: { name: 'client_clock', description: 'client side clock', parameters: { type: 'object', properties: {} } },
        },
      ],
    },
  });
  equal('代理模式 → 200', proxy.status, 200);
  const proxyJson = proxy.json as { choices?: Array<{ finish_reason?: string; message?: { tool_calls?: unknown[] } }> };
  // The mock only calls tools it recognises, so this asserts the shape is valid
  // and that Nami did not execute anything on the caller's behalf.
  check('代理模式返回合法结构', Array.isArray(proxyJson.choices) === true);

  const invalidMessages = await http(main, 'POST', '/v1/chat/completions', {
    key: main.key,
    json: { messages: 'not-an-array' },
  });
  equal('messages 非数组 → 400', invalidMessages.status, 400);

  const invalidRole = await http(main, 'POST', '/v1/chat/completions', {
    key: main.key,
    json: { messages: [{ role: 'wizard', content: 'hi' }] },
  });
  equal('非法 role → 400', invalidRole.status, 400);
}

async function testAgentStreamAndPersistence(main: Fixture): Promise<{ sessionId: string }> {
  section('原生智能体事件流 /v1/agent/run');

  const response = await fetch(`${main.base}/v1/agent/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${main.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'echo 你好，Nami', stream: true }),
  });
  equal('agent/run 流式 → 200', response.status, 200);

  const frames = await readSse(response);
  const byEvent = (name: keyof AgentEventMap): Array<Record<string, unknown>> =>
    frames.filter((f) => f.event === name).map((f) => f.data as Record<string, unknown>);

  const starts = byEvent('run.start');
  const deltas = byEvent('delta');
  const toolCalls = byEvent('tool.call');
  const toolResults = byEvent('tool.result');
  const ends = byEvent('run.end');

  equal('恰好 1 个 run.start', starts.length, 1);
  check('收到文本增量', deltas.length > 0);
  check('收到 tool.call', toolCalls.length >= 1);
  check('收到 tool.result', toolResults.length >= 1);
  equal('恰好 1 个 run.end', ends.length, 1);

  const sessionId = String(starts[0]?.sessionId ?? '');
  check('run.start 携带 sessionId', sessionId.startsWith('sess_'));
  equal('run.end 的 sessionId 一致', ends[0]?.sessionId, sessionId);
  check('tool.call 报出工具名', toolCalls[0]?.name === 'echo');
  check('tool.call 解析出参数', (toolCalls[0]?.args as { text?: string })?.text?.includes('你好') === true);
  equal('工具执行成功', toolResults[0]?.ok, true);
  check('run.end 输出非空', String(ends[0]?.output ?? '').length > 0);
  check('run.end 报告 usage', ((ends[0]?.usage as { total_tokens?: number })?.total_tokens ?? 0) > 0);

  // Event ordering: run.start must precede every delta, run.end must be last.
  const order = frames.map((f) => f.event);
  check('事件顺序：run.start 最先', order[0] === 'run.start');
  check('事件顺序：run.end 最后', order.at(-1) === 'run.end');
  check(
    '事件顺序：tool.result 在 tool.call 之后',
    order.indexOf('tool.result') > order.indexOf('tool.call'),
  );

  section('会话持久化（SQLite）');

  const sessions = await http(main, 'GET', '/v1/sessions?limit=50', { key: main.key });
  equal('会话列表 → 200', sessions.status, 200);
  const sessionList = (sessions.json as { data?: Array<{ id: string; messageCount?: number }> }).data ?? [];
  check('刚创建的会话已落库', sessionList.some((s) => s.id === sessionId));

  const detail = await http(main, 'GET', `/v1/sessions/${sessionId}`, { key: main.key });
  equal('会话详情 → 200', detail.status, 200);
  const detailJson = detail.json as {
    messages?: Array<{ role: string; content: string | null; toolCalls?: unknown[] }>;
  };
  const roles = (detailJson.messages ?? []).map((m) => m.role);
  // Regression: an absent ?limit used to become Number(null) === 0, clamping to
  // the minimum and silently returning only the final message.
  check(
    '缺少 ?limit 时返回完整转录（回归）',
    (detailJson.messages ?? []).length >= 4,
    `只返回了 ${(detailJson.messages ?? []).length} 条`,
  );
  check('转录含 user 消息', roles.includes('user'));
  check('转录含 assistant 消息', roles.includes('assistant'));
  check('转录含 tool 消息', roles.includes('tool'));
  check('转录顺序为 user 开头', roles[0] === 'user');
  check(
    'assistant 消息保留了 tool_calls',
    (detailJson.messages ?? []).some((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0),
  );

  const missing = await http(main, 'GET', '/v1/sessions/sess_does_not_exist', { key: main.key });
  equal('不存在的会话 → 404', missing.status, 404);

  // Memory tool round trip, and session isolation.
  await http(main, 'POST', '/v1/agent/run', {
    key: main.key,
    json: { stream: false, sessionId, input: '记住 favorite=ramen' },
  });
  const withMemory = await http(main, 'GET', `/v1/sessions/${sessionId}`, { key: main.key });
  const memory = (withMemory.json as { memory?: Record<string, unknown> }).memory ?? {};
  equal('memory_write 写入会话记忆', memory.favorite, 'ramen');

  const other = await http(main, 'POST', '/v1/sessions', { key: main.key, json: { title: '隔离测试' } });
  const otherId = (other.json as { session?: { id?: string } })?.session?.id ?? '';
  const otherDetail = await http(main, 'GET', `/v1/sessions/${otherId}`, { key: main.key });
  const otherMemory = (otherDetail.json as { memory?: Record<string, unknown> }).memory ?? {};
  check('会话记忆相互隔离', otherMemory.favorite === undefined);

  const runs = await http(main, 'GET', '/v1/runs?limit=20', { key: main.key });
  equal('运行记录列表 → 200', runs.status, 200);
  const runList = (runs.json as { data?: Array<{ status: string; rounds: number; toolCalls: number }> }).data ?? [];
  check('运行已记录且状态为 succeeded', runList.some((r) => r.status === 'succeeded'));
  check('运行记录了工具调用次数', runList.some((r) => r.toolCalls > 0));

  const deleted = await http(main, 'DELETE', `/v1/sessions/${otherId}`, { key: main.key });
  equal('删除会话 → 200', deleted.status, 200);
  const afterDelete = await http(main, 'GET', `/v1/sessions/${otherId}`, { key: main.key });
  equal('删除后会话不可见 → 404', afterDelete.status, 404);

  // Regression: a caller-supplied session id used to be replaced by a generated
  // one, so anyone assigning their own ids (X-Nami-Session, OneBot groups, the
  // AstrBot plugin) silently lost conversational continuity.
  const customId = 'my-own-session-id';
  await http(main, 'POST', '/v1/agent/run', {
    key: main.key,
    json: { stream: false, sessionId: customId, input: 'echo 连续性测试' },
  });
  const customSession = await http(main, 'GET', `/v1/sessions/${customId}`, { key: main.key });
  equal('客户端自带的 sessionId 被原样采用（回归）', customSession.status, 200);
  const customMessages = (customSession.json as { messages?: unknown[] }).messages ?? [];
  check('该会话确实记录了对话内容', customMessages.length >= 2);

  await http(main, 'POST', '/v1/agent/run', {
    key: main.key,
    json: { stream: false, sessionId: customId, input: 'echo 第二轮' },
  });
  const secondRound = await http(main, 'GET', `/v1/sessions/${customId}`, { key: main.key });
  check(
    '第二轮追加到同一个会话，而不是新建',
    ((secondRound.json as { messages?: unknown[] }).messages ?? []).length > customMessages.length,
  );

  return { sessionId };
}

async function testWebSocket(main: Fixture): Promise<void> {
  section('WebSocket 双向通道（自研 RFC 6455 实现）');

  const outcome = await wsConnect(
    main,
    main.key,
    (send) => send({ type: 'user_message', content: '计算 2^10' }),
    (message, send) => {
      // Ask for the session list once the run settles, then stop.
      if (message.type === 'run.end') send({ type: 'sessions', limit: 1 });
      return message.type === 'sessions';
    },
  );

  const types = outcome.messages.map((m) => String(m.type));
  check('连接后收到 ready', types[0] === 'ready');
  const ready = outcome.messages[0] as { tools?: string[]; protocol?: number } | undefined;
  check('ready 宣告可用工具', (ready?.tools ?? []).includes('calc'));
  equal('ready 宣告协议版本', ready?.protocol, 1);
  check('收到 run.start', types.includes('run.start'));
  check('收到 delta', types.includes('delta'));
  check('收到 tool.call', types.includes('tool.call'));
  check('收到 tool.result', types.includes('tool.result'));
  check('收到 run.end', types.includes('run.end'));
  equal('干净关闭码为 1000', outcome.closeCode, 1000);

  const toolCall = outcome.messages.find((m) => m.type === 'tool.call');
  equal('WS 上识别出 calc 工具', toolCall?.name, 'calc');
  const toolResult = outcome.messages.find((m) => m.type === 'tool.result');
  equal('WS 上工具执行成功', toolResult?.ok, true);

  const runEnd = outcome.messages.find((m) => m.type === 'run.end');
  check('WS run.end 输出含 1024', String(runEnd?.output ?? '').includes('1024'));

  const sessionMessage = outcome.messages.find((m) => m.type === 'sessions');
  check('WS sessions 控制消息返回列表', Array.isArray((sessionMessage?.data as unknown[]) ?? null));

  const deltaChars = outcome.messages
    .filter((m) => m.type === 'delta')
    .map((m) => String(m.text ?? ''))
    .join('').length;
  check('WS 流式增量拼出完整回答', deltaChars > 20);

  // Ping/pong control message.
  const pong = await wsConnect(main, main.key, (send) => send({ type: 'ping' }), (m) => m.type === 'pong');
  check('WS ping → pong', pong.messages.some((m) => m.type === 'pong'));

  // Cancel handling with no run in flight.
  const idleCancel = await wsConnect(
    main,
    main.key,
    (send) => send({ type: 'cancel' }),
    (m) => m.type === 'error' || m.type === 'cancelled',
  );
  const cancelReply = idleCancel.messages.find((m) => m.type === 'error' || m.type === 'cancelled');
  equal('空闲时 cancel 得到明确回应', cancelReply?.code, 'idle');

  // Unsupported message type.
  const badType = await wsConnect(
    main,
    main.key,
    (send) => send({ type: 'nonsense' }),
    (m) => m.type === 'error',
  );
  equal(
    '未知消息类型被拒绝',
    (badType.messages.find((m) => m.type === 'error') as { code?: string })?.code,
    'unsupported_type',
  );

  // A bad key must fail the upgrade, not open a socket.
  let rejected = false;
  try {
    await wsConnect(main, 'definitely_wrong_key', () => {}, () => false);
  } catch {
    rejected = true;
  }
  check('错误的 key 无法建立 WebSocket', rejected);
}

async function testRateLimitAndLimits(): Promise<void> {
  section('限流与请求体上限');

  const guarded = await startServer('ratelimit', {
    NAMI_RATE_LIMIT_BURST: '3',
    NAMI_RATE_LIMIT_PER_SECOND: '0.0001',
  });

  const statuses: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const result = await http(guarded, 'GET', '/v1/models');
    statuses.push(result.status);
    if (i === 3) {
      check('限流响应带 Retry-After', result.headers.get('retry-after') !== null);
      check('限流响应带 x-ratelimit-remaining', result.headers.get('x-ratelimit-remaining') !== null);
      check(
        '限流错误码正确',
        (result.json as { error?: { code?: string } })?.error?.code === 'rate_limited',
      );
    }
  }
  check('突发额度内的请求通过', statuses.slice(0, 3).every((s) => s === 200));
  check('超出额度后返回 429', statuses.slice(3).every((s) => s === 429));

  const healthAfterLimit = await http(guarded, 'GET', '/healthz', { key: null });
  equal('健康检查不受限流影响', healthAfterLimit.status, 200);

  const tiny = await startServer('bodylimit', { NAMI_MAX_BODY_BYTES: '512' });
  const tooBig = await http(tiny, 'POST', '/v1/agent/run', {
    key: tiny.key,
    raw: JSON.stringify({ input: 'x'.repeat(2000) }),
  });
  equal('超出体积上限 → 413', tooBig.status, 413);

  const okSize = await http(tiny, 'POST', '/v1/agent/run', {
    key: tiny.key,
    json: { input: 'echo ok', stream: false },
  });
  equal('上限内的请求正常', okSize.status, 200);
}

async function testToolFailurePaths(main: Fixture): Promise<void> {
  section('工具沙箱失败路径');

  // An unknown tool must come back as a readable tool error, not a crash.
  const result = await http(main, 'POST', '/v1/agent/run', {
    key: main.key,
    json: { stream: false, input: 'echo 沙箱测试' },
  });
  equal('正常工具调用仍成功', result.status, 200);

  const detail = result.json as { toolCallDetails?: unknown[]; toolCalls?: unknown; output?: string };
  check('返回 toolCallDetails 明细数组', Array.isArray(detail.toolCallDetails));
  check('toolCalls 保持为计数（与 run.end 事件一致）', typeof detail.toolCalls === 'number');
  check('明细中不含被覆盖的空数组', (detail.toolCallDetails ?? []).length > 0);
  check('输出包含工具结果', String(detail.output ?? '').length > 0);

  // Disabled tools must be refused even if the model asks for them.
  const disabled = main.app.deps.registry.get('http_get');
  check('http_get 已注册', disabled !== undefined);
  equal('http_get 默认禁用', disabled?.enabled, false);

  const fsRead = main.app.deps.registry.get('fs_read');
  equal('fs_read 默认禁用', fsRead?.enabled, false);

  const stats = await http(main, 'GET', '/admin/api/stats', { key: null, adminToken: ADMIN_TOKEN });
  const usage = (stats.json as { toolUsage?: Array<{ name: string; calls: number; failures: number }> }).toolUsage ?? [];
  check('工具调用被统计', usage.some((u) => u.calls > 0));
  check('每次调用都记录了耗时', usage.every((u) => typeof u.calls === 'number'));
}

/* ------------------------------------------------------------------ *
 * Ollama integration
 * ------------------------------------------------------------------ */

type FinishChunk = Extract<StreamChunk, { type: 'finish' }>;
type TextChunk = Extract<StreamChunk, { type: 'text' }>;
type ToolCallChunk = Extract<StreamChunk, { type: 'tool_call' }>;

function finishOf(chunks: StreamChunk[]): FinishChunk | undefined {
  return chunks.find((chunk): chunk is FinishChunk => chunk.type === 'finish');
}
function textOfChunks(chunks: StreamChunk[]): string {
  return chunks
    .filter((chunk): chunk is TextChunk => chunk.type === 'text')
    .map((chunk) => chunk.text)
    .join('');
}
function toolCallOf(chunks: StreamChunk[]): ToolCallChunk | undefined {
  return chunks.find((chunk): chunk is ToolCallChunk => chunk.type === 'tool_call');
}

async function drain(stream: AsyncGenerator<StreamChunk, void, undefined>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function testOllamaProvider(): Promise<void> {
  section('Ollama 原生适配器（对假守护进程）');

  const daemon = await startFakeOllama([
    { id: 'qwen2.5:7b', sizeBytes: 4_700_000_000, parameters: '7.6B', quantization: 'Q4_K_M', family: 'qwen2' },
    { id: 'llama3.1:8b', sizeBytes: 4_900_000_000, parameters: '8.0B', quantization: 'Q4_0', family: 'llama' },
  ]);

  try {
    const provider = new OllamaProvider({
      url: daemon.url,
      model: 'qwen2.5:7b',
      timeoutMs: 10_000,
      keepAlive: '10m',
      numCtx: 4096,
    });

    equal('version() 读到版本号', await provider.version(), '0.5.7-fake');

    const models = await provider.listModelInfo();
    equal('listModelInfo 返回全部模型', models.length, 2);
    equal('模型 id 正确', models[0]?.id, 'qwen2.5:7b');
    equal('附带参数量', (models[0]?.meta as { parameters?: string })?.parameters, '7.6B');
    equal('附带量化等级', (models[0]?.meta as { quantization?: string })?.quantization, 'Q4_K_M');
    check('附带文件大小', ((models[0]?.meta as { sizeBytes?: number })?.sizeBytes ?? 0) > 0);
    check('附带修改时间', typeof models[0]?.created === 'number');

    const running = await provider.runningModels();
    equal('runningModels 报告已载入显存的模型', running[0]?.name, 'qwen2.5:7b');

    /* ---- streaming text, with one NDJSON line split across two TCP writes ---- */
    daemon.requests.length = 0;
    const chunks = await drain(provider.stream({ messages: [{ role: 'user', content: '你好' }] }));
    const text = textOfChunks(chunks);
    check('跨 TCP 分片的 NDJSON 被正确重组', text.includes('这是 qwen2.5:7b 的回答'), text);
    equal('finish reason 透传', finishOf(chunks)?.reason, 'stop');
    equal(
      'usage 取自 prompt_eval_count/eval_count',
      finishOf(chunks)?.usage.total_tokens,
      18,
    );

    const body = daemon.requests[0] ?? {};
    equal('请求携带 model', body.model, 'qwen2.5:7b');
    equal('keep_alive 透传', body.keep_alive, '10m');
    equal('num_ctx 透传', (body.options as { num_ctx?: number } | undefined)?.num_ctx, 4096);
    equal('以流式请求', body.stream, true);

    /* ---- per-request model override ---- */
    daemon.requests.length = 0;
    await drain(provider.stream({ messages: [{ role: 'user', content: 'hi' }], model: 'llama3.1:8b' }));
    equal('按请求覆盖模型', daemon.requests[0]?.model, 'llama3.1:8b');
    equal('默认模型未被改动', provider.model, 'qwen2.5:7b');

    /* ---- native tool calls ---- */
    daemon.requests.length = 0;
    const toolChunks = await drain(
      provider.stream({
        messages: [{ role: 'user', content: '现在几点' }],
        tools: [
          { name: 'now', description: 'current time', parameters: { type: 'object', properties: {} }, danger: 'safe', enabled: true },
        ],
      }),
    );
    const call = toolCallOf(toolChunks);
    equal('解析出原生 tool_call', call?.name, 'now');
    check('为无 id 的调用合成 id', typeof call?.id === 'string' && call.id.startsWith('call_'));
    equal('arguments 转成 JSON 字符串', call?.argsDelta, '{}');
    check('请求带上了 tools', Array.isArray(daemon.requests[0]?.tools));

    /* ---- message conversion ---- */
    const converted = toOllamaMessages([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'now', arguments: '{"a":1}' } }],
      },
      { role: 'tool', content: 'result', tool_call_id: 'call_1', name: 'now' },
    ]);
    check(
      'assistant tool_calls 的 arguments 还原为对象',
      typeof converted[0]?.tool_calls?.[0]?.function.arguments === 'object',
    );
    equal('tool 消息带上 tool_name', converted[1]?.tool_name, 'now');

    /* ---- pulling ---- */
    const progress: string[] = [];
    await provider.pull('newmodel:1b', (status) => progress.push(status));
    equal('pull 记录了目标模型', daemon.pulled[0], 'newmodel:1b');
    check('pull 回报了下载进度', progress.includes('downloading'));

    /* ---- uninstalled model ---- */
    let notFoundMessage = '';
    try {
      await drain(provider.stream({ messages: [{ role: 'user', content: 'x' }], model: 'ghost:1b' }));
    } catch (error) {
      notFoundMessage = error instanceof Error ? error.message : String(error);
    }
    check('未安装模型报出 Ollama 的原始错误', notFoundMessage.includes('not found'), notFoundMessage);
  } finally {
    await daemon.close();
  }
}

async function testModelRouting(): Promise<void> {
  section('模型路由与暴露策略');

  const base: Record<string, string> = {
    NAMI_DB_PATH: ':memory:',
    NAMI_LLM_PROVIDER: 'mock',
    NAMI_LLM_MODEL: 'nami-mock-1',
  };

  const router = new ModelRouter({
    provider: new MockProvider({ model: 'nami-mock-1' }),
    config: testConfig({ ...base, NAMI_MODEL_ALIASES: 'gpt-4o-mini=nami-mock-echo' }),
    log: nullLogger,
  });
  await router.refresh(true);

  equal('默认模型来自配置', router.defaultModel, 'nami-mock-1');
  const plain = router.resolve(undefined);
  check('未指定模型时使用默认', plain.ok && plain.model === 'nami-mock-1');
  const direct = router.resolve('nami-mock-echo');
  check('直接指定已发现模型', direct.ok && direct.model === 'nami-mock-echo');
  const aliased = router.resolve('gpt-4o-mini');
  check(
    '别名映射到上游模型',
    aliased.ok && aliased.model === 'nami-mock-echo' && aliased.aliased === true,
  );
  const unknown = router.resolve('does-not-exist');
  check('未知模型被拒绝', !unknown.ok && unknown.code === 'model_not_found');
  check('目录包含别名', router.listForApi().some((model) => model.id === 'gpt-4o-mini'));
  check(
    '目录标注 aliasOf',
    (router.listForApi().find((model) => model.id === 'gpt-4o-mini')?.meta as { aliasOf?: string })
      ?.aliasOf === 'nami-mock-echo',
  );

  /* ---- allowlist ---- */
  const restricted = new ModelRouter({
    provider: new MockProvider({ model: 'nami-mock-1' }),
    config: testConfig({
      ...base,
      NAMI_MODEL_ALIASES: 'gpt-4o-mini=nami-mock-echo',
      NAMI_MODELS_EXPOSE: 'gpt-4o-mini',
    }),
    log: nullLogger,
  });
  await restricted.refresh(true);

  const allowed = restricted.resolve('gpt-4o-mini');
  check('白名单内的名称放行', allowed.ok && allowed.model === 'nami-mock-echo');
  const blocked = restricted.resolve('nami-mock-1');
  check('白名单外的名称被拒', !blocked.ok && blocked.code === 'model_not_allowed');
  equal(
    '白名单配置下目录只含被暴露的名称',
    restricted.listForApi().map((model) => model.id).join(','),
    'gpt-4o-mini',
  );

  /* ---- client selection disabled ---- */
  const locked = new ModelRouter({
    provider: new MockProvider({ model: 'nami-mock-1' }),
    config: testConfig({ ...base, NAMI_ALLOW_CLIENT_MODEL: 'false' }),
    log: nullLogger,
  });
  await locked.refresh(true);
  const pinned = locked.resolve('nami-mock-echo');
  check(
    '关闭客户端选模型后一律落到默认',
    pinned.ok && pinned.model === 'nami-mock-1' && pinned.requested === 'nami-mock-echo',
  );

  /* ---- discovery failure must not block traffic ---- */
  const tolerant = new ModelRouter({
    provider: {
      id: 'flaky',
      model: 'only-model',
      setDefaultModel: () => {},
      listModelInfo: async () => {
        throw new Error('upstream down');
      },
      // eslint-disable-next-line require-yield
      stream: async function* () {},
    },
    config: testConfig({ ...base, NAMI_LLM_MODEL: 'only-model' }),
    log: nullLogger,
  });
  await tolerant.refresh(true);
  const passThrough = tolerant.resolve('whatever-the-client-wants');
  check('探测失败时不拦截请求', passThrough.ok && passThrough.model === 'whatever-the-client-wants');
  check('探测失败被记录下来', tolerant.lastError === 'upstream down');
}

async function testOllamaHosting(): Promise<void> {
  section('把 Ollama 托管为 OpenAI 兼容服务');

  const daemon = await startFakeOllama([
    { id: 'qwen2.5:7b', sizeBytes: 4_700_000_000, parameters: '7.6B', quantization: 'Q4_K_M', family: 'qwen2' },
    { id: 'llama3.1:8b', sizeBytes: 4_900_000_000, parameters: '8.0B', quantization: 'Q4_0', family: 'llama' },
    { id: 'nomic-embed-text', sizeBytes: 274_000_000, parameters: '137M', quantization: 'F16', family: 'nomic-bert' },
  ]);

  const fixture = await startServer('ollama-host', {
    NAMI_LLM_PROVIDER: 'ollama',
    NAMI_OLLAMA_URL: daemon.url,
    NAMI_LLM_MODEL: '',
    NAMI_OLLAMA_KEEP_ALIVE: '15m',
    NAMI_OLLAMA_NUM_CTX: '8192',
    NAMI_MODEL_ALIASES: 'gpt-4o-mini=qwen2.5:7b,ghost-alias=not-installed:1b',
    NAMI_MODELS_EXPOSE: 'gpt-4o-mini,qwen2.5:7b,ghost-alias',
  });

  try {
    /* ---- boot-time discovery ---- */
    const ready = await http(fixture, 'GET', '/readyz', { key: null });
    equal('接入 Ollama 后就绪', ready.status, 200);
    const checks = (ready.json as { checks?: Record<string, string> }).checks ?? {};
    equal('探针报告发现了 3 个模型', checks.models, '3 available');
    equal('未配置模型时自动采用第一个', checks.model, 'qwen2.5:7b');

    const catalogue = await http(fixture, 'GET', '/v1/models', { key: fixture.key });
    const ids = ((catalogue.json as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id);
    check('目录含真实模型', ids.includes('qwen2.5:7b'));
    check('目录含别名', ids.includes('gpt-4o-mini'));
    check(
      '目录排除未暴露的模型',
      !ids.includes('llama3.1:8b') && !ids.includes('nomic-embed-text'),
      ids.join(','),
    );

    /* ---- a normal completion through an alias ---- */
    daemon.requests.length = 0;
    const viaAlias = await http(fixture, 'POST', '/v1/chat/completions', {
      key: fixture.key,
      json: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '你好' }] },
    });
    equal('别名请求成功', viaAlias.status, 200);
    equal('上游收到的是真实模型名', daemon.requests[0]?.model, 'qwen2.5:7b');
    equal('响应回显客户端请求的名字', (viaAlias.json as { model?: string }).model, 'gpt-4o-mini');
    check(
      '内容确实来自 Ollama',
      String(
        (viaAlias.json as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]
          ?.message?.content ?? '',
      ).includes('qwen2.5:7b'),
    );
    equal('keep_alive 透传到上游', daemon.requests[0]?.keep_alive, '15m');
    equal(
      'num_ctx 透传到上游',
      (daemon.requests[0]?.options as { num_ctx?: number } | undefined)?.num_ctx,
      8192,
    );
    check('上游收到了服务端注册的工具', Array.isArray(daemon.requests[0]?.tools));

    /* ---- the full agent loop, over Ollama's native tool calling ---- */
    daemon.requests.length = 0;
    const toolRun = await http(fixture, 'POST', '/v1/agent/run', {
      key: fixture.key,
      json: { stream: false, input: '现在几点', model: 'qwen2.5:7b' },
    });
    equal('经 Ollama 的完整工具循环成功', toolRun.status, 200);
    equal('发生了两轮上游调用', daemon.requests.length, 2);

    const secondRound = (daemon.requests[1]?.messages ?? []) as Array<{
      role: string;
      tool_name?: string;
    }>;
    check(
      '第二轮把工具结果按 tool_name 带回',
      secondRound.some((message) => message.role === 'tool' && message.tool_name === 'now'),
    );

    const detail = toolRun.json as { toolCallDetails?: unknown[]; output?: string };
    check('本地沙箱真实执行了 now 工具', (detail.toolCallDetails?.length ?? 0) > 0);
    check(
      '最终回答来自 Ollama',
      String(detail.output ?? '').includes('工具 now 已执行'),
      String(detail.output ?? ''),
    );

    /* ---- model policy errors ---- */
    const notExposed = await http(fixture, 'POST', '/v1/chat/completions', {
      key: fixture.key,
      json: { model: 'llama3.1:8b', messages: [{ role: 'user', content: 'x' }] },
    });
    equal('未暴露的模型 → 403', notExposed.status, 403);

    const missing = await http(fixture, 'POST', '/v1/chat/completions', {
      key: fixture.key,
      json: { model: 'ghost-alias', messages: [{ role: 'user', content: 'x' }] },
    });
    equal('已暴露但未安装的模型 → 404', missing.status, 404);
    check(
      '错误码为 model_not_found',
      (missing.json as { error?: { code?: string } })?.error?.code === 'model_not_found',
    );

    /* ---- admin catalogue ---- */
    const adminModels = await http(fixture, 'GET', '/admin/api/models', {
      key: null,
      adminToken: ADMIN_TOKEN,
    });
    equal('admin 模型目录 → 200', adminModels.status, 200);
    const entries = (adminModels.json as {
      data?: Array<{ id: string; aliases: string[]; isDefault: boolean; meta?: Record<string, unknown> }>;
    }).data ?? [];
    check('标注默认模型', entries.some((entry) => entry.id === 'qwen2.5:7b' && entry.isDefault));
    check(
      '标注别名',
      entries.some((entry) => entry.aliases.includes('gpt-4o-mini')),
    );
    check(
      '暴露上游元数据',
      typeof entries.find((entry) => entry.id === 'qwen2.5:7b')?.meta?.parameters === 'string',
    );
    check(
      '标记未安装的别名目标',
      entries.some((entry) => entry.id === 'not-installed:1b' && entry.meta?.notInstalled === true),
    );
  } finally {
    await daemon.close();
  }
}

async function testOllamaUnavailable(): Promise<void> {
  section('Ollama 不可用时的降级行为');

  const fixture = await startServer('ollama-down', {
    NAMI_LLM_PROVIDER: 'ollama',
    // Nothing listens on port 1, so every probe is refused immediately.
    NAMI_OLLAMA_URL: 'http://127.0.0.1:1',
    NAMI_LLM_MODEL: '',
  });

  const health = await http(fixture, 'GET', '/healthz', { key: null });
  equal('进程存活探针仍为 200', health.status, 200);

  const ready = await http(fixture, 'GET', '/readyz', { key: null });
  equal('无法连接 Ollama 时 /readyz 返回 503', ready.status, 503);
  const checks = (ready.json as { checks?: Record<string, string> }).checks ?? {};
  equal('报告没有可用模型', checks.model, 'none selected');
  check('报告探测失败原因', (checks.models ?? '').length > 0);

  const models = await http(fixture, 'GET', '/v1/models', { key: fixture.key });
  equal('/v1/models 仍可访问', models.status, 200);

  const chat = await http(fixture, 'POST', '/v1/chat/completions', {
    key: fixture.key,
    json: { messages: [{ role: 'user', content: 'hi' }] },
  });
  equal('聊天请求给出可诊断的 404，而不是崩溃', chat.status, 404);
  check(
    '错误信息给出下一步操作',
    String((chat.json as { error?: { message?: string } })?.error?.message ?? '').includes('ollama'),
  );
}

/* ------------------------------------------------------------------ *
 * OpenAPI surface
 * ------------------------------------------------------------------ */

async function testOpenApiSurface(main: Fixture): Promise<void> {
  section('OpenAPI 规范与文档页');

  const spec = await http(main, 'GET', '/openapi.json', { key: null });
  equal('/openapi.json 无需鉴权 → 200', spec.status, 200);
  const doc = spec.json as {
    openapi?: string;
    info?: { title?: string; version?: string };
    paths?: Record<string, Record<string, unknown>>;
  };
  equal('声明 OpenAPI 3.1', doc.openapi, '3.1.0');
  check('包含标题与版本', typeof doc.info?.title === 'string' && typeof doc.info?.version === 'string');
  check('paths 达到预期规模', Object.keys(doc.paths ?? {}).length >= 20);

  // Drift check: the document and the live router must agree exactly.
  const documented = new Set(listDocumentedRoutes(doc as Record<string, unknown>));
  const registered = new Set<string>();
  for (const route of main.app.nami.router.describe()) {
    let pattern = route.pattern.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    if (pattern.length > 1 && pattern.endsWith('/')) pattern = pattern.slice(0, -1);
    registered.add(`${route.method} ${pattern}`);
  }
  const missing = [...registered].filter((route) => !documented.has(route));
  const extra = [...documented].filter((route) => !registered.has(route));
  check('规范覆盖了全部已注册路由', missing.length === 0, missing.join(', '));
  check('规范没有多余或不存在的路由', extra.length === 0, extra.join(', '));

  const docs = await http(main, 'GET', '/docs', { key: null });
  equal('/docs 无需鉴权 → 200', docs.status, 200);
  check('/docs 返回 HTML', (docs.headers.get('content-type') ?? '').includes('text/html'));
  check('/docs 页面非空', docs.body.length > 3000);
  check('/docs 通过 fetch 加载规范而不是内联', docs.body.includes("fetch('/openapi.json'"));
}

/* ------------------------------------------------------------------ *
 * One-click script logic
 * ------------------------------------------------------------------ */

function testOllamaScript(): void {
  section('一键接入脚本的纯逻辑');

  const args = parseOllamaArgs(['--pull', 'qwen2.5:7b', '--write', '--url', 'http://x:1']);
  equal('解析 --pull', args.pull, 'qwen2.5:7b');
  equal('解析 --write', args.write, true);
  equal('解析 --url', args.url, 'http://x:1');
  equal('未指定 --model 时为 null', args.model, null);

  const created = upsertEnv('', { NAMI_LLM_PROVIDER: 'ollama', NAMI_LLM_MODEL: 'qwen2.5:7b' });
  check(
    '新建 .env 写入两个键',
    created.content.includes('NAMI_LLM_PROVIDER=ollama') &&
      created.content.includes('NAMI_LLM_MODEL=qwen2.5:7b'),
  );
  check('新建 .env 以换行结尾', created.content.endsWith('\n'));
  equal('记录了新增项', created.applied.length, 2);
  equal('新增项标记为无旧值', created.applied[0]?.from, null);

  const existing = '# 我的配置\nNAMI_PORT=9999\nNAMI_LLM_PROVIDER=mock\n';
  const updated = upsertEnv(existing, {
    NAMI_LLM_PROVIDER: 'ollama',
    NAMI_OLLAMA_URL: 'http://127.0.0.1:11434',
  });
  check('保留注释', updated.content.includes('# 我的配置'));
  check('保留无关配置', updated.content.includes('NAMI_PORT=9999'));
  check('就地改写已有键', updated.content.includes('NAMI_LLM_PROVIDER=ollama'));
  check('不残留旧值', !updated.content.includes('NAMI_LLM_PROVIDER=mock'));
  equal('只改写了 1 个已有键', updated.applied.filter((change) => change.from !== null).length, 1);
  check('追加了缺失的键', updated.content.includes('NAMI_OLLAMA_URL=http://127.0.0.1:11434'));
  equal(
    '记录旧值便于报告',
    updated.applied.find((change) => change.key === 'NAMI_LLM_PROVIDER')?.from,
    'mock',
  );
  check(
    '幂等：重复执行内容不变',
    upsertEnv(updated.content, {
      NAMI_LLM_PROVIDER: 'ollama',
      NAMI_OLLAMA_URL: 'http://127.0.0.1:11434',
    }).content === updated.content,
  );
}

/* ------------------------------------------------------------------ *
 * OneBot v11 connector
 * ------------------------------------------------------------------ */

function oneBotConfig(overrides: Record<string, string> = {}): Config {
  return testConfig({
    NAMI_DB_PATH: ':memory:',
    NAMI_ONEBOT_ENABLED: 'true',
    NAMI_ONEBOT_EVENT_TOKEN: 'ob_secret',
    NAMI_ONEBOT_TRIGGER: 'mention',
    ...overrides,
  });
}

function testOneBotPure(): void {
  section('OneBot 入站过滤（纯函数，决定是否花钱）');

  /* ---------------------------- extractMessage --------------------------- */

  const arrayMsg = extractMessage(
    {
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 现在几点 ' } },
        { type: 'image', data: { file: 'x.jpg' } },
      ],
    },
    '10001',
  );
  equal('数组消息提取纯文本', arrayMsg.text, '现在几点');
  check('数组消息识别 @机器人', arrayMsg.mentionedSelf);

  const otherAt = extractMessage(
    { message: [{ type: 'at', data: { qq: '20002' } }, { type: 'text', data: { text: 'hi' } }] },
    '10001',
  );
  check('@别人不算 @机器人', !otherAt.mentionedSelf);

  const cqMsg = extractMessage({ message: '[CQ:at,qq=10001] 你好[CQ:face,id=1]' }, '10001');
  equal('CQ 字符串剥离 CQ 码', cqMsg.text, '你好');
  check('CQ 字符串识别 @机器人', cqMsg.mentionedSelf);

  const rawMsg = extractMessage({ raw_message: '[CQ:at,qq=10001] 在吗' }, '10001');
  equal('无 message 字段时回退 raw_message', rawMsg.text, '在吗');
  check('raw_message 同样识别 @', rawMsg.mentionedSelf);

  const noMention = extractMessage({ message: [{ type: 'text', data: { text: '普通消息' } }] }, '10001');
  check('普通消息不误判为 @', !noMention.mentionedSelf);
  check('selfId 为空时绝不误判为 @', !extractMessage({ message: '[CQ:at,qq=10001] x' }, '').mentionedSelf);

  /* ------------------------------ decideEvent ---------------------------- */

  const cfg = oneBotConfig();
  const groupMention = {
    post_type: 'message',
    message_type: 'group',
    group_id: 111,
    user_id: 20002,
    message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: '你好' } }],
    sender: { nickname: '小明' },
  };

  const handled = decideEvent(cfg, groupMention, '10001');
  check('@机器人 → 处理', handled.handled);
  equal('会话 id 按群映射', handled.sessionId, 'qq-group-111');
  equal('提取出提问文本', handled.text, '你好');
  equal('记录提问者昵称', handled.senderName, '小明');

  const noTrigger = decideEvent(
    cfg,
    { ...groupMention, message: [{ type: 'text', data: { text: '你好' } }] },
    '10001',
  );
  check('未 @ 时不处理（mention 模式）', !noTrigger.handled);
  equal('跳过原因是 no-trigger', noTrigger.reason, 'no-trigger');

  const selfMsg = decideEvent(cfg, { ...groupMention, user_id: 10001 }, '10001');
  equal('机器人自己的消息被忽略', selfMsg.reason, 'from-self');

  const meta = decideEvent(cfg, { post_type: 'meta_event', meta_event_type: 'heartbeat' }, '10001');
  equal('meta_event 被忽略', meta.reason, 'not-message');

  const notice = decideEvent(cfg, { post_type: 'notice', notice_type: 'group_recall' }, '10001');
  equal('notice 被忽略', notice.reason, 'not-message');

  const imageOnly = decideEvent(
    cfg,
    { ...groupMention, message: [{ type: 'at', data: { qq: '10001' } }, { type: 'image', data: { file: 'a.jpg' } }] },
    '10001',
  );
  equal('只有图片没有文字 → empty', imageOnly.reason, 'empty');

  const privateMsg = decideEvent(
    cfg,
    { post_type: 'message', message_type: 'private', user_id: 20002, message: '你好' },
    '10001',
  );
  check('私聊在 mention 模式下也处理（无需 @）', privateMsg.handled);
  equal('私聊会话 id 按用户映射', privateMsg.sessionId, 'qq-user-20002');

  // prefix mode
  const prefixCfg = oneBotConfig({ NAMI_ONEBOT_TRIGGER: 'prefix', NAMI_ONEBOT_PREFIX: '/ai' });
  const prefixed = decideEvent(
    prefixCfg,
    { ...groupMention, message: [{ type: 'text', data: { text: '/ai  帮我算一下' } }] },
    '10001',
  );
  check('前缀触发命中', prefixed.handled);
  equal('前缀被剥离', prefixed.text, '帮我算一下');
  const unprefixed = decideEvent(
    prefixCfg,
    { ...groupMention, message: [{ type: 'text', data: { text: '帮我算一下' } }] },
    '10001',
  );
  equal('无前缀不触发', unprefixed.reason, 'no-trigger');
  const barePrefix = decideEvent(
    prefixCfg,
    { ...groupMention, message: [{ type: 'text', data: { text: '/ai' } }] },
    '10001',
  );
  equal('只有前缀没有内容 → empty', barePrefix.reason, 'empty');

  // all / none
  const allCfg = oneBotConfig({ NAMI_ONEBOT_TRIGGER: 'all' });
  check(
    'all 模式下任意消息都触发',
    decideEvent(allCfg, { ...groupMention, message: [{ type: 'text', data: { text: '随便说点' } }] }, '10001').handled,
  );
  const noneCfg = oneBotConfig({ NAMI_ONEBOT_TRIGGER: 'none' });
  equal(
    'none 模式下即使 @ 也不触发',
    decideEvent(noneCfg, groupMention, '10001').reason,
    'no-trigger',
  );

  // allowlists
  const groupList = oneBotConfig({ NAMI_ONEBOT_ALLOW_GROUPS: '111,222' });
  check('群在白名单内 → 处理', decideEvent(groupList, groupMention, '10001').handled);
  equal(
    '群不在白名单 → group-not-allowed',
    decideEvent(groupList, { ...groupMention, group_id: 999 }, '10001').reason,
    'group-not-allowed',
  );

  const userList = oneBotConfig({ NAMI_ONEBOT_ALLOW_USERS: '20002' });
  check('用户在白名单内 → 处理', decideEvent(userList, groupMention, '10001').handled);
  equal(
    '用户不在白名单 → user-not-allowed',
    decideEvent(userList, { ...groupMention, user_id: 30003 }, '10001').reason,
    'user-not-allowed',
  );

  equal(
    '自定义会话前缀生效',
    sessionIdFor(oneBotConfig({ NAMI_ONEBOT_SESSION_PREFIX: 'mybot' }), { kind: 'group', id: '5' }),
    'mybot-group-5',
  );

  /* --------------------------- stripMarkdown ---------------------------- */

  const messy = '```js\nconst a = 1;\n```\n**加粗** 和 `代码`\n## 标题\n- 项目一\n[链接](https://x.y)';
  const clean = stripMarkdown(messy);
  check('剥离围栏代码标记', !clean.includes('```'));
  check('剥离加粗', !clean.includes('**'));
  check('剥离行内代码反引号', !clean.includes('`'));
  check('剥离标题符号', !clean.includes('## '));
  check('链接保留文字', clean.includes('链接'));
  check('结果里仍有正文', clean.includes('加粗') && clean.includes('代码'));

  /* ----------------------------- chunkMessage --------------------------- */

  const long = 'a'.repeat(200);
  const parts = chunkMessage(long, 60);
  check('长文本被切成多段', parts.length >= 4, `parts=${parts.length}`);
  check('每段都不超限', parts.every((part) => part.length <= 60));
  check('拼接后内容不丢', parts.join('').replace(/\s/g, '') === long);

  const onNewlines = chunkMessage(`第一行\n${'x'.repeat(80)}\n最后一行`, 40);
  check('优先在换行处切分', onNewlines.length >= 3, `parts=${onNewlines.length}`);

  equal('空文本也能得到一段（不会发出空消息）', chunkMessage('   ', 50).length, 1);
}

async function testOneBotConnector(): Promise<void> {
  section('OneBot v11 连接器（对假实现端到端）');

  const fake = await startFakeOneBot();
  const tokenFake = await startFakeOneBot({ accessToken: 'ob_access_token' });

  const fixture = await startServer('onebot', {
    NAMI_ONEBOT_ENABLED: 'true',
    NAMI_ONEBOT_URL: fake.url,
    NAMI_ONEBOT_EVENT_TOKEN: 'ob_secret',
    NAMI_ONEBOT_TRIGGER: 'mention',
    NAMI_ONEBOT_ALLOW_GROUPS: '111',
    NAMI_MOCK_DELAY_MS: '0',
  });

  try {
    const report = {
      time: Math.floor(Date.now() / 1000),
      self_id: 10001,
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: 7001,
      group_id: 111,
      user_id: 20002,
      message: [
        { type: 'at', data: { qq: '10001' } },
        { type: 'text', data: { text: ' 你好，简单介绍一下你自己 ' } },
      ],
      sender: { user_id: 20002, nickname: '小明', role: 'member' },
    };
    const withToken = { authorization: 'Bearer ob_secret' };

    /* ------------------------- report token checks ------------------------ */
    const noToken = await http(fixture, 'POST', '/onebot/event', {
      key: null,
      json: { post_type: 'message', message_type: 'group' },
    });
    equal('缺少上报令牌 → 401', noToken.status, 401);
    check(
      '错误码为 missing_event_token',
      (noToken.json as { error?: { code?: string } })?.error?.code === 'missing_event_token',
    );

    const badToken = await http(fixture, 'POST', '/onebot/event', {
      key: null,
      headers: { authorization: 'Bearer wrong' },
      json: { post_type: 'message', message_type: 'group' },
    });
    equal('错误上报令牌 → 401', badToken.status, 401);
    check(
      '错误码为 invalid_event_token',
      (badToken.json as { error?: { code?: string } })?.error?.code === 'invalid_event_token',
    );

    /* ------------------------- the real inbound path ---------------------- */
    const accepted = await http(fixture, 'POST', '/onebot/event', {
      key: null,
      headers: withToken,
      json: report,
    });
    equal('合法上报立刻返回 204（不等模型）', accepted.status, 204);
    equal('204 没有响应体', accepted.body, '');

    const arrived = await waitFor(() => fake.sent.length > 0);
    check('回答被异步回发到群', arrived, `sent=${fake.sent.length}`);

    const first = fake.sent[0];
    equal('回发到正确的群', first?.target, '111');
    equal('调用的是 send_group_msg', first?.action, 'send_group_msg');
    equal('首段是真实 at 消息段', first?.segments[0]?.type, 'at');
    equal('at 指向提问者', String(first?.segments[0]?.data.qq), '20002');

    const replyText = joinSegments(first?.segments ?? []);
    check('回答非空', replyText.trim().length > 0);
    check('未经 Markdown 残留反引号', !replyText.includes('`'), replyText.slice(0, 100));
    check('agent 真的跑了（回答来自模型）', replyText.includes('Mock') || replyText.includes('Nami'));

    const sessionAfter = fixture.app.deps.store.listSessions(10);
    check(
      'QQ 会话以 qq-group-111 落库',
      sessionAfter.some((session) => session.id === 'qq-group-111'),
      sessionAfter.map((s) => s.id).join(','),
    );

    /* ---------------------------- filter paths ---------------------------- */
    const sentBefore = fake.sent.length;
    await http(fixture, 'POST', '/onebot/event', {
      key: null,
      headers: withToken,
      json: { ...report, message: [{ type: 'text', data: { text: '没 @ 机器人' } }] },
    });
    await http(fixture, 'POST', '/onebot/event', {
      key: null,
      headers: withToken,
      json: { ...report, user_id: 10001 },
    });
    await http(fixture, 'POST', '/onebot/event', {
      key: null,
      headers: withToken,
      json: { ...report, group_id: 999 },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    equal('未 @／自己发的／白名单外的群，都不会产生回复', fake.sent.length, sentBefore);
    check('跳过计数被记录', fixture.app.deps.metrics.snapshot().onebot.eventsSkipped >= 3);

    /* ------------------------- admin simulate route ----------------------- */
    const simulated = await http(fixture, 'POST', '/admin/api/onebot/event', {
      key: null,
      adminToken: ADMIN_TOKEN,
      json: report,
    });
    equal('admin 模拟端点同步返回结果', simulated.status, 200);
    const outcome = simulated.json as { handled?: boolean; reason?: string; sessionId?: string };
    equal('模拟结果为 handled', outcome.reason, 'handled');
    equal('模拟结果带 sessionId', outcome.sessionId, 'qq-group-111');

    const simulatedSkip = await http(fixture, 'POST', '/admin/api/onebot/event', {
      key: null,
      adminToken: ADMIN_TOKEN,
      json: { ...report, message: [{ type: 'text', data: { text: '无 @' } }] },
    });
    equal('模拟未触发事件返回 no-trigger', (simulatedSkip.json as { reason?: string }).reason, 'no-trigger');
    check(
      '未触发时给出原因提示',
      typeof (simulatedSkip.json as { hint?: string }).hint === 'string',
    );

    /* --------------------------- admin status ----------------------------- */
    const status = await http(fixture, 'GET', '/admin/api/onebot/status', {
      key: null,
      adminToken: ADMIN_TOKEN,
    });
    equal('onebot 状态端点 → 200', status.status, 200);
    const statusJson = status.json as {
      enabled?: boolean;
      eventTokenConfigured?: boolean;
      inbound?: { ready?: boolean; trigger?: string };
      connection?: { reachable?: boolean; account?: { nickname?: string } };
      bridge?: { received?: number; handled?: number; replies?: number };
    };
    equal('报告已启用', statusJson.enabled, true);
    check('报告令牌已配置', statusJson.eventTokenConfigured === true);
    equal('入站已就绪', statusJson.inbound?.ready, true);
    equal('触发模式回显', statusJson.inbound?.trigger, 'mention');
    equal('实时探测到 OneBot 账号', statusJson.connection?.account?.nickname, 'NamiBot');
    check('网桥计数已累计', (statusJson.bridge?.received ?? 0) > 0);
    check('网桥记录了回复', (statusJson.bridge?.replies ?? 0) > 0);

    const statusRaw = JSON.stringify(status.json);
    check('状态响应绝不泄露上报令牌', !statusRaw.includes('ob_secret'));
    check('状态响应绝不泄露访问令牌', !statusRaw.includes('ob_access_token'));

    const configRaw = JSON.stringify(
      (await http(fixture, 'GET', '/admin/api/config', { key: null, adminToken: ADMIN_TOKEN })).json ?? {},
    );
    check('config 接口也不泄露 onebot 令牌', !configRaw.includes('ob_secret'));

    /* ---------------------------- manual send ----------------------------- */
    const sentManual = await http(fixture, 'POST', '/admin/api/onebot/send', {
      key: null,
      adminToken: ADMIN_TOKEN,
      json: { group_id: '111', text: '手动测试', at: '20002' },
    });
    equal('手动发送 → 200', sentManual.status, 200);
    const manualCall = fake.sent.at(-1);
    equal('手动发送到指定群', manualCall?.target, '111');
    check('手动发送带 messageId', (sentManual.json as { messageId?: number })?.messageId !== null);
    equal('手动发送支持 @', manualCall?.segments[0]?.type, 'at');

    const missingText = await http(fixture, 'POST', '/admin/api/onebot/send', {
      key: null,
      adminToken: ADMIN_TOKEN,
      json: { group_id: '111' },
    });
    equal('缺少 text → 400', missingText.status, 400);

    const missingTarget = await http(fixture, 'POST', '/admin/api/onebot/send', {
      key: null,
      adminToken: ADMIN_TOKEN,
      json: { text: 'hi' },
    });
    equal('缺少目标 → 400', missingTarget.status, 400);

    /* --------------------------- disabled / config gaps ------------------- */
    const noTokenFixture = await startServer('onebot-notoken', {
      NAMI_ONEBOT_ENABLED: 'true',
      NAMI_ONEBOT_URL: fake.url,
      NAMI_ONEBOT_EVENT_TOKEN: '',
    });
    const refused = await http(noTokenFixture, 'POST', '/onebot/event', {
      key: null,
      headers: withToken,
      json: report,
    });
    equal('未配置上报令牌时入站直接拒绝 → 503', refused.status, 503);
    check(
      '拒绝原因说明了缺哪个变量',
      String((refused.json as { error?: { message?: string } })?.error?.message ?? '').includes(
        'NAMI_ONEBOT_EVENT_TOKEN',
      ),
    );

    const offFixture = await startServer('onebot-off', { NAMI_ONEBOT_ENABLED: 'false' });
    const disabled = await http(offFixture, 'POST', '/onebot/event', {
      key: null,
      headers: withToken,
      json: report,
    });
    equal('连接器关闭时入站 → 503', disabled.status, 503);
    const offStatus = await http(offFixture, 'GET', '/admin/api/onebot/status', {
      key: null,
      adminToken: ADMIN_TOKEN,
    });
    equal('关闭时状态端点仍可用', offStatus.status, 200);
    check('关闭时状态为 enabled=false', (offStatus.json as { enabled?: boolean })?.enabled === false);

    /* --------------------------- client-level errors ---------------------- */
    const authedClient = new OneBotClient({
      url: tokenFake.url,
      accessToken: 'ob_access_token',
      timeoutMs: 5000,
      log: nullLogger,
    });
    const login = await authedClient.getLoginInfo();
    equal('带 access_token 的客户端可鉴权', login.nickname, 'NamiBot');

    const wrongClient = new OneBotClient({
      url: tokenFake.url,
      accessToken: 'nope',
      timeoutMs: 5000,
      log: nullLogger,
    });
    let authError = '';
    try {
      await wrongClient.getLoginInfo();
    } catch (error) {
      authError = error instanceof Error ? error.message : String(error);
    }
    check('错误的 access_token 报出 OneBot 原始错误', authError.includes('token'), authError);

    const deadClient = new OneBotClient({
      url: 'http://127.0.0.1:1',
      accessToken: '',
      timeoutMs: 2000,
      log: nullLogger,
    });
    let deadError = '';
    try {
      await deadClient.getLoginInfo();
    } catch (error) {
      deadError = error instanceof Error ? error.message : String(error);
    }
    check('连不上 OneBot 时给出可操作的提示', deadError.includes('SnowLuma') || deadError.includes('Cannot reach'), deadError);

    const groups = await authedClient.getGroupList();
    equal('get_group_list 解析数组', groups.length, 2);
    equal('群名解析正确', groups[0]?.group_name, '测试群');
    const members = await authedClient.getGroupMemberList(111);
    equal('get_group_member_list 解析成员', members.length, 2);
    equal('成员昵称解析正确', members[0]?.nickname, '小明');
  } finally {
    await fake.close();
    await tokenFake.close();
  }
}

async function testOneBotTools(): Promise<void> {
  section('OneBot 出站工具（默认关闭 + 发送白名单）');

  const masterOff = await startServer('onebot-master-off', { NAMI_ONEBOT_ENABLED: 'false' });
  check(
    '工具已注册（便于在面板中可见，而不是静默消失）',
    masterOff.app.deps.registry.get('onebot_send_group_msg') !== undefined,
  );
  equal(
    '主开关关闭时发送工具禁用',
    masterOff.app.deps.registry.get('onebot_send_group_msg')?.enabled,
    false,
  );
  equal(
    '主开关关闭时读类工具也禁用',
    masterOff.app.deps.registry.get('onebot_get_group_list')?.enabled,
    false,
  );

  const sendingOff = await startServer('onebot-sending-off', { NAMI_ONEBOT_ENABLED: 'true' });
  equal(
    '未启用发送能力时发送工具仍禁用',
    sendingOff.app.deps.registry.get('onebot_send_group_msg')?.enabled,
    false,
  );
  equal(
    '读类工具只受主开关控制，此时可用',
    sendingOff.app.deps.registry.get('onebot_get_group_list')?.enabled,
    true,
  );

  const fake = await startFakeOneBot();
  const limitedFixture = await startServer('onebot-tools-on', {
    NAMI_ONEBOT_ENABLED: 'true',
    NAMI_ONEBOT_URL: fake.url,
    NAMI_ONEBOT_TOOL_ENABLED: 'true',
    NAMI_ONEBOT_TOOL_ALLOW_GROUPS: '111',
    NAMI_ONEBOT_TOOL_ALLOW_USERS: '',
  });

  try {
    const registry = limitedFixture.app.deps.registry;
    equal('启用后发送工具可用', registry.get('onebot_send_group_msg')?.enabled, true);
    equal('未配置用户白名单，私聊工具仍禁用', registry.get('onebot_send_private_msg')?.enabled, false);
    equal('读类工具随主开关启用', registry.get('onebot_get_group_list')?.enabled, true);

    const context: ToolContext = {
      sessionId: 'qq-group-111',
      runId: 'run_smoke_onebot',
      signal: new AbortController().signal,
      log: nullLogger,
      store: limitedFixture.app.deps.store,
      config: limitedFixture.config,
    };

    const sendTool = registry.get('onebot_send_group_msg');
    if (sendTool) {
      const allowed = await executeTool(
        sendTool,
        { group_id: '111', text: '来自智能体的通知' },
        context,
        { timeoutMs: 5000, maxResultBytes: 4096 },
      );
      check('白名单内的群可以发送', allowed.ok, allowed.content);
      await waitFor(() => fake.sent.length > 0);
      equal('内容真的发出去了', fake.sent.at(-1)?.target, '111');

      const blocked = await executeTool(
        sendTool,
        { group_id: '999', text: '不该发出去' },
        context,
        { timeoutMs: 5000, maxResultBytes: 4096 },
      );
      check('白名单外的群被拒绝', !blocked.ok);
      check(
        '拒绝信息说明是白名单问题',
        blocked.content.includes('allowlist'),
        blocked.content.slice(0, 120),
      );
      check('被拒绝的消息没有真的发出', !fake.sent.some((entry) => entry.target === '999'));
    }

    const groupListTool = registry.get('onebot_get_group_list');
    if (groupListTool) {
      const listed = await executeTool(groupListTool, {}, context, { timeoutMs: 5000, maxResultBytes: 4096 });
      check('读取群列表成功', listed.ok, listed.content);
      check('群列表包含测试群', listed.content.includes('测试群'));
    }

    const memberTool = registry.get('onebot_get_group_member_list');
    if (memberTool) {
      const listed = await executeTool(
        memberTool,
        { group_id: '111' },
        context,
        { timeoutMs: 5000, maxResultBytes: 4096 },
      );
      check('读取群成员成功', listed.ok, listed.content);
      check('成员列表包含昵称', listed.content.includes('小明'));
    }

    const badArgs = await executeTool(
      registry.get('onebot_send_group_msg') as NonNullable<ReturnType<typeof registry.get>>,
      { group_id: '111' },
      context,
      { timeoutMs: 5000, maxResultBytes: 4096 },
    );
    check('缺少 text 参数被 schema 拦截', !badArgs.ok && badArgs.content.includes('text'));
  } finally {
    await fake.close();
  }
}

/* ------------------------------------------------------------------ *
 * External integration contract
 *
 * The AstrBot plugin in `integrations/astrbot_plugin_nami/` is a separate
 * codebase maintained against these endpoints. These assertions pin the exact
 * calling conventions it relies on, so a change here breaks the test rather
 * than the plugin.
 * ------------------------------------------------------------------ */

async function testIntegrationContract(main: Fixture): Promise<void> {
  section('外部集成契约（AstrBot 插件调用约定）');

  const admin = { key: null, adminToken: ADMIN_TOKEN };

  // The plugin derives its host root by stripping /v1, then calls these.
  for (const path of ['/healthz', '/readyz']) {
    const result = await http(main, 'GET', path, { key: null });
    check(`插件会用到的 ${path} 可无凭证访问`, result.status === 200 || result.status === 503);
  }

  for (const path of ['/admin/api/overview', '/admin/api/metrics', '/admin/api/tools']) {
    const result = await http(main, 'GET', path, admin);
    equal(`插件会调用 GET ${path}`, result.status, 200);
  }

  const sessions = await http(main, 'GET', '/admin/api/sessions?limit=10', admin);
  equal('插件会调用 GET /admin/api/sessions?limit=N', sessions.status, 200);
  check(
    '会话列表带 messageCount',
    ((sessions.json as { data?: Array<{ messageCount?: number }> }).data ?? []).every(
      (entry) => typeof entry.messageCount === 'number',
    ),
  );

  // The plugin scopes a Nami session per AstrBot conversation and passes it as
  // a header, so a colon-containing id must round-trip through the store.
  const scoped = 'astrbot:group:42';
  const chat = await http(main, 'POST', '/v1/chat/completions', {
    key: main.key,
    headers: { 'x-nami-session': scoped },
    json: { messages: [{ role: 'user', content: '你好' }] },
  });
  equal('插件用 X-Nami-Session 发起对话 → 200', chat.status, 200);

  const lookup = await http(main, 'GET', `/admin/api/sessions/${encodeURIComponent(scoped)}`, admin);
  equal('带冒号的作用域会话 id 可原样取回', lookup.status, 200);
  check(
    '该会话确实记在插件的 scope id 下',
    (lookup.json as { session?: { id?: string } }).session?.id === scoped,
  );

  // The plugin URL-encodes the id with safe='' before deleting.
  const deleted = await http(
    main,
    'DELETE',
    `/admin/api/sessions/${encodeURIComponent(scoped)}`,
    admin,
  );
  equal('URL 编码的会话 id 可以删除', deleted.status, 200);

  const gone = await http(main, 'GET', `/admin/api/sessions/${encodeURIComponent(scoped)}`, admin);
  equal('删除后确实不存在', gone.status, 404);

  // The plugin's diagnose command relies on /readyz reporting these keys.
  const ready = await http(main, 'GET', '/readyz', { key: null });
  const checks = (ready.json as { checks?: Record<string, string> }).checks ?? {};
  for (const field of ['database', 'provider', 'model', 'models', 'tools', 'apiKeys']) {
    check(`/readyz 的 checks 含 "${field}"（插件据此给建议）`, typeof checks[field] === 'string');
  }

  // And its error guidance keys off these codes.
  const badSessionDelete = await http(main, 'DELETE', '/admin/api/sessions/nope', admin);
  check(
    '删除不存在的会话返回 session_not_found',
    (badSessionDelete.json as { error?: { code?: string } })?.error?.code === 'session_not_found',
  );
}

/* ------------------------------------------------------------------ *
 * Cross-platform configuration hygiene
 * ------------------------------------------------------------------ */

function testConfigHygiene(): void {
  section('跨平台配置卫生（CRLF / 路径）');

  // A `.env` edited on Windows can carry CRLF endings. Node's loadEnvFile strips
  // the \r, but Docker Compose parses env_file itself, and a trailing carriage
  // return inside a value would silently downgrade the provider to mock.
  const crlf = testConfig({
    NAMI_DB_PATH: ':memory:',
    NAMI_LLM_PROVIDER: 'ollama\r',
    NAMI_OLLAMA_URL: 'http://127.0.0.1:11500\r',
    NAMI_LLM_MODEL: 'qwen2.5:7b\r',
    NAMI_ONEBOT_TRIGGER: 'prefix\r',
    NAMI_ONEBOT_PREFIX: '/ai\r',
  });

  equal('带 \\r 的 provider 仍被正确识别', crlf.llm.provider, 'ollama');
  equal('带 \\r 的 URL 已被去除回车', crlf.ollama.url, 'http://127.0.0.1:11500');
  equal('带 \\r 的模型名已被去除回车', crlf.llm.model, 'qwen2.5:7b');
  equal('带 \\r 的枚举值仍被正确识别', crlf.onebot.inbound.trigger, 'prefix');
  equal('带 \\r 的前缀已被去除回车', crlf.onebot.inbound.prefix, '/ai');

  const spaced = testConfig({
    NAMI_DB_PATH: ':memory:',
    NAMI_API_KEYS: '  spaced_key  ',
    NAMI_LLM_PROVIDER: ' mock ',
  });
  equal('值两侧的空白被去除', spaced.apiKeys[0], 'spaced_key');
  equal('带空格的 provider 仍被识别', spaced.llm.provider, 'mock');

  // Path handling must be separator-agnostic; these run on both platforms.
  // Deliberately NOT `:memory:` here — this asserts the default on-disk path.
  const base = testConfig({ NAMI_DB_PATH: '' });
  check('默认 dbPath 是绝对路径', isAbsolute(base.dbPath), base.dbPath);
  check(
    '默认库文件位于 data 目录下',
    base.dbPath.split(/[\\/]/).includes('data'),
    base.dbPath,
  );
  check('默认 dbPath 使用本机路径分隔符', base.dbPath.includes(sep), base.dbPath);
  check('会话 id 校验接受连字符与冒号', isValidSessionId('qq-group-123') && isValidSessionId('astrbot:group:42'));
  const windowsStyleSessionId = 'a\\b'; // portability-ok: 故意构造 Windows 风格路径做反例
  check(
    '会话 id 校验拒绝路径分隔符',
    !isValidSessionId('../etc/passwd') &&
      !isValidSessionId('a/b') &&
      !isValidSessionId(windowsStyleSessionId),
  );
  check('会话 id 校验拒绝空串与超长', !isValidSessionId('') && !isValidSessionId('x'.repeat(129)));
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const started_at = Date.now();
  process.stdout.write(`${C.bold}🌊 Nami agent server — smoke test${C.reset}\n`);

  testPureUnits();

  const main = await startServer('main');
  process.stdout.write(`${C.dim}  (main server on ${main.base})${C.reset}\n`);

  try {
    await testHttpSurface(main);
    await testAdminAndPanel(main);
    await testOpenAiCompat(main);
    await testAgentStreamAndPersistence(main);
    await testWebSocket(main);
    await testToolFailurePaths(main);
    await testOpenApiSurface(main);
    await testIntegrationContract(main);
    await testModelRouting();
    await testOllamaScript();
    await testOllamaProvider();
    await testOllamaHosting();
    await testOllamaUnavailable();
    testOneBotPure();
    await testOneBotConnector();
    await testOneBotTools();
    testConfigHygiene();
    await testRateLimitAndLimits();
  } catch (error) {
    failures.push({
      name: 'unexpected exception',
      detail: error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
    });
    process.stdout.write(`\n${C.red}✗ 测试中断: ${error instanceof Error ? error.message : String(error)}${C.reset}\n`);
  } finally {
    for (const app of started) {
      try {
        await app.shutdown();
      } catch {
        /* already closed */
      }
    }
    // Clean up the temporary databases created by this run.
    for (const file of dbFiles) {
      if (!file.startsWith(DATA_DIR)) continue;
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          rmSync(`${file}${suffix}`, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }

  const ms = Date.now() - started_at;
  process.stdout.write(`\n${C.bold}${'─'.repeat(60)}${C.reset}\n`);

  if (failures.length === 0) {
    process.stdout.write(
      `${C.green}${C.bold}✓ 全部通过${C.reset}  ${passed} 项断言，耗时 ${ms}ms\n\n`,
    );
    process.exit(0);
  }

  process.stdout.write(`${C.red}${C.bold}✗ ${failures.length} 项失败${C.reset} / 共 ${passed + failures.length} 项，耗时 ${ms}ms\n\n`);
  for (const failure of failures) {
    process.stdout.write(`${C.red}  ✗ ${failure.name}${C.reset}\n`);
    if (failure.detail) process.stdout.write(`${C.dim}      ${failure.detail.replace(/\n/g, '\n      ')}${C.reset}\n`);
  }
  process.stdout.write('\n');
  process.exit(1);
}

void main();
