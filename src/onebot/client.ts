/**
 * OneBot v11 HTTP API client.
 *
 * Targets the HTTP API surface exposed by SnowLuma (default `:3000`), NapCat,
 * LLOneBot, Lagrange and friends. Only the actions Nami needs are implemented;
 * adding another is a one-line wrapper around `call()`.
 *
 * Messages are always sent in the **array segment** form rather than CQ strings,
 * so user text can never be reinterpreted as a CQ code.
 */

import type { Logger } from '../logger.ts';

/** One element of an OneBot message array. */
export interface OneBotSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface OneBotResponse<T = unknown> {
  status?: string;
  retcode?: number;
  data?: T;
  message?: string;
  wording?: string;
  echo?: unknown;
}

export interface OneBotGroup {
  group_id: number;
  group_name: string;
  member_count?: number;
  max_member_count?: number;
}

export interface OneBotGroupMember {
  user_id: number;
  nickname: string;
  card?: string;
  role?: string;
  join_time?: number;
  last_sent_time?: number;
}

export interface OneBotLoginInfo {
  user_id: number;
  nickname: string;
}

export interface OneBotStatus {
  online?: boolean;
  good?: boolean;
  stat?: Record<string, unknown>;
}

export class OneBotError extends Error {
  readonly retcode?: number;
  readonly action?: string;

  constructor(message: string, options: { retcode?: number; action?: string } = {}) {
    super(message);
    this.name = 'OneBotError';
    if (options.retcode !== undefined) this.retcode = options.retcode;
    if (options.action !== undefined) this.action = options.action;
  }
}

export function textSegment(text: string): OneBotSegment {
  return { type: 'text', data: { text } };
}

export function atSegment(qq: string | number): OneBotSegment {
  return { type: 'at', data: { qq: String(qq) } };
}

export interface OneBotClientOptions {
  url: string;
  accessToken?: string;
  timeoutMs: number;
  log: Logger;
}

export class OneBotClient {
  readonly url: string;

  private readonly accessToken: string;
  private readonly timeoutMs: number;
  private readonly log: Logger;

  constructor(options: OneBotClientOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.accessToken = options.accessToken ?? '';
    this.timeoutMs = options.timeoutMs;
    this.log = options.log;
  }

  /** True once a URL is configured; the URL always has a default, so this is
   *  really "is the connector switched on" as seen by callers. */
  get configured(): boolean {
    return this.url !== '';
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.accessToken !== '') headers.authorization = `Bearer ${this.accessToken}`;
    return headers;
  }

  /**
   * Invokes one OneBot action.
   *
   * @throws {OneBotError} on a transport failure or a non-ok `status`.
   */
  async call<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await fetch(`${this.url}/${action}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(params),
        signal: combined,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new OneBotError(
        `Cannot reach the OneBot implementation at ${this.url}: ${detail}. ` +
          'Is SnowLuma (or your OneBot server) running, and is NAMI_ONEBOT_URL correct?',
        { action },
      );
    }

    const raw = await response.text().catch(() => '');
    let payload: OneBotResponse<T>;
    try {
      payload = JSON.parse(raw) as OneBotResponse<T>;
    } catch {
      throw new OneBotError(
        `OneBot action "${action}" returned ${response.status} with a non-JSON body: ${raw.slice(0, 200)}`,
        { action },
      );
    }

    const status = payload.status ?? (response.ok ? 'ok' : 'failed');
    if (!response.ok || status === 'failed') {
      const detail = payload.wording ?? payload.message ?? `HTTP ${response.status}`;
      throw new OneBotError(`OneBot action "${action}" failed: ${detail}`, {
        action,
        ...(typeof payload.retcode === 'number' ? { retcode: payload.retcode } : {}),
      });
    }

    this.log.debug('onebot action ok', { action, retcode: payload.retcode });
    return payload.data as T;
  }

  /* ------------------------------ messaging ----------------------------- */

  async sendGroupMsg(
    groupId: string | number,
    message: OneBotSegment[] | string,
    signal?: AbortSignal,
  ): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>(
      'send_group_msg',
      { group_id: numericId(groupId), message, auto_escape: false },
      signal,
    );
  }

  async sendPrivateMsg(
    userId: string | number,
    message: OneBotSegment[] | string,
    signal?: AbortSignal,
  ): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>(
      'send_private_msg',
      { user_id: numericId(userId), message, auto_escape: false },
      signal,
    );
  }

  /* ------------------------------ discovery ----------------------------- */

  async getLoginInfo(signal?: AbortSignal): Promise<OneBotLoginInfo> {
    return this.call<OneBotLoginInfo>('get_login_info', {}, signal);
  }

  async getStatus(signal?: AbortSignal): Promise<OneBotStatus> {
    return this.call<OneBotStatus>('get_status', {}, signal);
  }

  async getVersionInfo(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>('get_version_info', {}, signal);
  }

  async getGroupList(signal?: AbortSignal): Promise<OneBotGroup[]> {
    const groups = await this.call<OneBotGroup[] | null>('get_group_list', {}, signal);
    return Array.isArray(groups) ? groups : [];
  }

  async getGroupMemberList(
    groupId: string | number,
    signal?: AbortSignal,
  ): Promise<OneBotGroupMember[]> {
    const members = await this.call<OneBotGroupMember[] | null>(
      'get_group_member_list',
      { group_id: numericId(groupId) },
      signal,
    );
    return Array.isArray(members) ? members : [];
  }

  /**
   * OneBot ids are integers, but they may arrive as strings from events. Numeric
   * QQ uins exceed 2^32 but stay well inside Number.MAX_SAFE_INTEGER.
   */
  static toNumericId(value: string | number): number {
    return numericId(value);
  }
}

function numericId(value: string | number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : (value as number);
}
