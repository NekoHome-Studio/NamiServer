/**
 * Nami agent server — entry point.
 *
 * Boots storage, the tool registry, the LLM adapter, the model catalogue and
 * the HTTP/WebSocket server, then installs signal handlers for a graceful
 * shutdown.
 */

import type { AppDeps } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import { createProvider, ModelRouter, OllamaProvider } from './llm/index.ts';
import { createLogger, type Logger } from './logger.ts';
import { Metrics } from './metrics.ts';
import { OneBotBridge } from './onebot/bridge.ts';
import { OneBotClient } from './onebot/client.ts';
import { RateLimiter } from './ratelimit.ts';
import { createNamiServer, type NamiServer } from './server.ts';
import { openDatabase } from './store/db.ts';
import { SessionStore } from './store/store.ts';
import { buildBuiltinTools } from './tools/builtin/index.ts';
import { ToolRegistry } from './tools/registry.ts';

export interface BootstrappedServer {
  deps: AppDeps;
  nami: NamiServer;
  store: SessionStore;
  shutdown(): Promise<void>;
}

/**
 * Wires every layer together without starting the listener.
 *
 * Asynchronous because the model catalogue is probed up front: a one-click
 * Ollama setup is only convincing if the boot log says whether the connection
 * actually worked, rather than failing on the first chat request.
 */
export async function bootstrap(config: Config): Promise<BootstrappedServer> {
  const log = createLogger(
    { scope: 'nami' },
    {
      level: config.logLevel,
      format: config.logFormat,
      color: config.logFormat === 'pretty' && process.stdout.isTTY === true,
    },
  );

  const db = openDatabase(config.dbPath);
  const store = new SessionStore(db);

  const reaped = store.reapStaleRuns();
  if (reaped > 0) {
    log.warn('marked runs interrupted by a previous shutdown as failed', { count: reaped });
  }

  const provider = createProvider(config, log.child({ scope: 'llm' }));
  const metrics = new Metrics();
  const limiter = new RateLimiter(config.rateLimit);

  // The OneBot client is built before the tool registry, because the QQ tools
  // close over it. It always exists; `config.onebot.enabled` gates its use.
  const onebotLog = log.child({ scope: 'onebot' });
  const onebotClient = new OneBotClient({
    url: config.onebot.url,
    accessToken: config.onebot.accessToken,
    timeoutMs: config.onebot.timeoutMs,
    log: onebotLog,
  });

  const registry = new ToolRegistry(log.child({ scope: 'tools' }));
  registry.registerAll(buildBuiltinTools(config, { onebot: onebotClient }));

  const onebotBridge = new OneBotBridge({
    config,
    log: onebotLog,
    client: onebotClient,
    store,
    registry,
    provider,
    metrics,
  });

  const models = new ModelRouter({ provider, config, log: log.child({ scope: 'models' }) });

  // Probe before serving. `refresh` never throws.
  await models.refresh(true);

  if (provider.model === '') {
    const discovered = models.defaultModel;
    if (discovered !== '') {
      provider.setDefaultModel(discovered);
      log.info('adopted a discovered model', { model: discovered });
    }
  }

  if (provider instanceof OllamaProvider) {
    const version = await provider.version();
    if (version === null) {
      log.error('Ollama is not reachable — chat requests will fail', {
        url: config.ollama.url,
        hint: 'start it with `ollama serve`, then run `npm run ollama` to verify and pick a model',
      });
    } else {
      const running = await provider.runningModels();
      log.info('connected to Ollama', {
        url: config.ollama.url,
        version,
        modelsInstalled: models.discovered.length,
        modelsResident: running.map((entry) => entry.name).join(', ') || '(none loaded)',
      });
      if (models.discovered.length === 0) {
        log.warn('Ollama has no models installed', {
          hint: 'run `npm run ollama -- --pull qwen2.5:7b`, or `ollama pull qwen2.5:7b`',
        });
      }
    }
  }

  if (config.onebot.enabled) {
    try {
      const [login, status] = await Promise.all([
        onebotClient.getLoginInfo(),
        onebotClient.getStatus().catch(() => null),
      ]);
      onebotLog.info('connected to OneBot', {
        url: config.onebot.url,
        account: `${login.nickname} (${login.user_id})`,
        online: status?.online ?? null,
      });
    } catch (error) {
      onebotLog.error('OneBot is not reachable — QQ bridging will fail', {
        url: config.onebot.url,
        error: error instanceof Error ? error.message : String(error),
        hint: 'start SnowLuma (default HTTP API on port 3000), then check NAMI_ONEBOT_URL',
      });
    }

    if (config.onebot.inbound.enabled && config.onebot.eventToken === '') {
      onebotLog.warn(
        'inbound QQ reports will be refused: set NAMI_ONEBOT_EVENT_TOKEN and use the same ' +
          'value as the report secret, otherwise POST /onebot/event is an open model-billing trigger',
      );
    }
    if (
      config.onebot.tools.enabled &&
      config.onebot.tools.allowGroups.length === 0 &&
      config.onebot.tools.allowUsers.length === 0
    ) {
      onebotLog.warn(
        'outbound QQ send tools stay disabled: set NAMI_ONEBOT_TOOL_ALLOW_GROUPS ' +
          'and/or NAMI_ONEBOT_TOOL_ALLOW_USERS to name the allowed targets',
      );
    }
  }

  const deps: AppDeps = {
    config,
    log,
    store,
    registry,
    provider,
    models,
    limiter,
    metrics,
    onebotClient,
    onebotBridge,
    startedAt: Date.now(),
  };

  const nami = createNamiServer(deps);

  // Reap idle rate-limit buckets so a long-running server does not leak them.
  const sweeper = setInterval(() => limiter.sweep(), 5 * 60_000);
  sweeper.unref();

  // Keep the catalogue reasonably fresh without probing on every request.
  const catalogue = setInterval(
    () => void models.refresh(),
    Math.max(30_000, config.models.cacheTtlMs),
  );
  catalogue.unref();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(sweeper);
    clearInterval(catalogue);
    await nami.close();
    store.close();
  };

  return { deps, nami, store, shutdown };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { deps, nami, shutdown } = await bootstrap(config);
  const { log, store } = deps;

  await new Promise<void>((resolve, reject) => {
    nami.server.once('error', reject);
    nami.server.listen(config.port, config.host, () => {
      nami.server.removeListener('error', reject);
      resolve();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      log.error(`port ${config.port} is already in use`, {
        hint: 'set NAMI_PORT to a free port, or stop the process using it',
      });
    } else {
      log.error('failed to start the listener', { error: error.message, code: error.code });
    }
    process.exit(1);
  });

  printBanner(config, deps);

  let shuttingDown = false;
  const onSignal = (signal: string): void => {
    if (shuttingDown) {
      log.warn('second signal received, exiting immediately', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    log.info('shutting down', { signal, graceMs: config.shutdownGraceMs });

    const force = setTimeout(() => {
      log.warn('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownGraceMs);
    force.unref();

    void shutdown().then(() => {
      clearTimeout(force);
      log.info('shutdown complete', { sessions: store.counts().sessions });
      process.exit(0);
    });
  };

  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  process.on('uncaughtException', (error) => {
    log.error('uncaught exception, shutting down', { error: error.message, stack: error.stack });
    void shutdown().finally(() => process.exit(1));
  });
}

function printBanner(config: Config, deps: AppDeps): void {
  const { log, registry, provider, store, models } = deps;
  const base = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  const pretty = config.logFormat === 'pretty';
  const bold = pretty ? '\x1b[1m' : '';
  const dim = pretty ? '\x1b[2m' : '';
  const cyan = pretty ? '\x1b[36m' : '';
  const yellow = pretty ? '\x1b[33m' : '';
  const red = pretty ? '\x1b[31m' : '';
  const reset = pretty ? '\x1b[0m' : '';

  const line = (label: string, value: string): string =>
    `  ${dim}${label.padEnd(12)}${reset}${value}`;

  const defaultModel = models.defaultModel;
  const exposed = models.exposedNames();

  const rows = [
    line('listening', `${cyan}${base}${reset}`),
    line('admin panel', `${cyan}${base}/admin${reset}`),
    line('api docs', `${cyan}${base}/docs${reset}`),
    line(
      'provider',
      `${provider.id} ${dim}(${config.llm.provider === 'ollama' ? config.ollama.url : config.llm.baseUrl})${reset}`,
    ),
    line(
      'model',
      defaultModel === ''
        ? `${red}(none available)${reset}`
        : `${defaultModel}${exposed.length > 1 ? ` ${dim}+${exposed.length - 1} more selectable${reset}` : ''}`,
    ),
    line('tools', `${registry.enabled().length} enabled / ${registry.size} registered`),
    line('database', `${config.dbPath} ${dim}(${store.counts().sessions} sessions)${reset}`),
    line(
      'rate limit',
      config.rateLimit.enabled
        ? `${config.rateLimit.capacity} burst, ${config.rateLimit.refillPerSecond}/s`
        : 'disabled',
    ),
  ];

  if (config.onebot.enabled) {
    const ob = config.onebot;
    const sendingOn = ob.tools.enabled && (ob.tools.allowGroups.length > 0 || ob.tools.allowUsers.length > 0);
    const inboundOn = ob.inbound.enabled && ob.eventToken !== '';
    rows.push(
      line(
        'onebot',
        `${ob.url} ${dim}(inbound ${inboundOn ? ob.inbound.trigger : 'off'}, send ${sendingOn ? 'on' : 'off'})${reset}`,
      ),
    );
  }

  const lines = [
    '',
    `${bold}🌊 Nami agent server${reset} ${dim}v${config.version}${reset}`,
    ...rows,
  ];

  if (config.generatedKey) {
    lines.push(
      '',
      `  ${yellow}⚠  NAMI_API_KEYS was not set, so a key was generated for this run:${reset}`,
      `     ${bold}${config.generatedKey}${reset}`,
      `  ${dim}   It changes on every restart. Set NAMI_API_KEYS to keep it stable.${reset}`,
    );
  }

  if (config.llm.provider === 'ollama') {
    if (defaultModel === '') {
      lines.push(
        '',
        `  ${red}Ollama has no usable model.${reset} Run:`,
        `     ${bold}npm run ollama -- --pull qwen2.5:7b${reset}`,
      );
    } else {
      lines.push(
        '',
        `  ${dim}OpenAI-compatible endpoint — point any client at ${reset}${cyan}${base}/v1${reset}${dim}:${reset}`,
        `     ${dim}base_url=${reset}${base}/v1  ${dim}api_key=${reset}${config.apiKeys[0] ? '(your NAMI_API_KEYS value)' : 'any'}`,
      );
    }
  } else if (provider.id === 'mock') {
    lines.push(
      '',
      `  ${dim}Offline mock model. For a local model run ${reset}${bold}npm run ollama${reset}`,
      `  ${dim}For a hosted API set NAMI_LLM_PROVIDER=openai plus NAMI_LLM_BASE_URL / API_KEY / MODEL.${reset}`,
    );
  }

  lines.push('');
  process.stdout.write(`${lines.join('\n')}\n`);

  void log;
}

// Only start when executed directly, so tests can import `bootstrap`.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (invokedDirectly) {
  void main();
}
