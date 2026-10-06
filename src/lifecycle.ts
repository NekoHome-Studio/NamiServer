/**
 * In-place lifecycle: rebuild the server from a freshly read configuration
 * without exiting the process.
 *
 * Why in place rather than `process.exit()`: Nami is often run by hand
 * (`npm start`), by a bare `node`, or by a supervisor that is not configured to
 * restart it. An "exit and hope something brings me back" restart button is a
 * button that can take the service down for good. This keeps the process alive
 * and swaps its innards, so the only way a restart can fail is a bad value, and
 * that case is handled explicitly.
 *
 * The ordering is the safety property, and it is deliberate:
 *
 *   1. Read the new configuration and **build the whole replacement first**,
 *      while the current instance keeps serving. A typo in `.env` therefore
 *      cannot take the console down — the reload is refused and the operator is
 *      told why, with the old configuration still running.
 *   2. Only then touch the listener. If `NAMI_HOST`/`NAMI_PORT` changed, the new
 *      listener is bound *before* the old one closes (both can coexist because
 *      the addresses differ). If the address is unchanged they cannot coexist,
 *      so the old listener closes first and there is a sub-second gap.
 *   3. Tear the old instance down last.
 */

import type { Server } from 'node:http';
import type { BootstrappedServer } from './index.ts';
import type { RestartResult } from './app.ts';
import type { Config, LoadConfigOptions } from './config.ts';
import type { LogEntry } from './logbus.ts';

/** One live server instance: its configuration and everything built from it. */
export interface Instance {
  config: Config;
  app: BootstrappedServer;
}

/** The most recent reload attempt, kept process-wide. */
export interface ReloadRecord {
  at: number;
  reason: string;
  ok: boolean;
  addressChanged: boolean;
  error?: string;
}

/*
 * Deliberately module-level rather than per-instance.
 *
 * A reload replaces the instance — and with it `deps`, the log bus and the
 * router — so an outcome stored on the instance would be erased by the very
 * reload that produced it, and the console asking "did that work?" would always
 * be told "nothing has happened yet".
 */
let lastReload: ReloadRecord | null = null;

/** True while a reload is in flight. Also module-level, for the same reason. */
let reloadInProgress = false;

/** The last reload attempt, or null when the process has not reloaded yet. */
export function lastReloadResult(): ReloadRecord | null {
  return lastReload;
}

function recordReload(record: ReloadRecord): void {
  lastReload = record;
}

/** Whether a reload is running right now. */
export function restartInProgress(): boolean {
  return reloadInProgress;
}

export interface LifecycleOptions {
  /**
   * Builds an instance from a configuration. Injectable so tests can drive the
   * swap without standing up a second real server.
   */
  boot: (
    config: Config,
    seedLogs?: LogEntry[],
    startedAt?: number,
  ) => Promise<BootstrappedServer>;
  /** Reads configuration, with `reload: true` on every reload. */
  load: (options?: LoadConfigOptions) => Config;
  /** Called after a successful swap, e.g. to re-arm a file watcher. */
  onReload?: (instance: Instance) => void;
}

/** Binds a listener, rejecting (rather than exiting) when it cannot. */
async function bind(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Stops accepting connections and drops the ones still open.
 *
 * `close()` alone only stops accepting: a keep-alive socket would hold the port
 * for up to `keepAliveTimeout` (65s here), which would turn a "restart" into a
 * minute of refused connections on the same address.
 */
async function unbind(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

export class Lifecycle {
  private instance: Instance;

  private readonly options: LifecycleOptions;

  private restarting = false;

  /** When the *process* started; a reload preserves it. */
  private readonly startedAt: number;

  constructor(initial: Instance, options: LifecycleOptions) {
    this.instance = initial;
    this.options = options;
    this.startedAt = initial.app.deps.startedAt;
  }

  /** The instance currently serving. */
  current(): Instance {
    return this.instance;
  }

  /** True while a reload is in flight, so the console can say "please wait". */
  isRestarting(): boolean {
    return this.restarting;
  }

  /** Binds the initial listener, throwing when the address is unusable. */
  async start(): Promise<void> {
    await bind(this.instance.app.nami.server, this.instance.config.port, this.instance.config.host);
  }

  /**
   * Rebuilds from `.env` and swaps it in.
   *
   * Never throws: every failure is reported as `{ ok: false, error }` with the
   * previous instance still serving, because the caller is usually an HTTP
   * handler whose only job is to tell the operator what happened.
   */
  async restart(reason: string): Promise<RestartResult> {
    const previous = this.instance;

    if (this.restarting) {
      return { ok: false, addressChanged: false, error: 'a reload is already in progress' };
    }
    this.restarting = true;
    reloadInProgress = true;

    try {
      let next: Instance;
      try {
        const config = this.options.load({ reload: true });
        const app = await this.options.boot(
          config,
          previous.app.deps.logs.snapshot(),
          this.startedAt,
        );
        next = { config, app };
        // Reachable before the swap so an immediate request cannot miss it.
        app.deps.restart = (why: string) => this.restart(why);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        previous.app.deps.log.error('reload refused: the new configuration failed to start', {
          reason,
          error: message,
          hint: 'the previous configuration is still serving — fix .env and save again',
        });
        recordReload({ at: Date.now(), reason, ok: false, addressChanged: false, error: message });
        return { ok: false, addressChanged: false, error: message };
      }

      const addressChanged =
        next.config.host !== previous.config.host || next.config.port !== previous.config.port;

      if (addressChanged) {
        try {
          await bind(next.app.nami.server, next.config.port, next.config.host);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          next.app.deps.log.error('reload refused: the new address could not be bound', {
            host: next.config.host,
            port: next.config.port,
            error: message,
          });
          // The half-built instance never served anything; drop it quietly.
          await next.app.shutdown().catch(() => undefined);
          recordReload({ at: Date.now(), reason, ok: false, addressChanged, error: message });
          return { ok: false, addressChanged, error: message };
        }
        await unbind(previous.app.nami.server);
      } else {
        await unbind(previous.app.nami.server);
        await bind(next.app.nami.server, next.config.port, next.config.host);
      }

      this.instance = next;
      this.options.onReload?.(next);

      // Only now is the old instance disposable.
      await previous.app.shutdown().catch((error: unknown) => {
        next.app.deps.log.warn('the previous instance did not shut down cleanly', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

      next.app.deps.log.info('configuration reloaded', {
        reason,
        addressChanged,
        host: next.config.host,
        port: next.config.port,
      });
      if (addressChanged) {
        next.app.deps.log.warn('the listener moved; reconnect on the new address', {
          from: `http://${previous.config.host}:${previous.config.port}`,
          to: `http://${next.config.host}:${next.config.port}`,
        });
      }
      recordReload({ at: Date.now(), reason, ok: true, addressChanged });
      return { ok: true, addressChanged };
    } finally {
      this.restarting = false;
      reloadInProgress = false;
    }
  }

  /** Stops the current instance. */
  async stop(): Promise<void> {
    await unbind(this.instance.app.nami.server);
    await this.instance.app.shutdown();
  }
}
