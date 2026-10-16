/**
 * One-click Our Free Model (OFM) relay setup for Nami.
 *
 * OFM (`dsh-our-free-model`) exposes the free models it can currently route as
 * an OpenAI-compatible endpoint on the local machine — `设置 → Our Free Model →
 * 本地转发`, usually `http://127.0.0.1:18899/v1`. This script probes that
 * gateway, lists the models it is offering right now, and writes the matching
 * `.env`, so Nami can host the whole catalogue as one OpenAI-compatible endpoint.
 *
 *   npm run ofm                                    # detect and report
 *   npm run ofm -- --write                         # also write .env
 *   npm run ofm -- --model deepseek-v4.1-flash --write
 *   npm run ofm -- --url http://127.0.0.1:18900 --write
 *   npm run ofm -- --key <本机 Key> --write
 *   npm run ofm -- --expose a,b --write            # also pin the allowlist
 *   npm run ofm -- --json                          # machine-readable
 *
 * It deliberately does NOT use `OpenAiProvider.listModelInfo()`, which swallows
 * discovery failures and falls back to the configured model. A wizard whose job
 * is to explain "why is the gateway not working" must see the real status code.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { upsertEnv } from '../src/env-file.ts';
export { upsertEnv };

const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const c = {
  reset: COLOR ? '\x1b[0m' : '',
  bold: COLOR ? '\x1b[1m' : '',
  dim: COLOR ? '\x1b[2m' : '',
  green: COLOR ? '\x1b[32m' : '',
  red: COLOR ? '\x1b[31m' : '',
  yellow: COLOR ? '\x1b[33m' : '',
  cyan: COLOR ? '\x1b[36m' : '',
};

export interface Args {
  url: string | null;
  key: string | null;
  model: string | null;
  expose: string | null;
  write: boolean;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: null,
    key: null,
    model: null,
    expose: null,
    write: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    switch (token) {
      case '--url':
        args.url = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--key':
        args.key = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--model':
        args.model = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--expose':
        args.expose = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--write':
        args.write = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }
  return args;
}

/** Splits a comma-separated `--expose` value, dropping empty entries. */
export function parseExpose(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/**
 * Decides which model to pin as Nami's default.
 *
 * `--model` always wins. Otherwise only an existing **ofm** configuration counts
 * as a deliberate choice: on a fresh `.env` the loaded model is merely the mock
 * provider's default (`nami-mock-1`), and writing that would both mislead the
 * operator and pin a model the gateway has never heard of. With nothing to pin,
 * Nami discovers a model at boot instead — which suits a catalogue whose free
 * lanes come and go.
 */
export function pickPinnedModel(
  configuredProvider: string,
  configuredModel: string,
  flag: string | null,
): string {
  const explicit = (flag ?? '').trim();
  if (explicit !== '') return explicit;
  return configuredProvider === 'ofm' ? configuredModel.trim() : '';
}

interface ProbeResult {
  ok: boolean;
  status?: number;
  models: string[];
  error?: string;
}

/**
 * `GET {url}/v1/models`, reporting the failure instead of hiding it.
 *
 * OFM answers 401 for the wrong key, 404 when 本地转发 is off, and refuses the
 * connection outright when it is not running — three different problems that
 * deserve three different next steps, so none of them may collapse into "no
 * models found".
 */
export async function probeGateway(
  url: string,
  apiKey: string,
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${url}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const body = await response.text().catch(() => '');
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      models: [],
      error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, status: response.status, models: [], error: '返回的不是 JSON' };
  }

  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return { ok: false, status: response.status, models: [], error: '返回里没有 data 数组' };
  }

  const models = data
    .map((entry) =>
      typeof entry === 'string'
        ? entry
        : String((entry as { id?: unknown } | null)?.id ?? ''),
    )
    .filter((id) => id !== '');

  return { ok: true, status: response.status, models };
}

/** The reason a probe failed, phrased as the next thing to do. */
function explain(probe: ProbeResult, url: string, apiKey: string): string[] {
  if (probe.status === 401 || probe.status === 403) {
    return [
      `  OFM 拒绝了鉴权。填的 Key 与网关要求的不一致：`,
      `     ${c.cyan}npm run ofm -- --key <OFM 设置页里的「本机 Key」> --write${c.reset}`,
      `  ${c.dim}注意「本机 Key」和「局域网 Key」是两个不同的值。${c.reset}`,
    ];
  }
  if (probe.status === 404) {
    return [
      `  该路径不存在。OFM 的「本地转发」可能没开，或端口顺延到了别的值：`,
      `     ${c.cyan}到 OFM 设置页复制实际的 Base URL，然后 npm run ofm -- --url <它> --write${c.reset}`,
    ];
  }
  if (probe.error !== undefined && probe.status === undefined) {
    return [
      `  连不上 ${url}。可能是 OFM 没在跑，或「本地转发」没开。`,
      '',
      `  ${c.bold}1.${c.reset} 打开 OFM，进入 ${c.bold}设置 → Our Free Model → 本地转发${c.reset} 并启用`,
      `  ${c.bold}2.${c.reset} 复制它显示的 Base URL（端口被占用时会顺延）`,
      `  ${c.bold}3.${c.reset} 重新运行`,
      `     ${c.cyan}npm run ofm -- --url <Base URL>${apiKey === '' ? ' --key <本机 Key>' : ''} --write${c.reset}`,
    ];
  }
  return [`  ${probe.error ?? '未知错误'}`];
}

function printHelp(): void {
  process.stdout.write(
    [
      '',
      `${c.bold}npm run ofm${c.reset} — 一键把 Nami 接到 dsh-our-free-model 网关（免费模型中转）`,
      '',
      '选项：',
      '  --url <url>       OFM 网关地址，不带 /v1（默认 http://127.0.0.1:18899）',
      '  --key <key>       OFM「本机 Key」；默认沿用 NAMI_LLM_API_KEY',
      '  --model <id>      指定默认模型（须在网关清单里）',
      '  --expose <a,b>    同时写入 NAMI_MODELS_EXPOSE 白名单',
      '  --write           把结果写入 .env',
      '  --json            以 JSON 输出，便于脚本消费',
      '  -h, --help        显示本帮助',
      '',
      '写完 .env 后：',
      `  ${c.cyan}npm start${c.reset}                  # Nami 把免费模型托管成 OpenAI 兼容端点`,
      `  ${c.cyan}npm run ofm -- --json${c.reset}       # 查看网关上的模型清单`,
      '',
      '把 AstrBot 接到这个中转上（默认就走中转）：',
      `  插件 ${c.cyan}astrbot_plugin_our_free_model${c.reset} 的 relay_mode=nami，`,
      `  填 Nami 的 Base URL ${c.cyan}http://127.0.0.1:8787/v1${c.reset} 与 NAMI_API_KEYS 里的任意一个 Key。`,
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = loadConfig({});
  const url = (args.url ?? config.ofm.url).replace(/\/+$/, '');
  const apiKey = (args.key ?? config.llm.apiKey).trim();

  const emit = (payload: Record<string, unknown>, humanLines: string[]): void => {
    if (args.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`${humanLines.join('\n')}\n`);
    }
  };

  if (!args.json) {
    process.stdout.write(`\n${c.bold}🐾 Nami · Our Free Model 中转向导${c.reset}\n`);
    process.stdout.write(`  ${c.dim}探测${c.reset} ${url}/v1/models\n\n`);
  }

  /* ---------------------------- reachability ---------------------------- */

  const probe = await probeGateway(url, apiKey);
  if (!probe.ok) {
    emit(
      {
        ok: false,
        url,
        reachable: false,
        status: probe.status ?? null,
        error: probe.error ?? null,
        hint: 'OFM 未运行、本地转发未开，或地址/Key 不正确',
      },
      [
        `${c.red}✗ 无法读取模型清单${c.reset} ${url}/v1/models`,
        '',
        ...explain(probe, url, apiKey),
        '',
        `  ${c.dim}如果 OFM 与 Nami 不在同一台机器上：${c.reset}`,
        `     ${c.cyan}npm run ofm -- --url http://<OFM 主机>:18899 --key <本机 Key>${c.reset}`,
        `  ${c.dim}（此时 OFM 的「局域网 Key」才可能适用，请按 OFM 设置页填写）${c.reset}`,
        '',
      ],
    );
    process.exitCode = 1;
    return;
  }

  /* ------------------------------ selection ------------------------------ */

  const models = probe.models;
  const pinned = pickPinnedModel(config.llm.provider, config.llm.model, args.model);
  const missingSelection = pinned !== '' && !models.includes(pinned);

  const expose = parseExpose(args.expose);
  const unknownExposed = expose.filter((name) => !models.includes(name));
  const sample = pinned !== '' && models.includes(pinned) ? pinned : (models[0] ?? '');

  /* -------------------------------- report ------------------------------- */

  if (!args.json) {
    process.stdout.write(`${c.green}✓ 已连接${c.reset} OFM 网关，鉴权${apiKey === '' ? `${c.yellow}未配置 Key${c.reset}` : '通过'}\n\n`);

    if (models.length === 0) {
      process.stdout.write(
        `${c.yellow}⚠ 网关当前没有可路由的免费模型。${c.reset}上游车道可能都在排队或不可用；` +
          `稍后重试，或检查 OFM 自身的连接。\n\n`,
      );
    } else {
      process.stdout.write(`${c.bold}网关当前提供 ${models.length} 个模型${c.reset}\n`);
      for (const model of models) {
        const marks: string[] = [];
        if (model === pinned) marks.push(`${c.cyan}已写为默认${c.reset}`);
        if (expose.includes(model)) marks.push(`${c.green}已加白名单${c.reset}`);
        process.stdout.write(
          `  ${c.bold}${model}${c.reset}${marks.length > 0 ? `  ${marks.join(' ')}` : ''}\n`,
        );
      }
      process.stdout.write('\n');
      if (pinned === '') {
        process.stdout.write(
          `  ${c.dim}未固定默认模型：Nami 启动时会自动采用清单里的第一个。免费车道会变，跟随比钉死更稳；` +
            `想钉死就加 --model。${c.reset}\n\n`,
        );
      }
    }

    if (missingSelection) {
      process.stdout.write(
        `  ${c.yellow}⚠${c.reset} 指定的模型 ${c.bold}${pinned}${c.reset} 当前不在网关清单里。` +
          `免费车道会随上游变化，仍然照写；请求时若它已下线，Nami 会返回 404。\n\n`,
      );
    }
    for (const name of unknownExposed) {
      process.stdout.write(
        `  ${c.yellow}⚠${c.reset} 白名单里的 ${c.bold}${name}${c.reset} 不在网关清单里。\n`,
      );
    }
  }

  /* --------------------------------- .env -------------------------------- */

  const envPath = resolve(process.cwd(), '.env');
  const updates: Record<string, string> = { NAMI_LLM_PROVIDER: 'ofm', NAMI_OFM_URL: url };
  if (pinned !== '') updates.NAMI_LLM_MODEL = pinned;
  // Never write an empty key over a configured one: --write is often re-run just
  // to refresh the address, and silently clearing the credential would lock the
  // relay out of its own gateway.
  if (apiKey !== '') updates.NAMI_LLM_API_KEY = apiKey;
  if (expose.length > 0) updates.NAMI_MODELS_EXPOSE = expose.join(',');

  let written: string | null = null;
  let applied: Array<{ key: string; from: string | null; to: string }> = [];

  if (args.write) {
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const result = upsertEnv(existing, updates);
    writeFileSync(envPath, result.content, 'utf8');
    written = envPath;
    applied = result.applied;

    if (!args.json) {
      process.stdout.write(`${c.green}✓ 已写入${c.reset} ${envPath}\n`);
      for (const change of applied) {
        const from = change.from === null ? `${c.dim}(新增)${c.reset}` : `${c.dim}${change.from}${c.reset}`;
        const to = change.key === 'NAMI_LLM_API_KEY' ? '***' : change.to;
        process.stdout.write(`    ${change.key}: ${from} ${c.dim}→${c.reset} ${c.bold}${to}${c.reset}\n`);
      }
      if (apiKey === '') {
        process.stdout.write(
          `    ${c.yellow}NAMI_LLM_API_KEY 为空，未写入${c.reset} ${c.dim}（网关要求鉴权时请用 --key 指定本机 Key）${c.reset}\n`,
        );
      }
      process.stdout.write('\n');
    }
  }

  const nextSteps =
    args.write && models.length > 0
      ? [
          `${c.bold}下一步${c.reset}`,
          `  ${c.cyan}npm start${c.reset}`,
          '',
          `  ${c.dim}Nami 会把网关上的免费模型托管为 OpenAI 兼容端点：${c.reset}`,
          `    base_url = http://127.0.0.1:${config.port}/v1`,
          `    api_key  = <NAMI_API_KEYS 里的任意一个>`,
          pinned !== ''
            ? `    model    = ${pinned}   ${c.dim}（已写为默认；/v1/models 里还有 ${Math.max(0, models.length - 1)} 个）${c.reset}`
            : `    model    = ${sample}   ${c.dim}（启动时自动选第一个；/v1/models 里共 ${models.length} 个）${c.reset}`,
          '',
          `  ${c.dim}AstrBot 侧：用 astrbot_plugin_our_free_model，relay_mode=nami 即走这个中转。${c.reset}`,
          '',
        ]
      : [
          `${c.bold}下一步${c.reset}`,
          `  ${c.cyan}npm run ofm -- --write${c.reset}   ${c.dim}# 把上述配置写入 .env${c.reset}`,
          `  ${c.cyan}npm start${c.reset}`,
          '',
        ];

  emit(
    {
      ok: models.length > 0,
      url,
      reachable: true,
      keyConfigured: apiKey !== '',
      models,
      selectedModel: pinned !== '' ? pinned : null,
      autoDiscoverModel: pinned === '',
      selectedMissing: missingSelection,
      expose,
      unknownExposed,
      envWritten: written,
      envChanges: applied,
    },
    nextSteps,
  );
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith('ofm.ts');

if (invokedDirectly) {
  void main().catch((error: unknown) => {
    process.stderr.write(`\n${c.red}✗ ${error instanceof Error ? error.message : String(error)}${c.reset}\n\n`);
    process.exit(1);
  });
}
