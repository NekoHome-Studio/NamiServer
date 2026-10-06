/**
 * Shared dependency container handed to every route module.
 */

import type { Config } from './config.ts';
import type { Logger } from './logger.ts';
import type { LogBus } from './logbus.ts';
import type { LLMProvider } from './llm/types.ts';
import type { ModelRouter } from './llm/router.ts';
import type { Metrics } from './metrics.ts';
import type { OneBotBridge } from './onebot/bridge.ts';
import type { OneBotClient } from './onebot/client.ts';
import type { RateLimiter } from './ratelimit.ts';
import type { SessionStore } from './store/store.ts';
import type { ToolRegistry } from './tools/registry.ts';

export interface AppDeps {
  config: Config;
  log: Logger;
  /** Ring buffer of recent log entries, tailed by the WebUI. */
  logs: LogBus;
  store: SessionStore;
  registry: ToolRegistry;
  provider: LLMProvider;
  /** Model catalogue plus per-request routing and exposure policy. */
  models: ModelRouter;
  limiter: RateLimiter;
  metrics: Metrics;
  /** OneBot v11 HTTP client. Always present; `config.onebot.enabled` gates use. */
  onebotClient: OneBotClient;
  /** Inbound QQ bridge, also the source of the connector's counters. */
  onebotBridge: OneBotBridge;
  /**
   * Result of the first-boot console-account seeding.
   *
   * Carried here so the startup banner can print a generated password exactly
   * once. The plain-text value never reaches the database, the log buffer, or
   * disk — the banner writes straight to stdout.
   */
  consoleAccount?: ConsoleAccountSeed;
  /** Epoch ms when the process finished booting. */
  startedAt: number;
}

/** What the first-boot console-account seeding did. */
export interface ConsoleAccountSeed {
  /** True when this boot created the account (false when one already existed). */
  created: boolean;
  username: string;
  /** Non-null only when Nami had to invent a password; shown once, never stored. */
  generatedPassword: string | null;
  /** Set when an operator-supplied password was rejected by the policy. */
  rejectedReason: string | null;
}
