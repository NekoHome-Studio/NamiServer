/**
 * Model catalogue and per-request routing.
 *
 * This is what turns Nami from "a server with one configured model" into a
 * host: clients name a model exactly like they would against OpenAI, and the
 * router decides what that name means, whether it is allowed, and which
 * upstream model actually serves the request.
 *
 * Three policies apply, in order:
 *   1. `NAMI_ALLOW_CLIENT_MODEL=false` pins every request to the default model.
 *   2. `NAMI_MODEL_ALIASES` rewrites client-facing names to real upstream ids,
 *      so a tool hardcoding `gpt-4o-mini` can be pointed at a local model.
 *   3. `NAMI_MODELS_EXPOSE` is an allowlist of client-facing names.
 *
 * Discovery failures never block traffic: if the upstream cannot be probed, the
 * router passes the requested name through instead of rejecting it.
 */

import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { LLMProvider, ModelInfo } from './types.ts';

export interface ModelEntry extends ModelInfo {
  /** Client-facing names that resolve to this model. */
  aliases: string[];
  /** Whether clients may select it, given NAMI_MODELS_EXPOSE. */
  exposed: boolean;
  /** True for the model used when a request omits `model`. */
  isDefault: boolean;
}

export type Resolution =
  | { ok: true; model: string; requested?: string; aliased: boolean }
  | { ok: false; code: 'model_not_found' | 'model_not_allowed'; message: string };

export interface ModelRouterDeps {
  provider: LLMProvider;
  config: Config;
  log: Logger;
}

export class ModelRouter {
  private readonly provider: LLMProvider;
  private readonly config: Config;
  private readonly log: Logger;

  private cache: ModelInfo[] = [];
  private fetchedAt = 0;
  private discoveryError: string | null = null;
  private inflight: Promise<ModelInfo[]> | null = null;

  constructor(deps: ModelRouterDeps) {
    this.provider = deps.provider;
    this.config = deps.config;
    this.log = deps.log;
  }

  /** Model used when a request names none. */
  get defaultModel(): string {
    const configured = this.config.llm.model.trim();
    if (configured !== '') return configured;
    return this.cache[0]?.id ?? '';
  }

  get discovered(): ModelInfo[] {
    return this.cache;
  }

  get lastError(): string | null {
    return this.discoveryError;
  }

  /** True once a probe has succeeded, meaning the cache reflects reality. */
  get discoveryOk(): boolean {
    return this.fetchedAt > 0 && this.discoveryError === null;
  }

  private get stale(): boolean {
    return Date.now() - this.fetchedAt > this.config.models.cacheTtlMs;
  }

  /** Refreshes the catalogue. Never throws; concurrent calls share one probe. */
  async refresh(force = false): Promise<ModelInfo[]> {
    if (!force && !this.stale && this.cache.length > 0) return this.cache;
    if (this.inflight) return this.inflight;

    this.inflight = (async (): Promise<ModelInfo[]> => {
      try {
        const models = await this.provider.listModelInfo();
        this.cache = models;
        this.discoveryError = null;
        return models;
      } catch (error) {
        this.discoveryError = error instanceof Error ? error.message : String(error);
        this.log.warn('model discovery failed; requests will be forwarded unverified', {
          provider: this.provider.id,
          error: this.discoveryError,
        });
        return this.cache;
      } finally {
        // Recorded even on failure so a dead upstream is not probed per request.
        this.fetchedAt = Date.now();
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  private isExposed(modelId: string, aliasNames: string[]): boolean {
    const expose = this.config.models.expose;
    if (expose.length === 0) return true;
    return expose.includes(modelId) || aliasNames.some((name) => expose.includes(name));
  }

  /** Full catalogue annotated with aliases and exposure, for the admin panel. */
  describe(): ModelEntry[] {
    const aliasesByTarget = new Map<string, string[]>();
    for (const [name, target] of Object.entries(this.config.models.aliases)) {
      const list = aliasesByTarget.get(target) ?? [];
      list.push(name);
      aliasesByTarget.set(target, list);
    }

    const defaultModel = this.defaultModel;
    const entries: ModelEntry[] = [];
    const seen = new Set<string>();

    for (const info of this.cache) {
      const names = aliasesByTarget.get(info.id) ?? [];
      entries.push({
        ...info,
        aliases: names,
        exposed: this.isExposed(info.id, names),
        isDefault: info.id === defaultModel,
      });
      seen.add(info.id);
    }

    // Surface alias targets that are not installed upstream, so a typo in
    // NAMI_MODEL_ALIASES is visible rather than silently failing at request time.
    for (const [name, target] of Object.entries(this.config.models.aliases)) {
      if (seen.has(target)) continue;
      entries.push({
        id: target,
        ownedBy: this.provider.id,
        aliases: [name],
        exposed: this.isExposed(target, [name]),
        isDefault: target === defaultModel,
        meta: { notInstalled: true },
      });
      seen.add(target);
    }

    return entries;
  }

  /**
   * OpenAI-shaped catalogue of names a client may pass as `model`.
   *
   * With an allowlist configured, only explicitly exposed names are emitted —
   * otherwise setting `NAMI_MODELS_EXPOSE=gpt-4o-mini` would still leak the
   * upstream id it aliases to.
   */
  listForApi(): ModelInfo[] {
    const expose = this.config.models.expose;
    const allowlisted = expose.length > 0;
    const out: ModelInfo[] = [];

    for (const entry of this.describe()) {
      if (!entry.exposed) continue;

      if (!allowlisted || expose.includes(entry.id)) {
        out.push({
          id: entry.id,
          ownedBy: entry.ownedBy,
          created: entry.created,
          meta: entry.meta,
        });
      }

      for (const alias of entry.aliases) {
        if (allowlisted && !expose.includes(alias)) continue;
        out.push({
          id: alias,
          ownedBy: entry.ownedBy,
          created: entry.created,
          meta: { ...(entry.meta ?? {}), aliasOf: entry.id },
        });
      }
    }

    // Never hand back an empty catalogue when a default model is known.
    if (out.length === 0 && !allowlisted) {
      const fallback = this.defaultModel;
      if (fallback !== '') out.push({ id: fallback, ownedBy: this.provider.id });
    }

    return out;
  }

  exposedNames(): string[] {
    return this.listForApi().map((model) => model.id);
  }

  /** Maps a client-supplied model name onto a concrete upstream model. */
  resolve(requested?: string): Resolution {
    const fallback = this.defaultModel;
    const asked = (requested ?? '').trim();

    if (!this.config.models.allowClientModel || asked === '') {
      if (fallback === '') {
        return {
          ok: false,
          code: 'model_not_found',
          message:
            'No model is configured and none could be discovered. ' +
            'Set NAMI_LLM_MODEL, or run `npm run ollama` to install and select one.',
        };
      }
      return asked === ''
        ? { ok: true, model: fallback, aliased: false }
        : { ok: true, model: fallback, requested: asked, aliased: false };
    }

    const expose = this.config.models.expose;
    if (expose.length > 0 && !expose.includes(asked)) {
      return {
        ok: false,
        code: 'model_not_allowed',
        message:
          `Model "${asked}" is not exposed by this server. ` +
          `Available: ${this.exposedNames().join(', ') || '(none)'}.`,
      };
    }

    const aliasTarget = this.config.models.aliases[asked];
    const resolved = aliasTarget ?? asked;

    // Only enforce existence when discovery actually succeeded; a failed probe
    // must not turn into a blanket outage.
    if (this.discoveryOk && this.cache.length > 0 && !this.cache.some((m) => m.id === resolved)) {
      return {
        ok: false,
        code: 'model_not_found',
        message:
          `Model "${asked}" does not exist on this server. ` +
          `Available: ${this.exposedNames().join(', ') || '(none)'}.`,
      };
    }

    return {
      ok: true,
      model: resolved,
      requested: asked,
      aliased: aliasTarget !== undefined,
    };
  }
}
