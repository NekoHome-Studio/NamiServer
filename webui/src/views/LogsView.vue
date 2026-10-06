<template>
  <v-container fluid class="pa-6">
    <PageHeader
      title="日志"
      subtitle="服务器内存里的环形缓冲：进程重启即清空。日志在写入缓冲之前就已脱敏，所以这里不会出现凭证原文。"
    >
      <template #actions>
        <v-btn variant="tonal" prepend-icon="mdiRefresh" :loading="loading" @click="load">
          重新拉取
        </v-btn>
      </template>
    </PageHeader>

    <!-- 实时连接断了必须说出来：EventSource 会自己重连，界面不能假装什么都没发生。 -->
    <v-alert
      v-if="connError"
      type="warning"
      variant="tonal"
      class="mb-4"
      title="实时连接中断"
    >
      <div class="text-body-2">{{ connError }}</div>
      <div class="text-caption mt-1">
        浏览器会自行重试（每秒几次，随后退避）。如果一直连不上，通常是凭证不对或服务器已停止；
        已知的日志仍然显示在下面。也可以先把「跟随实时」关掉再打开，强制重新连接。
      </div>
    </v-alert>

    <!-- ---------------------------- 工具栏 ---------------------------- -->
    <v-card class="mb-4">
      <v-card-text class="d-flex align-center flex-wrap ga-4">
        <v-select
          v-model="level"
          :items="LEVELS"
          label="级别"
          density="compact"
          variant="outlined"
          hide-details
          style="max-width: 200px"
        />

        <v-text-field
          v-model="search"
          label="搜索（消息 / 级别 / 字段内容）"
          prepend-inner-icon="mdiMagnify"
          clearable
          density="compact"
          variant="outlined"
          hide-details
          style="max-width: 340px; min-width: 200px"
        />

        <v-switch
          v-model="autoScroll"
          label="自动滚动"
          color="primary"
          density="compact"
          hide-details
          inset
        />

        <v-switch
          v-model="follow"
          label="跟随实时"
          color="primary"
          density="compact"
          hide-details
          inset
        />

        <v-btn
          variant="tonal"
          :prepend-icon="paused ? 'mdiPlayCircleOutline' : 'mdiPauseCircleOutline'"
          @click="togglePause"
        >
          {{ paused ? '继续' : '暂停' }}
        </v-btn>

        <v-btn
          variant="tonal"
          color="error"
          prepend-icon="mdiDeleteSweepOutline"
          @click="clearDialog = true"
        >
          清空
        </v-btn>

        <v-spacer />

        <v-btn
          variant="text"
          size="small"
          prepend-icon="mdiArrowDownBold"
          @click="scrollToBottom(true)"
        >
          回到底部
        </v-btn>
      </v-card-text>
    </v-card>

    <!-- ---------------------------- 缓冲元数据 ---------------------------- -->
    <v-row dense class="mb-4">
      <v-col cols="6" sm="4" md="3" lg="2">
        <StatCard label="缓冲条目 buffered" :value="meta.buffered" icon="mdiInboxOutline" />
      </v-col>
      <v-col cols="6" sm="4" md="3" lg="2">
        <StatCard label="容量 capacity" :value="meta.capacity" icon="mdiDatabaseOutline" />
      </v-col>
      <v-col cols="6" sm="4" md="3" lg="2">
        <StatCard
          label="已丢弃 dropped"
          :value="meta.dropped"
          icon="mdiAlertCircleOutline"
          :tone="meta.dropped > 0 ? 'warning' : 'default'"
          :hint="meta.dropped > 0 ? '更早的条目已掉出环形缓冲' : undefined"
        />
      </v-col>
      <v-col cols="6" sm="4" md="3" lg="2">
        <StatCard
          label="本页显示"
          :value="visibleEntries.length"
          icon="mdiTextBoxSearchOutline"
          hint="= 过滤后的条数"
        />
      </v-col>
      <v-col cols="12" md="6" lg="4">
        <v-card class="h-100">
          <v-card-text>
            <div class="text-caption text-medium-emphasis">采集级别 captureLevel</div>
            <div class="text-h6 font-weight-bold nami-mono">{{ meta.captureLevel || '—' }}</div>
            <div class="text-caption text-medium-emphasis mt-1">
              页面只显示服务器 <code class="nami-mono">NAMI_LOG_CAPTURE_LEVEL</code> 及以上级别的日志。
              想看到更啰嗦的 debug 日志，请在服务器上把该变量调成 debug 并重启——这是服务器的采集口径，前端改不了。
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <v-alert
      v-if="meta.dropped > 0"
      type="warning"
      variant="tonal"
      density="comfortable"
      class="mb-4"
      title="有日志掉出了环形缓冲"
    >
      <div class="text-body-2">
        已经丢弃 <strong>{{ meta.dropped }}</strong> 条：缓冲写满后最旧的条目会被挤掉。
        需要留更长的历史就把 <code class="nami-mono">NAMI_LOG_BUFFER_SIZE</code> 调大（重启生效），
        或者把不需要的级别从控制台关掉。
      </div>
    </v-alert>

    <v-alert
      v-if="loadError"
      type="error"
      variant="tonal"
      density="comfortable"
      class="mb-4"
      title="拉取日志失败"
    >
      <div class="text-body-2">{{ loadError }}</div>
      <template #append>
        <v-btn variant="text" size="small" prepend-icon="mdiRefresh" @click="load">重试</v-btn>
      </template>
    </v-alert>

    <!-- ---------------------------- 日志列表 ---------------------------- -->
    <v-card>
      <v-card-text class="pa-0">
        <div ref="listEl" class="nami-loglist">
          <div v-if="visibleEntries.length === 0" class="text-center py-10 text-medium-emphasis">
            <v-icon icon="mdiInboxOutline" size="36" class="mb-2" />
            <div class="text-body-2">
              {{ entries.length === 0 ? '缓冲里还没有日志。' : '当前搜索/级别过滤没有匹配的条目。' }}
            </div>
          </div>

          <template v-for="entry in visibleEntries" :key="entry.seq">
            <div class="nami-log" :class="rowClass(entry.level)">
              <span class="nami-log__time">{{ formatClock(entry.time) }}</span>
              <v-chip
                size="x-small"
                variant="tonal"
                :color="levelColor(entry.level)"
                class="nami-log__level"
                label
              >
                {{ entry.level }}
              </v-chip>
              <span class="nami-log__msg">{{ entry.msg }}</span>
              <v-btn
                v-if="hasFields(entry)"
                size="x-small"
                variant="text"
                :icon="expanded.has(entry.seq) ? 'mdiChevronUp' : 'mdiChevronDown'"
                :title="expanded.has(entry.seq) ? '收起字段' : '展开字段'"
                @click="toggleFields(entry.seq)"
              />
            </div>
            <div v-if="expanded.has(entry.seq)" class="nami-log__fields">
              <JsonBlock :value="entry.fields" label="fields" max-height="220px" />
            </div>
          </template>
        </div>
      </v-card-text>
    </v-card>

    <div class="text-caption text-medium-emphasis mt-3">
      本页最多保留最近 {{ MAX_ENTRIES }} 条（滚动时更旧的会从视图里移出，但服务器缓冲仍按
      <code class="nami-mono">NAMI_LOG_BUFFER_SIZE</code> 保存）。
      字段内容在服务器端按敏感键名（token、key、password 等）脱敏，脱敏结果就是
      <code class="nami-mono">***redacted***</code>。
    </div>

    <!-- ---------------------------- 清空确认 ---------------------------- -->
    <v-dialog v-model="clearDialog" max-width="520">
      <v-card>
        <v-card-title class="text-subtitle-2">清空日志缓冲？</v-card-title>
        <v-card-text>
          <div class="text-body-2">
            会清掉服务器内存里的 {{ meta.buffered }} 条日志，以及所有已经打开的“跟随实时”连接的历史。
            这个操作不可撤销，但不会影响磁盘上的任何文件。
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="clearDialog = false">取消</v-btn>
          <v-btn color="error" variant="tonal" :loading="clearing" @click="clearLogs">
            确认清空
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api } from '@/api/client';
import type { LogEntry } from '@/api/client';
import { describeError, formatClock, prettyJson, shell, toastError } from '@/composables/useShell';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';
import JsonBlock from '@/components/JsonBlock.vue';

const props = defineProps<{ refreshToken?: number }>();

/** 视图里最多留多少条：再多就会拖慢渲染，而且没人会往上翻两千行。 */
const MAX_ENTRIES = 2000;

const LEVELS = [
  { title: '全部级别', value: 'all' },
  { title: 'debug 及以上', value: 'debug' },
  { title: 'info 及以上', value: 'info' },
  { title: 'warn 及以上', value: 'warn' },
  { title: 'error 及以上', value: 'error' },
];

const LEVEL_COLORS: Record<string, string> = {
  debug: 'secondary',
  info: 'info',
  warn: 'warning',
  error: 'error',
  silent: 'secondary',
};

const entries = ref<LogEntry[]>([]);
const meta = reactive({ buffered: 0, capacity: 0, dropped: 0, captureLevel: '', lastSeq: 0 });

const level = ref('all');
const search = ref('');
const autoScroll = ref(true);
const follow = ref(true);
const paused = ref(false);
const expanded = ref<Set<number>>(new Set());
/** 暂停期间到达的条目先存起来，继续时补上——暂停不等于丢日志。 */
const pending = ref<LogEntry[]>([]);

const loading = ref(false);
const loadError = ref('');
const connError = ref('');
const clearing = ref(false);
const clearDialog = ref(false);

const listEl = ref<HTMLElement | null>(null);
let unsubscribe: (() => void) | null = null;

/* ------------------------------------------------------------------ *
 * 读取与实时订阅
 * ------------------------------------------------------------------ */

function levelFilter(): string | undefined {
  return level.value === 'all' ? undefined : level.value;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const response = await api.logs(300, levelFilter());
    entries.value = response.data;
    meta.buffered = response.buffered;
    meta.capacity = response.capacity;
    meta.dropped = response.dropped;
    meta.captureLevel = response.captureLevel;
    // 记住服务器的序号水位：之后重订阅都从这里续，既不重复也不漏。
    meta.lastSeq = response.lastSeq;
    if (autoScroll.value) scrollToBottom(false);
  } catch (e) {
    loadError.value = describeError(e);
  } finally {
    loading.value = false;
  }
}

function stopStream(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

function startStream(): void {
  stopStream();
  connError.value = '';
  if (!api.authenticated) {
    connError.value = '当前没有凭证，无法建立实时日志连接。请重新登录。';
    return;
  }
  unsubscribe = api.subscribeLogs(
    { onEntry: handleEntry, onError: handleStreamError },
    { level: levelFilter(), from: meta.lastSeq },
  );
}

function handleStreamError(): void {
  // EventSource 自带重连，这里只负责把状态讲清楚。
  connError.value =
    'SSE 连接出错（可能返回了 401/403，或者服务器暂时不可达）。下面的列表是断线前收到的内容。';
}

function handleEntry(entry: LogEntry): void {
  if (paused.value) {
    pending.value.push(entry);
    if (pending.value.length > MAX_ENTRIES) {
      pending.value.splice(0, pending.value.length - MAX_ENTRIES);
    }
    return;
  }
  append(entry);
}

function append(entry: LogEntry): void {
  // 先判断追加前用户是否贴在底部，否则一追加就会被判定为“已经不在底部”。
  const stick = autoScroll.value && isAtBottom();
  entries.value.push(entry);
  if (entry.seq > meta.lastSeq) meta.lastSeq = entry.seq;
  if (entries.value.length > MAX_ENTRIES) {
    entries.value.splice(0, entries.value.length - MAX_ENTRIES);
  }
  // 本地估算缓冲水位：容量已知时不越过容量（满了就是有旧条目被挤掉）。
  meta.buffered = meta.capacity > 0
    ? Math.min(meta.buffered + 1, meta.capacity)
    : meta.buffered + 1;
  if (stick) scrollToBottom(false);
}

function isAtBottom(): boolean {
  const el = listEl.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function scrollToBottom(force: boolean): void {
  void nextTick(() => {
    const el = listEl.value;
    if (!el) return;
    if (!force && !autoScroll.value) return;
    el.scrollTop = el.scrollHeight;
  });
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

function togglePause(): void {
  paused.value = !paused.value;
  if (paused.value) {
    shell.info('已暂停显示', '实时连接仍然开着，新日志会先缓存。');
    return;
  }
  const buffered = pending.value;
  pending.value = [];
  for (const entry of buffered) append(entry);
  if (buffered.length > 0) shell.success(`已继续，补上 ${buffered.length} 条缓存日志`);
  else shell.info('已继续');
}

async function clearLogs(): Promise<void> {
  clearing.value = true;
  try {
    const result = await api.clearLogs();
    entries.value = [];
    pending.value = [];
    expanded.value = new Set();
    meta.buffered = 0;
    meta.dropped = 0;
    clearDialog.value = false;
    // 注意：不清 lastSeq。服务器的 seq 只增不减，归零会导致重订阅时把历史又灌一遍。
    shell.success(`已清空 ${result.cleared} 条日志`);
  } catch (e) {
    toastError(e, '清空日志');
  } finally {
    clearing.value = false;
  }
}

function toggleFields(seq: number): void {
  const next = new Set(expanded.value);
  if (next.has(seq)) next.delete(seq);
  else next.add(seq);
  expanded.value = next;
}

function hasFields(entry: LogEntry): boolean {
  return entry.fields !== null && entry.fields !== undefined && Object.keys(entry.fields).length > 0;
}

function levelColor(value: string): string {
  return LEVEL_COLORS[value] ?? 'secondary';
}

function rowClass(value: string): string {
  if (value === 'error') return 'nami-log--error';
  if (value === 'warn') return 'nami-log--warn';
  if (value === 'debug') return 'nami-log--debug';
  return '';
}

/* ------------------------------------------------------------------ *
 * 过滤
 * ------------------------------------------------------------------ */

const visibleEntries = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (q === '') return entries.value;
  return entries.value.filter((entry) => {
    if (entry.msg.toLowerCase().includes(q)) return true;
    if (entry.level.toLowerCase().includes(q)) return true;
    if (hasFields(entry) && prettyJson(entry.fields).toLowerCase().includes(q)) return true;
    return false;
  });
});

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

/** 级别变了：重新拉一次（让已有列表也按新级别过滤），再用 lastSeq 续上实时流。 */
watch(level, () => {
  void (async () => {
    await load();
    if (follow.value) startStream();
  })();
});

watch(follow, (on) => {
  if (on) startStream();
  else stopStream();
});

onMounted(() => {
  void (async () => {
    await load();
    if (follow.value) startStream();
  })();
});

// 组件卸载必须断开 SSE，否则每次切页都会留下一条悬挂的 EventSource。
onUnmounted(() => {
  stopStream();
});

// 顶栏的全局刷新按钮会自增 refreshToken。
watch(
  () => props.refreshToken,
  () => {
    void load();
  },
);
</script>

<style scoped>
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}

.nami-loglist {
  max-height: calc(100vh - 460px);
  min-height: 340px;
  overflow-y: auto;
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
}

.nami-log {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 12px;
  /* 主题变量是 "r, g, b" 三元组，所以这里只能用 rgba()，不能用 rgb(x / y%)。 */
  border-bottom: 1px solid rgba(var(--v-theme-border-color, 35, 42, 54), 0.45);
  line-height: 1.5;
}

.nami-log:hover {
  background: rgba(var(--v-theme-surface-bright, 26, 33, 44), 0.6);
}

.nami-log--warn {
  background: rgba(var(--v-theme-warning, 251, 191, 36), 0.07);
  border-left: 2px solid rgb(var(--v-theme-warning, 251 191 36));
}

.nami-log--error {
  background: rgba(var(--v-theme-error, 248, 113, 113), 0.09);
  border-left: 2px solid rgb(var(--v-theme-error, 248 113 113));
}

.nami-log--debug {
  opacity: 0.72;
}

.nami-log__time {
  flex: 0 0 auto;
  width: 84px;
  color: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
}

.nami-log__level {
  flex: 0 0 auto;
  width: 62px;
  justify-content: center;
  /* chip 用比例字体，否则 debug/info 宽度差得太多 */
  font-family: 'Roboto', system-ui, sans-serif;
}

.nami-log__msg {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.nami-log__fields {
  padding: 8px 12px 12px 104px;
  border-bottom: 1px solid rgba(var(--v-theme-border-color, 35, 42, 54), 0.45);
}
</style>
