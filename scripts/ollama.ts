/**
 * One-click Ollama setup for Nami.
 *
 * Pure HTTP: it talks to the Ollama daemon directly, so it works even when the
 * `ollama` CLI is not on PATH. It detects the daemon, lists installed models,
 * optionally pulls one with a progress bar, and writes the matching `.env`.
 *
 *   npm run ollama                                  # detect and report
 *   npm run ollama -- --write                       # also write .env
 *   npm run ollama -- --pull qwen2.5:7b --write     # pull, then write
 *   npm run ollama -- --model llama3.1:8b --write   # pick an installed model
 *   npm run ollama -- --json                        # machine-readable
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { OllamaProvider } from '../src/llm/ollama.ts';
import type { ModelInfo } from '../src/llm/types.ts';

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

/** Models that handle tool calling well; the first is the recommended default. */
const RECOMMENDED = ['qwen2.5:7b', 'llama3.1:8b', 'mistral-nemo', 'qwen3:8b'];

interface Args {
  url: string | null;
  pull: string | null;
  model: string | null;
  write: boolean;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { url: null, pull: null, model: null, write: false, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    switch (token) {
      case '--url':
        args.url = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--pull':
        args.pull = argv[index + 1] ?? null;
        index += 1;
        break;
      case '--model':
        args.model = argv[index + 1] ?? null;
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

/**
 * Applies `key=value` updates to an existing `.env` body.
 *
 * Imported from `src/env-file.ts`, which is the single implementation shared
 * with the WebUI's config editor so the two cannot drift apart, and re-exported
 * so tests can reach it from here.
 */
import { upsertEnv } from '../src/env-file.ts';
export { upsertEnv };

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)}${units[unit]}`;
}

function describeModel(model: ModelInfo): string {
  const meta = (model.meta ?? {}) as Record<string, unknown>;
  const parts = [
    typeof meta.parameters === 'string' ? meta.parameters : null,
    typeof meta.quantization === 'string' ? meta.quantization : null,
    typeof meta.sizeBytes === 'number' ? formatBytes(meta.sizeBytes) : null,
  ].filter((part): part is string => part !== null);
  return parts.join(' · ');
}

function printHelp(): void {
  process.stdout.write(
    [
      '',
      `${c.bold}npm run ollama${c.reset} — 一键把 Nami 接到本机 Ollama`,
      '',
      '选项：',
      '  --url <url>       Ollama 地址（默认 http://127.0.0.1:11434）',
      '  --model <name>    指定默认模型（须已安装）',
      '  --pull <name>     先拉取该模型，再继续',
      '  --write           把结果写入 .env',
      '  --json            以 JSON 输出，便于脚本消费',
      '  -h, --help        显示本帮助',
      '',
      '示例：',
      `  ${c.cyan}npm run ollama -- --pull qwen2.5:7b --write${c.reset}`,
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
  const url = (args.url ?? config.ollama.url).replace(/\/+$/, '');
  const provider = new OllamaProvider({
    url,
    model: args.model ?? config.llm.model,
    timeoutMs: 60_000,
    keepAlive: config.ollama.keepAlive,
    numCtx: config.ollama.numCtx,
  });

  const emit = (payload: Record<string, unknown>, humanLines: string[]): void => {
    if (args.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`${humanLines.join('\n')}\n`);
    }
  };

  if (!args.json) {
    process.stdout.write(`\n${c.bold}🌊 Nami · Ollama 接入向导${c.reset}\n`);
    process.stdout.write(`  ${c.dim}探测${c.reset} ${url}\n\n`);
  }

  /* ---------------------------- reachability ---------------------------- */

  const version = await provider.version();
  if (version === null) {
    const cli = spawnSync('ollama', ['--version'], { stdio: 'ignore', shell: false });
    const cliPresent = cli.error === undefined && cli.status === 0;

    emit(
      {
        ok: false,
        url,
        reachable: false,
        ollamaCliFound: cliPresent,
        hint: 'Ollama 未运行或地址不正确',
      },
      [
        `${c.red}✗ 无法连接${c.reset} ${url}`,
        '',
        cliPresent
          ? `  检测到 ${c.bold}ollama${c.reset} CLI，但服务没有在跑。启动它：`
          : `  没有检测到 ${c.bold}ollama${c.reset} CLI，也没有服务在监听。`,
        '',
        `  ${c.bold}1.${c.reset} 安装 Ollama（若尚未安装）`,
        `     ${c.cyan}https://ollama.com/download${c.reset}`,
        `  ${c.bold}2.${c.reset} 启动服务`,
        `     ${c.cyan}ollama serve${c.reset}`,
        `  ${c.bold}3.${c.reset} 重新运行本向导`,
        `     ${c.cyan}npm run ollama -- --pull qwen2.5:7b --write${c.reset}`,
        '',
        `  ${c.dim}若 Ollama 跑在别的地址或端口：${c.reset}`,
        `     ${c.cyan}npm run ollama -- --url http://192.168.1.10:11434${c.reset}`,
        '',
      ],
    );
    process.exitCode = 1;
    return;
  }

  /* ------------------------------- catalog ------------------------------- */

  const before = await provider.listModelInfo();
  const installed = new Set(before.map((model) => model.id));
  const pullTarget = args.pull?.trim() || null;

  if (pullTarget && !installed.has(pullTarget)) {
    if (!args.json) process.stdout.write(`${c.bold}↓ 拉取${c.reset} ${pullTarget}\n`);
    let lastLine = '';
    try {
      await provider.pull(pullTarget, (status, completed, total) => {
        if (args.json) return;
        const ratio = total > 0 ? completed / total : 0;
        const width = 28;
        const filled = Math.round(ratio * width);
        const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
        const line =
          `  ${c.cyan}${bar}${c.reset} ${(ratio * 100).toFixed(1).padStart(5)}%  ` +
          `${formatBytes(completed)}/${formatBytes(total)}  ${c.dim}${status}${c.reset}`;
        if (line !== lastLine) {
          process.stdout.write(`\r${line}`);
          lastLine = line;
        }
      });
      if (!args.json && lastLine !== '') process.stdout.write('\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({ ok: false, url, reachable: true, error: message }, [`${c.red}✗ 拉取失败：${c.reset}${message}`, '']);
      process.exitCode = 1;
      return;
    }
  } else if (pullTarget) {
    if (!args.json) process.stdout.write(`  ${c.dim}${pullTarget} 已安装，跳过拉取。${c.reset}\n`);
  }

  const models = await provider.listModelInfo();
  const resident = await provider.runningModels();
  const residentNames = new Set(resident.map((entry) => entry.name));

  /* ------------------------------ selection ------------------------------ */

  const names = models.map((model) => model.id);
  let selected = args.model?.trim() || config.llm.model.trim();

  if (selected !== '' && !names.includes(selected)) {
    if (!args.json) {
      process.stdout.write(
        `  ${c.yellow}⚠${c.reset} 指定的模型 ${c.bold}${selected}${c.reset} 未安装（Ollama 会在首次请求时报错）。\n`,
      );
    }
  }

  if (selected === '') {
    selected = names.includes(RECOMMENDED[0] as string)
      ? (RECOMMENDED[0] as string)
      : (names[0] ?? '');
  }

  /* -------------------------------- report ------------------------------- */

  if (!args.json) {
    process.stdout.write(`${c.green}✓ 已连接${c.reset} Ollama ${c.bold}${version}${c.reset}\n\n`);

    if (models.length === 0) {
      process.stdout.write(`${c.yellow}⚠ 尚未安装任何模型。${c.reset}推荐：\n`);
      process.stdout.write(`     ${c.cyan}npm run ollama -- --pull ${RECOMMENDED[0]} --write${c.reset}\n\n`);
    } else {
      process.stdout.write(`${c.bold}已安装 ${models.length} 个模型${c.reset}\n`);
      for (const model of models) {
        const marks: string[] = [];
        if (model.id === selected) marks.push(`${c.cyan}默认${c.reset}`);
        if (residentNames.has(model.id)) marks.push(`${c.green}已载入显存${c.reset}`);
        const suffix = marks.length > 0 ? `  ${marks.join(' ')}` : '';
        process.stdout.write(`  ${c.bold}${model.id}${c.reset}  ${c.dim}${describeModel(model)}${c.reset}${suffix}\n`);
      }
      process.stdout.write('\n');
    }
  }

  /* --------------------------------- .env -------------------------------- */

  const envPath = resolve(process.cwd(), '.env');
  const updates: Record<string, string> = { NAMI_LLM_PROVIDER: 'ollama', NAMI_OLLAMA_URL: url };
  if (selected !== '') updates.NAMI_LLM_MODEL = selected;

  let written: string | null = null;
  let applied: Array<{ key: string; from: string | null; to: string }> = [];

  if (args.write && selected !== '') {
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const result = upsertEnv(existing, updates);
    writeFileSync(envPath, result.content, 'utf8');
    written = envPath;
    applied = result.applied;

    if (!args.json) {
      process.stdout.write(`${c.green}✓ 已写入${c.reset} ${envPath}\n`);
      for (const change of applied) {
        const from = change.from === null ? `${c.dim}(新增)${c.reset}` : `${c.dim}${change.from}${c.reset}`;
        process.stdout.write(`    ${change.key}: ${from} ${c.dim}→${c.reset} ${c.bold}${change.to}${c.reset}\n`);
      }
      process.stdout.write('\n');
    }
  } else if (args.write && selected === '') {
    if (!args.json) {
      process.stdout.write(
        `${c.yellow}⚠ 没有可用模型，未写入 .env。${c.reset}先拉取一个：\n` +
          `     ${c.cyan}npm run ollama -- --pull ${RECOMMENDED[0]} --write${c.reset}\n\n`,
      );
    }
    process.exitCode = 1;
  }

  emit(
    {
      ok: selected !== '',
      url,
      reachable: true,
      version,
      modelsInstalled: names,
      modelsResident: resident.map((entry) => entry.name),
      selectedModel: selected || null,
      envWritten: written,
      envChanges: applied,
    },
    args.write && selected !== ''
      ? [
          `${c.bold}下一步${c.reset}`,
          `  ${c.cyan}npm start${c.reset}`,
          '',
          `  ${c.dim}Nami 将把 Ollama 托管为 OpenAI 兼容端点，客户端只需：${c.reset}`,
          `    base_url = http://127.0.0.1:${config.port}/v1`,
          `    model    = ${selected}`,
          '',
        ]
      : [
          `${c.bold}下一步${c.reset}`,
          `  ${c.cyan}npm run ollama -- --write${c.reset}   ${c.dim}# 把上述配置写入 .env${c.reset}`,
          `  ${c.cyan}npm start${c.reset}`,
          '',
        ],
  );
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith('ollama.ts');

if (invokedDirectly) {
  void main().catch((error: unknown) => {
    process.stderr.write(`\n${c.red}✗ ${error instanceof Error ? error.message : String(error)}${c.reset}\n\n`);
    process.exit(1);
  });
}
