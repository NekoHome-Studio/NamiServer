/**
 * OneBot v11 inbound bridge.
 *
 * Turns QQ group/private messages into agent runs and posts the answer back
 * through the OneBot HTTP API.
 *
 * The filter in `decideEvent` is a pure function on purpose: deciding whether to
 * spend model tokens must be testable and auditable without a running bot, since
 * a mistake there is either a silent bot or a runaway bill.
 */

import type { Config } from '../config.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { LLMProvider } from '../llm/types.ts';
import type { SessionStore } from '../store/store.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import { runAgent } from '../core/agent.ts';
import type { OneBotSegment } from './client.ts';
import { OneBotClient, atSegment, textSegment } from './client.ts';

/* ------------------------------------------------------------------ *
 * Event shape
 * ------------------------------------------------------------------ */

export interface OneBotEvent {
  time?: number;
  self_id?: number;
  /** `message` for a real message; `message_sent` is the bot's own echo. */
  post_type?: string;
  message_type?: string;
  sub_type?: string;
  message_id?: number;
  group_id?: number;
  user_id?: number;
  raw_message?: string;
  message?: string | OneBotSegment[];
  sender?: { user_id?: number; nickname?: string; card?: string; role?: string };
  meta_event_type?: string;
  notice_type?: string;
  request_type?: string;
}

export type BridgeReason =
  | 'handled'
  | 'not-message'
  | 'from-self'
  | 'empty'
  | 'no-trigger'
  | 'group-not-allowed'
  | 'user-not-allowed';

export interface BridgeDecision {
  handled: boolean;
  reason: BridgeReason;
  /** Prompt text, with any trigger prefix already removed. */
  text: string;
  sessionId: string;
  target: { kind: 'group' | 'private'; id: string } | null;
  senderId: string;
  senderName: string;
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

const CQ_CODE = /\[CQ:[^\]]*\]/g;

/**
 * Flattens an OneBot message into text, and reports whether the bot itself was
 * @-mentioned. Handles both the array form and the raw CQ-string form.
 */
export function extractMessage(
  event: OneBotEvent,
  selfId: string,
): { text: string; mentionedSelf: boolean } {
  const raw = event.message;
  let mentionedSelf = false;
  let text = '';

  if (Array.isArray(raw)) {
    for (const segment of raw) {
      if (!segment || typeof segment !== 'object') continue;
      if (segment.type === 'text') {
        const value = segment.data?.text;
        if (typeof value === 'string') text += value;
      } else if (segment.type === 'at') {
        const qq = String(segment.data?.qq ?? '');
        if (selfId !== '' && qq === selfId) mentionedSelf = true;
      }
      // image / face / record and friends contribute no text
    }
  } else if (typeof raw === 'string') {
    if (selfId !== '') {
      const mention = new RegExp(`\\[CQ:at,[^\\]]*qq=${escapeRegExp(selfId)}(?:,[^\\]]*)?\\]`);
      mentionedSelf = mention.test(raw);
    }
    text = raw.replace(CQ_CODE, '');
  }

  if (text === '' && typeof event.raw_message === 'string') {
    const stripped = event.raw_message.replace(CQ_CODE, '');
    if (selfId !== '' && !mentionedSelf) {
      const mention = new RegExp(`\\[CQ:at,[^\\]]*qq=${escapeRegExp(selfId)}(?:,[^\\]]*)?\\]`);
      mentionedSelf = mention.test(event.raw_message);
    }
    text = stripped;
  }

  return { text: text.trim(), mentionedSelf };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sessionIdFor(
  config: Config,
  target: { kind: 'group' | 'private'; id: string },
): string {
  const prefix = config.onebot.inbound.sessionPrefix;
  return target.kind === 'group' ? `${prefix}-group-${target.id}` : `${prefix}-user-${target.id}`;
}

/**
 * Decides whether an event should trigger an agent run, and under which session.
 *
 * Everything that costs money is decided here: self-messages, non-messages,
 * disallowed groups/users, and anything failing the trigger rule all return
 * `handled: false` with a reason.
 */
export function decideEvent(config: Config, event: OneBotEvent, selfId: string): BridgeDecision {
  const senderId = String(event.user_id ?? '');
  const senderName = event.sender?.card || event.sender?.nickname || senderId;
  const inbound = config.onebot.inbound;

  const base = {
    text: '',
    sessionId: '',
    target: null,
    senderId,
    senderName,
  } satisfies Omit<BridgeDecision, 'handled' | 'reason'>;

  if (event.post_type !== 'message') {
    return { ...base, handled: false, reason: 'not-message' };
  }
  if (event.message_type !== 'group' && event.message_type !== 'private') {
    return { ...base, handled: false, reason: 'not-message' };
  }
  // The bot's own messages must never feed back into the model.
  if (selfId !== '' && senderId === selfId) {
    return { ...base, handled: false, reason: 'from-self' };
  }

  const target: { kind: 'group' | 'private'; id: string } =
    event.message_type === 'group'
      ? { kind: 'group', id: String(event.group_id ?? '') }
      : { kind: 'private', id: senderId };
  if (target.id === '') return { ...base, handled: false, reason: 'not-message' };

  const sessionId = sessionIdFor(config, target);
  const withTarget = { ...base, target, sessionId };

  if (target.kind === 'group' && inbound.allowGroups.length > 0) {
    if (!inbound.allowGroups.includes(target.id)) {
      return { ...withTarget, handled: false, reason: 'group-not-allowed' };
    }
  }
  if (inbound.allowUsers.length > 0 && !inbound.allowUsers.includes(senderId)) {
    return { ...withTarget, handled: false, reason: 'user-not-allowed' };
  }

  const { text, mentionedSelf } = extractMessage(event, selfId);
  if (text === '') return { ...withTarget, handled: false, reason: 'empty' };

  // A private chat has no third party to mention, so every private message is
  // aimed at the bot. Requiring an @ there would silently mute the bot.
  const addressed = mentionedSelf || target.kind === 'private';

  let prompt = text;
  switch (inbound.trigger) {
    case 'none':
      return { ...withTarget, handled: false, reason: 'no-trigger' };
    case 'all':
      break;
    case 'mention':
      if (!addressed) return { ...withTarget, handled: false, reason: 'no-trigger' };
      break;
    case 'prefix': {
      const trimmed = text.trimStart();
      if (!trimmed.startsWith(inbound.prefix)) {
        return { ...withTarget, handled: false, reason: 'no-trigger' };
      }
      prompt = trimmed.slice(inbound.prefix.length).trim();
      if (prompt === '') return { ...withTarget, handled: false, reason: 'empty' };
      break;
    }
  }

  return { ...withTarget, handled: true, reason: 'handled', text: prompt };
}

/** Strips the Markdown that QQ would otherwise show as literal punctuation. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[a-zA-Z0-9_+-]*\r?\n?/g, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits a reply into pieces that fit a single QQ message. */
export function chunkMessage(text: string, max: number): string[] {
  if (max <= 0) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > max) {
    let cut = remaining.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(' ', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^[\s\n]+/, '');
  }
  if (remaining.trim() !== '') chunks.push(remaining.trimEnd());

  return chunks.length > 0 ? chunks : [''];
}

/* ------------------------------------------------------------------ *
 * Bridge
 * ------------------------------------------------------------------ */

export interface OneBotBridgeDeps {
  config: Config;
  log: Logger;
  client: OneBotClient;
  store: SessionStore;
  registry: ToolRegistry;
  provider: LLMProvider;
  metrics: Metrics;
}

export interface ProcessOutcome {
  handled: boolean;
  reason: BridgeReason | 'busy' | 'failed';
  sessionId?: string;
  replyChars?: number;
  chunks?: number;
  durationMs?: number;
  error?: string;
}

export interface OneBotBridgeStats {
  received: number;
  handled: number;
  skipped: number;
  replies: number;
  busy: number;
  failures: number;
  lastEventAt: number | null;
  lastReason: string | null;
  activeRuns: number;
}

export class OneBotBridge {
  private readonly deps: OneBotBridgeDeps;
  private readonly inFlightSessions = new Set<string>();
  private activeRuns = 0;

  private received = 0;
  private handled = 0;
  private skipped = 0;
  private replies = 0;
  private busy = 0;
  private failures = 0;
  private lastEventAt: number | null = null;
  private lastReason: string | null = null;

  constructor(deps: OneBotBridgeDeps) {
    this.deps = deps;
  }

  get stats(): OneBotBridgeStats {
    return {
      received: this.received,
      handled: this.handled,
      skipped: this.skipped,
      replies: this.replies,
      busy: this.busy,
      failures: this.failures,
      lastEventAt: this.lastEventAt,
      lastReason: this.lastReason,
      activeRuns: this.activeRuns,
    };
  }

  /** Counts an event without processing it (used when inbound is switched off). */
  noteSkipped(reason: BridgeReason | 'disabled'): void {
    this.received += 1;
    this.skipped += 1;
    this.lastEventAt = Date.now();
    this.lastReason = reason;
    this.deps.metrics.recordOneBotReceived();
    this.deps.metrics.recordOneBotSkipped();
  }

  /**
   * Processes one event end to end: filter, run the agent, reply.
   *
   * Callers should answer the OneBot report before awaiting this, because a
   * reporter will time out long before a local model finishes generating.
   */
  async process(event: OneBotEvent, selfId = ''): Promise<ProcessOutcome> {
    const { config, log, client, metrics } = this.deps;
    const inbound = config.onebot.inbound;

    this.received += 1;
    this.lastEventAt = Date.now();
    metrics.recordOneBotReceived();

    const decision = decideEvent(config, event, selfId);
    this.lastReason = decision.reason;

    if (!decision.handled) {
      this.skipped += 1;
      metrics.recordOneBotSkipped();
      log.debug('onebot event skipped', { reason: decision.reason, user: decision.senderId });
      return { handled: false, reason: decision.reason };
    }

    const sessionId = decision.sessionId;
    const target = decision.target;
    if (!target) return { handled: false, reason: 'not-message' };

    // One run at a time per conversation, and a global cap, so a burst cannot
    // pile up unbounded model calls.
    if (this.inFlightSessions.has(sessionId) || this.activeRuns >= inbound.maxConcurrent) {
      this.busy += 1;
      log.info('onebot event dropped: already busy', {
        sessionId,
        activeRuns: this.activeRuns,
        maxConcurrent: inbound.maxConcurrent,
      });
      return { handled: false, reason: 'busy', sessionId };
    }

    this.inFlightSessions.add(sessionId);
    this.activeRuns += 1;
    this.handled += 1;
    metrics.recordOneBotHandled();

    const startedAt = Date.now();
    const eventLog = log.child({ sessionId, group: target.id, user: decision.senderId });

    try {
      const controller = new AbortController();
      let output = '';

      const events = runAgent(
        {
          deps: {
            store: this.deps.store,
            registry: this.deps.registry,
            provider: this.deps.provider,
            config,
            log: eventLog,
          },
          signal: controller.signal,
        },
        {
          input: decision.text,
          sessionId,
          model: config.llm.model,
          system: inbound.systemPrompt,
        },
      );

      for await (const agentEvent of events) {
        if (agentEvent.type === 'delta') metrics.recordDelta(agentEvent.data.text.length);
        if (agentEvent.type === 'tool.result') metrics.recordToolCall();
        if (agentEvent.type === 'run.end') {
          output = agentEvent.data.output;
          metrics.recordRunEnd('succeeded');
        }
        if (agentEvent.type === 'error') {
          metrics.recordRunEnd('failed');
          throw new Error(agentEvent.data.message);
        }
      }

      const body = this.renderReply(output);
      const chunks = chunkMessage(body, inbound.maxReplyChars);

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index] as string;
        // A real @ needs an `at` segment; literal "@12345" text notifies nobody.
        // Only the first chunk carries it, so a long answer is not @-spammed.
        const segments: OneBotSegment[] =
          index === 0 && target.kind === 'group'
            ? mentionSegments(decision.senderId, chunk)
            : [textSegment(chunk)];

        if (target.kind === 'group') {
          await client.sendGroupMsg(target.id, segments);
        } else {
          await client.sendPrivateMsg(target.id, segments);
        }
      }

      this.replies += chunks.length;
      metrics.recordOneBotReply(chunks.length);

      const durationMs = Date.now() - startedAt;
      eventLog.info('onebot reply sent', {
        chunks: chunks.length,
        chars: body.length,
        ms: durationMs,
      });

      return {
        handled: true,
        reason: 'handled',
        sessionId,
        replyChars: body.length,
        chunks: chunks.length,
        durationMs,
      };
    } catch (error) {
      this.failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      eventLog.error('onebot handling failed', { error: message });
      metrics.recordOneBotFailure();
      return { handled: true, reason: 'failed', sessionId, error: message };
    } finally {
      this.inFlightSessions.delete(sessionId);
      this.activeRuns -= 1;
    }
  }

  /** Normalises the model's answer for QQ: no Markdown, never empty. */
  private renderReply(output: string): string {
    const { config } = this.deps;
    let body = output.trim() === '' ? '(模型没有返回内容)' : output;
    if (config.onebot.inbound.stripMarkdown) body = stripMarkdown(body);
    return body;
  }
}

/** Builds the array-form message for a group reply that @-mentions someone. */
export function mentionSegments(senderId: string, text: string): OneBotSegment[] {
  return [atSegment(senderId), textSegment(` ${text}`)];
}
