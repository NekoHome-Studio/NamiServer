<template>
  <v-container fluid class="pa-6">
    <PageHeader
      title="对话"
      subtitle="直接与 Nami 对话：整轮通过 POST /v1/agent/run 流式返回，模型每次调用工具都会在下面实时出现一张卡片。"
    >
      <template #actions>
        <v-chip variant="tonal" :prepend-icon="icons.bolt" label>
          SSE · /v1/agent/run
        </v-chip>
      </template>
    </PageHeader>

    <v-row dense>
      <!-- 左列是「这一轮怎么跑」的全部旋钮；窄屏下自然堆到对话区上方。 -->
      <v-col cols="12" md="4" lg="3">
        <v-card class="mb-4">
          <v-card-title class="text-subtitle-2">会话</v-card-title>
          <v-card-text>
            <v-text-field
              v-model="sessionId"
              label="会话 ID"
              placeholder="留空 = 新建会话"
              density="comfortable"
              spellcheck="false"
              hide-details="auto"
              :disabled="running"
              @keydown.enter.stop
            >
              <template #append-inner>
                <v-btn
                  :icon="icons.close"
                  variant="text"
                  size="x-small"
                  title="清空 ID，下一轮开一个新会话"
                  @click="newSession"
                />
              </template>
            </v-text-field>
            <div class="text-caption text-medium-emphasis mt-2">
              留空时由服务端分配 ID，run.start 事件返回后会自动填回这里，于是下一轮接着同一个会话。
            </div>
            <div class="d-flex ga-2 mt-3">
              <v-btn size="small" variant="tonal" :prepend-icon="icons.plus" @click="newSession">
                新会话
              </v-btn>
              <v-btn
                size="small"
                variant="tonal"
                :prepend-icon="icons.history"
                :loading="historyLoading"
                :disabled="sessionId.trim() === ''"
                @click="loadHistory"
              >
                历史
              </v-btn>
            </div>
            <v-alert v-if="historyError" type="error" variant="tonal" density="comfortable" class="mt-3">
              <div class="text-body-2">{{ historyError }}</div>
            </v-alert>
          </v-card-text>
        </v-card>

        <v-card class="mb-4">
          <v-card-title class="text-subtitle-2">本轮参数</v-card-title>
          <v-card-text>
            <v-alert
              v-if="modelsError"
              type="warning"
              variant="tonal"
              density="comfortable"
              class="mb-3"
            >
              <div class="text-body-2">{{ modelsError }}</div>
              <div class="text-caption mt-1">不影响发送：留空即使用服务端默认模型。</div>
            </v-alert>

            <v-select
              v-model="model"
              :items="modelItems"
              label="模型"
              :loading="modelsLoading"
              :disabled="running"
              hide-details="auto"
            >
              <template #append-item>
                <v-btn
                  variant="text"
                  size="small"
                  block
                  :prepend-icon="icons.refresh"
                  :loading="modelsLoading"
                  @click="loadModels"
                >
                  重新获取模型列表
                </v-btn>
              </template>
            </v-select>

            <v-text-field
              v-model.number="maxRounds"
              class="mt-3"
              type="number"
              min="1"
              max="20"
              step="1"
              label="最大轮次"
              hint="一轮 = 模型输出一次（可能夹带若干次工具调用）"
              persistent-hint
              :disabled="running"
            />

            <v-textarea
              v-model="systemPrompt"
              class="mt-3"
              label="系统提示词（可选）"
              placeholder="留空则不发送 system 字段"
              rows="5"
              auto-grow
              spellcheck="false"
              :disabled="running"
            />

            <v-text-field
              v-model.number="temperature"
              class="mt-3"
              type="number"
              min="0"
              max="2"
              step="0.1"
              label="温度（可选）"
              placeholder="留空则不发送"
              clearable
              :disabled="running"
            />
          </v-card-text>
        </v-card>
      </v-col>

      <!-- 右列：对话本体 + 输入框。会话 + 转录做成一张卡，视觉上就是一件事。 -->
      <v-col cols="12" md="8" lg="9">
        <v-card class="d-flex flex-column nami-chat__card">
          <v-card-title class="d-flex align-center ga-2 py-3">
            <v-icon :icon="icons.chat" size="20" />
            <span class="text-subtitle-1">会话记录</span>
            <v-chip v-if="sessionId.trim()" size="small" variant="tonal" label class="nami-mono">
              {{ sessionId }}
            </v-chip>
            <v-chip v-else size="small" variant="tonal" color="secondary" label>尚未建立</v-chip>
            <v-spacer />
            <v-btn
              size="small"
              variant="text"
              :prepend-icon="icons.delete"
              title="只清空本页面显示的内容，不会删除服务端会话"
              @click="clearTranscript"
            >
              清空对话
            </v-btn>
          </v-card-title>

          <v-divider />

          <div class="nami-chat__stage">
            <div ref="scrollEl" class="nami-chat__scroll" @scroll="onScroll">
              <div v-if="transcript.length === 0" class="text-center py-12">
                <v-icon :icon="icons.chat" size="40" class="text-medium-emphasis mb-3" />
                <div class="text-body-1">还没有对话</div>
                <div class="text-caption text-medium-emphasis">
                  输入一句话开始；工具调用会以卡片形式插在回复之间。
                </div>
              </div>

              <template v-for="(item, index) in transcript" :key="index">
                <ChatMessage
                  v-if="item.kind === 'message'"
                  :role="item.role"
                  :text="item.text"
                  :streaming="item.streaming === true"
                  :error="item.error === true"
                />
                <ChatToolCall
                  v-else
                  :name="item.tool.name"
                  :args="item.tool.args"
                  :danger="item.tool.danger"
                  :pending="item.tool.result === undefined"
                  :result="item.tool.result ?? null"
                />
              </template>
            </div>

            <!-- 用户翻上去看历史时不会被强行拉回底部，但这个按钮让他一键回到最新。 -->
            <v-btn
              v-if="!stick"
              class="nami-chat__jump"
              size="small"
              color="primary"
              variant="flat"
              :prepend-icon="icons.arrow"
              @click="jumpToBottom"
            >
              回到最新
            </v-btn>
          </div>

          <v-divider />

          <v-card-text class="py-3">
            <div v-if="running" class="mb-3">
              <v-progress-linear indeterminate color="primary" rounded height="4" />
              <div class="d-flex align-center ga-3 mt-2 text-caption text-medium-emphasis">
                <span>流式接收中… 已用时 {{ formatDuration(elapsedMs) }}</span>
                <v-spacer />
                <span>发送按钮已变为取消</span>
              </div>
            </div>

            <v-alert
              v-else-if="lastRun"
              type="success"
              variant="tonal"
              density="comfortable"
              class="mb-3"
              :title="`上一轮完成：${lastRun.rounds} 轮`"
            >
              <div class="text-caption">
                工具调用 {{ lastRun.toolCalls }} 次 · 令牌 {{ lastRun.totalTokens }}（输入
                {{ lastRun.promptTokens }} / 输出 {{ lastRun.completionTokens }}） · 耗时
                {{ formatDuration(lastRun.durationMs) }}
              </div>
            </v-alert>

            <v-textarea
              v-model="draft"
              rows="1"
              auto-grow
              max-rows="8"
              spellcheck="false"
              placeholder="Enter 发送，Shift+Enter 换行"
              hide-details="auto"
              :disabled="running"
              @keydown.enter.exact.prevent="send"
            />

            <div class="d-flex align-center ga-3 mt-3">
              <v-btn
                v-if="!running"
                color="primary"
                :prepend-icon="icons.send"
                :disabled="draft.trim() === ''"
                @click="send"
              >
                发送
              </v-btn>
              <v-btn v-else color="error" variant="tonal" :prepend-icon="icons.stop" @click="cancel">
                取消
              </v-btn>

              <span class="text-caption text-medium-emphasis">
                {{ running ? '正在接收服务端事件…' : '会话 ID 会在首轮结束后自动填回左侧输入框。' }}
              </span>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
/**
 * 对话页：Nami 的旗舰界面。
 *
 * 与普通聊天前端的关键差别是**把工具调用循环摆到台面上**。Nami 的一轮可能包含
 * 多次「模型决定调用工具 → 沙箱执行 → 结果回灌 → 模型继续」，如果只渲染最终
 * 文本，这个过程就完全不可见了。因此这里直接把 SSE 的 `tool.call` / `tool.result`
 * 事件当作转录里的一等条目，而不是折叠进调试信息里。
 *
 * 数据流只有一条：`streamAgentRun` 的 onEvent 回调 → 就地改 `transcript`。
 * 不做本地重放、不做消息 ID 对齐，因为转录只是本次浏览器的视图，服务端的真相
 * 通过「历史」按钮（`api.session`）单独拉取。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  mdiArrowDown,
  mdiChatProcessingOutline,
  mdiClose,
  mdiDelete,
  mdiHistory,
  mdiLightningBoltOutline,
  mdiPlus,
  mdiRefresh,
  mdiSend,
  mdiStop,
} from '@mdi/js';
import { ApiError, api } from '@/api/client';
import type { AgentEvent, AgentRunRequest } from '@/api/client';
import PageHeader from '@/components/PageHeader.vue';
import ChatMessage from '@/components/ChatMessage.vue';
import ChatToolCall from '@/components/ChatToolCall.vue';
import type { ChatToolResult } from '@/components/ChatToolCall.vue';
import { describeError, formatDuration, shell, toastError } from '@/composables/useShell';

const props = defineProps<{ refreshToken?: number }>();

/* ------------------------------ 转录模型 ------------------------------ */

/**
 * 转录在结构上刻意保持扁平：一个数组、两种条目。
 *
 * 助手文本在多轮之间刻意不合并成一个气泡——每轮一段，工具卡片自然夹在两段
 * 之间，读起来就是「想了 → 调了 → 又说了」，而这正是 agent 循环的形状。
 */
interface TranscriptMessage {
  kind: 'message';
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  error?: boolean;
}

interface TranscriptTool {
  kind: 'tool';
  tool: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    danger: string;
    /** undefined 表示仍在执行；收到 `tool.result` 后填充。 */
    result?: ChatToolResult;
  };
}

type TranscriptItem = TranscriptMessage | TranscriptTool;

interface RunSummary {
  rounds: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  durationMs: number;
}

const transcript = ref<TranscriptItem[]>([]);
const draft = ref('');
/** 当前轮次正在累积的助手条目；`null` 表示下一次 delta 应当新开一段。 */
let activeAssistant: TranscriptMessage | null = null;

/* ------------------------------ 表单状态 ------------------------------ */

const STORAGE_KEY = 'nami.chat.sessionId';

const sessionId = ref('');
const model = ref('');
const maxRounds = ref(6);
const systemPrompt = ref('');
/** `null` 而不是 `''`：数字输入框清空后 v-model.number 会给 null，两者都表示不发送该字段。 */
const temperature = ref<number | string | null>(null);

const running = ref(false);
const elapsedMs = ref(0);
const lastRun = ref<RunSummary | null>(null);
const historyLoading = ref(false);
const historyError = ref('');
const modelsLoading = ref(false);
const modelsError = ref('');

interface ModelOption {
  title: string;
  value: string;
}

const models = ref<ModelOption[]>([]);

let controller: AbortController | null = null;
let timer: number | undefined;
let startedAt = 0;

/**
 * 滚动容器。写成 ref，才能既听它的 scroll 事件，又主动改 scrollTop。
 */
const scrollEl = ref<HTMLElement | null>(null);

/**
 * 是否吸附到底部。
 *
 * 作成 ref 而不是普通变量，因为模板里的「回到最新」按钮要跟着它切换可见性。
 */
const stick = ref(true);
let scrollScheduled = false;

const icons = {
  arrow: mdiArrowDown,
  bolt: mdiLightningBoltOutline,
  chat: mdiChatProcessingOutline,
  close: mdiClose,
  delete: mdiDelete,
  history: mdiHistory,
  plus: mdiPlus,
  refresh: mdiRefresh,
  send: mdiSend,
  stop: mdiStop,
} as const;

const modelItems = computed<ModelOption[]>(() => [
  { title: '（使用服务端默认）', value: '' },
  ...models.value,
]);

/* ------------------------------ 会话选择 ------------------------------ */

function newSession(): void {
  sessionId.value = '';
  activeAssistant = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 无痕模式下存储不可用，会话 ID 只是不持久化而已 */
  }
  shell.info('已切换到新会话', '下一轮会由服务端分配新的会话 ID。');
}

/**
 * 拉取当前会话的服务端转录。
 *
 * 回复里既有 user/assistant 也有 tool 角色，而工具结果在服务端是独立的一条
 * tool 消息。这里的策略是把 tool 消息回填到它对应的那张工具卡片里（按
 * toolCallId 匹配 assistant 消息的 toolCalls），匹配不上就单独渲染成一条说明，
 * 这样历史记录和实时转录的重叠部分看起来是一致的。
 */
async function loadHistory(): Promise<void> {
  const id = sessionId.value.trim();
  if (id === '') return;
  historyLoading.value = true;
  historyError.value = '';
  try {
    const detail = await api.session(id);
    const items: TranscriptItem[] = [];
    const cards = new Map<string, TranscriptTool>();

    for (const message of detail.messages) {
      if (message.role === 'user') {
        items.push({ kind: 'message', role: 'user', text: message.content ?? '' });
        continue;
      }
      if (message.role === 'assistant') {
        if (message.content) {
          items.push({ kind: 'message', role: 'assistant', text: message.content });
        }
        for (const call of message.toolCalls ?? []) {
          const card: TranscriptTool = {
            kind: 'tool',
            tool: {
              id: call.id,
              name: call.function.name,
              args: parseToolArguments(call.function.arguments),
              danger: 'unknown',
            },
          };
          cards.set(call.id, card);
          items.push(card);
        }
        continue;
      }
      if (message.role === 'tool') {
        const card = message.toolCallId ? cards.get(message.toolCallId) : undefined;
        if (card) {
          card.tool.result = {
            ok: true,
            content: message.content ?? '',
            durationMs: 0,
          };
        } else {
          items.push({
            kind: 'message',
            role: 'assistant',
            text: `工具 ${message.name ?? '（未命名）'} 的返回：\n${message.content ?? ''}`,
          });
        }
        continue;
      }
      if (message.content) {
        items.push({ kind: 'message', role: 'assistant', text: `[system] ${message.content}` });
      }
    }

    transcript.value = items;
    lastRun.value = null;
    shell.success(`已载入会话 ${id}`, `共 ${detail.messages.length} 条消息。`);
  } catch (error) {
    historyError.value = describeError(error);
  } finally {
    historyLoading.value = false;
  }
}

/* ------------------------------ 模型列表 ------------------------------ */

/**
 * 模型列表同时包含上游 ID 和别名。
 *
 * 别名是合法的 `model` 取值（服务端 `models.resolve` 会做映射），而且往往是
 * 运维在 `.env` 里指定的稳定名字，所以必须出现在下拉里，只是用后缀和上游 ID
 * 区分开，避免看起来像重复项。
 */
async function loadModels(): Promise<void> {
  modelsLoading.value = true;
  modelsError.value = '';
  try {
    const response = await api.models();
    const seen = new Set<string>();
    const options: ModelOption[] = [];
    for (const entry of response.data) {
      if (!entry.exposed) continue;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const notInstalled = entry.meta?.notInstalled === true;
      options.push({
        title: `${entry.id}${entry.isDefault ? '（当前默认）' : ''}${notInstalled ? '（上游未安装）' : ''}`,
        value: entry.id,
      });
      for (const alias of entry.aliases) {
        if (seen.has(alias)) continue;
        seen.add(alias);
        options.push({ title: `${alias}（别名 → ${entry.id}）`, value: alias });
      }
    }
    models.value = options;
  } catch (error) {
    modelsError.value = describeError(error);
  } finally {
    modelsLoading.value = false;
  }
}

/* ------------------------------ 流式发送 ------------------------------ */

function send(): void {
  const input = draft.value.trim();
  if (running.value || input === '') return;

  draft.value = '';
  historyError.value = '';

  transcript.value.push({ kind: 'message', role: 'user', text: input });
  activeAssistant = null;
  lastRun.value = null;
  running.value = true;
  startedAt = Date.now();
  elapsedMs.value = 0;
  timer = window.setInterval(() => {
    elapsedMs.value = Date.now() - startedAt;
  }, 250);
  stick.value = true;
  scrollToBottom();

  const body: AgentRunRequest = {
    input,
    ...(sessionId.value.trim() !== '' ? { sessionId: sessionId.value.trim() } : {}),
    ...(model.value !== '' ? { model: model.value } : {}),
    ...(systemPrompt.value.trim() !== '' ? { system: systemPrompt.value.trim() } : {}),
    ...(Number.isFinite(Number(maxRounds.value)) ? { maxRounds: clampRounds(maxRounds.value) } : {}),
    ...(temperature.value === null || temperature.value === '' || !Number.isFinite(Number(temperature.value))
      ? {}
      : { temperature: clampTemperature(Number(temperature.value)) }),
  };

  controller = new AbortController();
  const signal = controller.signal;

  void api
    .streamAgentRun(body, (event) => handleEvent(event), signal)
    .catch((error: unknown) => {
      // 主动取消时 fetch 会抛 AbortError；那是预期的操作，不是失败。
      if (signal.aborted) return;
      const message = describeError(error);
      activeAssistant = null;
      transcript.value.push({ kind: 'message', role: 'assistant', text: message, error: true });
      // describeError 已经把凭证失配处理成登出，这里再弹一次只会重复它的话。
      if (!(error instanceof ApiError && error.isAuthProblem)) {
        toastError(error, '对话失败');
      }
    })
    .finally(() => {
      if (controller !== null && controller.signal !== signal) return;
      running.value = false;
      controller = null;
      stopTimer();
      activeAssistant = null;
      scrollToBottom();
    });
}

function cancel(): void {
  if (!running.value) return;
  controller?.abort();
  running.value = false;
  stopTimer();
  activeAssistant = null;
  shell.info('已取消本轮', '服务端在连接断开时会一并中止这次运行。');
  scrollToBottom();
}

function handleEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'run.start':
      // 新建会话时服务端在 run.start 里给出 ID，写回输入框，下一轮就接着它。
      if (event.data.sessionId) {
        sessionId.value = event.data.sessionId;
        try {
          localStorage.setItem(STORAGE_KEY, event.data.sessionId);
        } catch {
          /* 存储不可用 */
        }
      }
      break;

    case 'delta': {
      if (activeAssistant === null) {
        activeAssistant = { kind: 'message', role: 'assistant', text: '', streaming: true };
        transcript.value.push(activeAssistant);
      }
      // 直接改数组里的对象：它已经是响应式的，重建数组会让每个 token 都重渲染整份转录。
      activeAssistant.text += event.data.text;
      break;
    }

    case 'tool.call':
      transcript.value.push({
        kind: 'tool',
        tool: {
          id: event.data.id,
          name: event.data.name,
          args: event.data.args ?? {},
          danger: event.data.danger,
        },
      });
      // 工具执行期间模型没在说话，下一段文本该另起一个气泡。
      activeAssistant = null;
      break;

    case 'tool.result': {
      const card = findPendingTool(event.data.id);
      if (card) {
        card.tool.result = {
          ok: event.data.ok,
          content: event.data.content,
          ...(event.data.error ? { error: event.data.error } : {}),
          durationMs: event.data.durationMs,
        };
      } else {
        // 理论上不该发生（先有 call 才有 result）；真发生了也要让人看见，别静默丢事件。
        transcript.value.push({
          kind: 'tool',
          tool: {
            id: event.data.id,
            name: event.data.name,
            args: {},
            danger: 'unknown',
            result: {
              ok: event.data.ok,
              content: event.data.content,
              ...(event.data.error ? { error: event.data.error } : {}),
              durationMs: event.data.durationMs,
            },
          },
        });
      }
      activeAssistant = null;
      break;
    }

    case 'run.end':
      activeAssistant = null;
      lastRun.value = {
        rounds: event.data.rounds,
        toolCalls: event.data.toolCalls,
        promptTokens: event.data.usage.prompt_tokens,
        completionTokens: event.data.usage.completion_tokens,
        totalTokens: event.data.usage.total_tokens,
        durationMs: event.data.durationMs,
      };
      break;

    case 'error': {
      activeAssistant = null;
      const suffix = event.data.code ? `（${event.data.code}）` : '';
      transcript.value.push({
        kind: 'message',
        role: 'assistant',
        text: `${event.data.message}${suffix}`,
        error: true,
      });
      if (event.data.code === 'unauthorized' || event.data.code === 'forbidden') {
        // 让 describeError 的语义生效：它会把凭证清掉，路由守卫随后把人送回登录页。
        describeError(new ApiError(event.data.code === 'forbidden' ? 403 : 401, event.data.code, event.data.message));
      }
      break;
    }
  }
  finishStreamingFlags();
}

/** 只有最后一段助手文本算「正在流式」，否则每个气泡都会闪一个光标。 */
function finishStreamingFlags(): void {
  let last: TranscriptMessage | null = null;
  for (const item of transcript.value) {
    if (item.kind === 'message' && item.role === 'assistant') last = item;
  }
  for (const item of transcript.value) {
    if (item.kind === 'message' && item.role === 'assistant') {
      item.streaming = running.value && item === last;
    }
  }
}

function findPendingTool(id: string): TranscriptTool | null {
  for (let index = transcript.value.length - 1; index >= 0; index -= 1) {
    const item = transcript.value[index];
    if (item && item.kind === 'tool' && item.tool.id === id && item.tool.result === undefined) {
      return item;
    }
  }
  return null;
}

function clearTranscript(): void {
  transcript.value = [];
  activeAssistant = null;
  lastRun.value = null;
  shell.info('已清空本页对话', '服务端会话与记忆保持不变。');
}

/* ------------------------------ 滚动 ------------------------------ */

/**
 * 只有在用户本来就在底部附近时才自动跟随。
 *
 * 流式输出会持续追加内容；如果无条件跳到最新一行，用户往上翻看 tool 调用时会被
 * 反复拽回去，那比不自动滚动更难用。
 */
function onScroll(): void {
  const el = scrollEl.value;
  if (!el) return;
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollToBottom(): void {
  if (!stick.value || scrollScheduled) return;
  scrollScheduled = true;
  void nextTick(() => {
    scrollScheduled = false;
    const el = scrollEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/** 用户主动点「回到最新」：重新吸附并跳到底，不等下一次内容追加。 */
function jumpToBottom(): void {
  stick.value = true;
  const el = scrollEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

function stopTimer(): void {
  if (timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

/* ------------------------------ 工具函数 ------------------------------ */

function clampRounds(value: number | string): number {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return 6;
  return Math.min(20, Math.max(1, parsed));
}

function clampTemperature(value: number): number {
  return Math.min(2, Math.max(0, value));
}

/** 服务端的 arguments 是字符串（模型原样输出），解析失败就原样保留，绝不丢内容。 */
function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw };
  }
}

/* ------------------------------ 生命周期 ------------------------------ */

watch(
  () => props.refreshToken,
  () => {
    void loadModels();
    if (sessionId.value.trim() !== '' && !running.value) void loadHistory();
  },
);

watch(
  transcript,
  () => {
    finishStreamingFlags();
    scrollToBottom();
  },
  { deep: true },
);

onMounted(() => {
  try {
    sessionId.value = localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    sessionId.value = '';
  }
  void loadModels();
});

onBeforeUnmount(() => {
  stopTimer();
  controller?.abort();
});
</script>

<style scoped>
/* 对话区高度固定，让「记录随内容增长」表现为内部滚动，而不是把发送框顶到屏幕外。 */
.nami-chat__card {
  height: calc(100vh - 220px);
  min-height: 440px;
}
.nami-chat__stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.nami-chat__scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}
.nami-chat__jump {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
}
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
</style>
