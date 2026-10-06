<template>
  <v-container fluid class="pa-6">
    <PageHeader title="仪表盘" :subtitle="subtitle">
      <template #actions>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdiRefresh"
          :loading="refreshing"
          @click="refresh"
        >
          刷新
        </v-btn>
      </template>
    </PageHeader>

    <!-- 就绪状态单独成条，不进 AsyncSection：/readyz 用 503 表达「进程活着但还不能干活」，
         那是需要展示的状态，而不是页面加载失败。 -->
    <v-alert
      v-if="readinessProbed"
      :type="readinessAlert.type"
      :icon="readinessAlert.icon"
      variant="tonal"
      class="mb-5"
      :title="readinessAlert.title"
    >
      <div v-if="readiness.message" class="text-body-2">{{ readiness.message }}</div>

      <div v-if="checkEntries.length > 0" class="d-flex flex-wrap ga-2 mb-1">
        <v-chip
          v-for="check in checkEntries"
          :key="check.key"
          :color="check.color"
          variant="tonal"
          size="small"
          label
        >
          <span class="nami-mono">{{ check.key }}</span>
          <span class="mx-1">·</span>
          <span>{{ check.value }}</span>
        </v-chip>
      </div>

      <div v-if="modelMissing" class="text-body-2 mt-2">
        这台机器上没有可用的模型。请在装有 Ollama 的机器上执行
        <code class="nami-code">npm run ollama -- --write</code>，让它挑选一个模型并写回 .env。
      </div>
    </v-alert>

    <AsyncSection :loading="loading" :error="error" @retry="load">
      <!-- 指标卡 -->
      <v-row dense class="mb-1">
        <v-col cols="12" sm="6" md="4" lg="3">
          <StatCard
            label="请求总数"
            icon="mdiSwapHorizontal"
            tone="primary"
            :value="formatNumber(metrics?.requests.total)"
            :hint="`错误 ${formatNumber(metrics?.requests.errors)} · 拒绝鉴权 ${formatNumber(metrics?.requests.rejectedAuth)}`"
          />
        </v-col>
        <v-col cols="12" sm="6" md="4" lg="3">
          <StatCard
            label="运行次数"
            icon="mdiPlayCircleOutline"
            :value="formatNumber(metrics?.agent.runsStarted)"
            :hint="`完成 ${formatNumber(metrics?.agent.runsCompleted)} · 失败 ${formatNumber(metrics?.agent.runsFailed)} · 取消 ${formatNumber(metrics?.agent.runsCancelled)}`"
          />
        </v-col>
        <v-col cols="12" sm="6" md="4" lg="3">
          <StatCard
            label="工具调用"
            icon="mdiWrenchOutline"
            :value="formatNumber(metrics?.agent.toolCalls)"
            :hint="`流式增量事件 ${formatNumber(metrics?.agent.deltaEvents)}`"
          />
        </v-col>
        <v-col cols="12" sm="6" md="4" lg="3">
          <StatCard
            label="流式字符"
            icon="mdiFormatLetterCase"
            :value="formatNumber(metrics?.agent.streamedChars)"
            hint="通过 SSE 推送给客户端的字符累计"
          />
        </v-col>
        <v-col cols="12" sm="6" md="4" lg="3">
          <StatCard
            label="会话数"
            icon="mdiCommentMultipleOutline"
            :value="formatNumber(overview?.store.counts.sessions)"
            :hint="`消息 ${formatNumber(overview?.store.counts.messages)} 条`"
          />
        </v-col>
        <v-col cols="12" sm="6" md="4" lg="3">
          <StatCard
            label="消息数"
            icon="mdiMessageTextOutline"
            :value="formatNumber(overview?.store.counts.messages)"
            :hint="`运行记录 ${formatNumber(overview?.store.counts.runs)} 条`"
          />
        </v-col>
        <v-col cols="12" sm="6" md="4" lg="3">
          <StatCard
            label="活跃 WebSocket"
            icon="mdiAccessPoint"
            tone="info"
            :value="formatNumber(metrics?.websocket.active)"
            :hint="`累计连接 ${formatNumber(metrics?.websocket.connectionsOpened)} · 消息 收 ${formatNumber(metrics?.websocket.messagesIn)} / 发 ${formatNumber(metrics?.websocket.messagesOut)}`"
          />
        </v-col>
        <v-col cols="12" sm="6" md="4" lg="3">
          <StatCard
            label="运行时长"
            icon="mdiClockOutline"
            :value="formatUptime(overview?.uptimeSeconds)"
            :hint="`启动于 ${formatTime(overview?.startedAt)}`"
          />
        </v-col>
      </v-row>

      <v-row dense>
        <!-- 工具使用统计 -->
        <v-col cols="12" lg="5">
          <v-card class="h-100">
            <v-card-title class="text-subtitle-1 d-flex align-center ga-2">
              <v-icon icon="mdiWrenchOutline" size="20" />
              工具使用统计
              <v-spacer />
              <span class="text-caption text-medium-emphasis">按调用次数排序</span>
            </v-card-title>
            <v-divider />
            <v-card-text>
              <AsyncSection
                :empty="toolUsage.length === 0"
                empty-title="暂无工具调用"
                empty-hint="模型还没有调用过任何工具。"
                empty-icon="mdiWrenchOutline"
              >
                <v-table density="comfortable">
                  <thead>
                    <tr>
                      <th class="text-left">工具</th>
                      <th class="text-right">调用</th>
                      <th class="text-right">失败</th>
                      <th class="text-right">平均耗时</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="stat in toolUsage" :key="stat.name">
                      <td class="nami-mono">{{ stat.name }}</td>
                      <td class="text-right">{{ formatNumber(stat.calls) }}</td>
                      <td class="text-right" :class="stat.failures > 0 ? 'text-error' : undefined">
                        {{ formatNumber(stat.failures) }}
                      </td>
                      <td class="text-right">{{ formatDuration(stat.avgMs) }}</td>
                    </tr>
                  </tbody>
                </v-table>
              </AsyncSection>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- 最近运行：列表与详情对话框都在子组件里，避免本视图继续变长 -->
        <v-col cols="12" lg="7">
          <DashboardRecentRuns :runs="recentRuns" />
        </v-col>
      </v-row>

      <!-- 运行时信息 -->
      <DashboardRuntimeCard class="mt-4" :overview="overview" :health="health" />
    </AsyncSection>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import type {
  HealthResponse,
  MetricsSnapshot,
  OverviewResponse,
  Run,
  StatsResponse,
  ToolUsageStat,
} from '@/api/client';
import AsyncSection from '@/components/AsyncSection.vue';
import DashboardRecentRuns from '@/components/DashboardRecentRuns.vue';
import DashboardRuntimeCard from '@/components/DashboardRuntimeCard.vue';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';
import {
  describeError,
  formatDuration,
  formatNumber,
  formatTime,
  formatUptime,
  shell,
} from '@/composables/useShell';

const props = defineProps<{ refreshToken?: number }>();

/** 轮询间隔：够快能看到运行状态变化，又不至于让一台空闲服务器一直有请求。 */
const REFRESH_MS = 10_000;

const overview = ref<OverviewResponse | null>(null);
const metrics = ref<MetricsSnapshot | null>(null);
const stats = ref<StatsResponse | null>(null);
const health = ref<HealthResponse | null>(null);

/**
 * 就绪状态。`readinessKnown` 区分「服务器明确说未就绪」和「连就绪接口都拿不到答案」：
 * 前者是红色的确定结论，后者是琥珀色的疑问。
 */
const readiness = ref<{ ready: boolean; checks: Record<string, string>; message: string | null }>({
  ready: false,
  checks: {},
  message: null,
});
const readinessKnown = ref(false);
const readinessProbed = ref(false);

const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);

let timer: number | undefined;
/** 防止自动轮询与手动刷新叠在一起发请求。 */
let inflight = false;

const subtitle = computed(() => {
  const info = overview.value;
  if (!info) return '服务健康、运行指标与最近运行概览';
  const model = info.model === '' ? '未选择模型' : info.model;
  return `${info.provider} / ${model} · 版本 ${info.version} · 每 10 秒自动刷新`;
});

const readinessAlert = computed<{ type: 'success' | 'warning' | 'error'; title: string; icon: string }>(
  () => {
    if (readiness.value.ready) {
      return { type: 'success', title: '服务已就绪', icon: 'mdiCheckCircleOutline' };
    }
    if (!readinessKnown.value) {
      return { type: 'warning', title: '无法确认就绪状态', icon: 'mdiHelpCircleOutline' };
    }
    return { type: 'error', title: '服务尚未就绪', icon: 'mdiAlertCircleOutline' };
  },
);

/**
 * readyz 的 value 大多是自由文本（例如 `models` 探测失败时直接是上游错误），
 * 所以只能按有限的已知词表上色，认不出来的一律当作正常。
 */
function checkColor(key: string, value: string): string {
  if (value === 'ok' || value === 'configured') return 'success';
  if (key === 'provider') return 'info';
  if (value === 'none selected' || value === 'missing' || value === 'not probed') return 'error';
  if (key === 'models' && !value.includes('available')) return 'error';
  return 'success';
}

const checkEntries = computed(() =>
  Object.entries(readiness.value.checks).map(([key, value]) => ({
    key,
    value,
    color: checkColor(key, value),
  })),
);

const modelMissing = computed(() => readiness.value.checks.model === 'none selected');

const toolUsage = computed<ToolUsageStat[]>(() => stats.value?.toolUsage ?? []);
const recentRuns = computed<Run[]>(() => stats.value?.recentRuns ?? []);

/**
 * 核心数据一次取齐：任一失败都视为页面失败，让 AsyncSection 给出统一的重试入口。
 * 健康与就绪探针则各自独立，因为它们失败是「要展示的事实」而不是页面错误。
 *
 * @returns 是否真的发起了请求；与正在进行的轮询撞车时会跳过。
 */
async function load(): Promise<boolean> {
  if (inflight) return false;
  inflight = true;
  error.value = null;

  const probes = loadProbes();
  try {
    const [overviewResponse, metricsResponse, statsResponse] = await Promise.all([
      api.overview(),
      api.metrics(),
      api.stats(),
    ]);
    overview.value = overviewResponse;
    metrics.value = metricsResponse;
    stats.value = statsResponse;
  } catch (caught) {
    error.value = describeError(caught);
  } finally {
    // 只有首屏才让页面空白；之后的重载就地更新，避免每次轮询都闪一下。
    loading.value = false;
    inflight = false;
  }

  await probes;
  return true;
}

async function loadProbes(): Promise<void> {
  try {
    health.value = await api.health();
  } catch {
    health.value = null;
  }

  await probeReadyz();
  // 首次探测有结果后才亮出横幅，避免刚进页面就闪一下「无法确认就绪状态」。
  readinessProbed.value = true;
}

async function probeReadyz(): Promise<void> {
  try {
    const response = await api.readyz();
    readiness.value = { ready: response.ready, checks: response.checks, message: null };
    readinessKnown.value = true;
    return;
  } catch (caught) {
    // 未就绪时 /readyz 回 503，客户端的 request() 会抛 ApiError 并丢掉响应体，
    // 而 checks 恰恰是这时候最该展示的东西。所以用一次裸 fetch 把同一个响应读回来；
    // 连裸 fetch 都失败，才退回到「只知道失败，不知道原因」的琥珀色状态。
    const raw = await readRawReadyz();
    if (raw !== null) {
      readiness.value = { ready: raw.ready, checks: raw.checks, message: null };
      readinessKnown.value = true;
      return;
    }
    readiness.value = { ready: false, checks: {}, message: describeError(caught) };
    readinessKnown.value = false;
  }
}

/** 裸读 /readyz：该接口本来就不需要凭证，所以不带任何鉴权头。 */
async function readRawReadyz(): Promise<{ ready: boolean; checks: Record<string, string> } | null> {
  try {
    const response = await fetch('/readyz', { headers: { accept: 'application/json' } });
    const payload = (await response.json()) as { ready?: unknown; checks?: unknown };
    if (typeof payload.ready !== 'boolean') return null;
    return { ready: payload.ready, checks: isStringRecord(payload.checks) ? payload.checks : {} };
  } catch {
    return null;
  }
}

/** 服务端保证 checks 是字符串字典，但 503 的响应体不属于错误信封，值得校验一次再渲染。 */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  const ran = await load();
  // 和自动轮询撞车时 load 会跳过，此时不该谎报「已刷新」。
  if (ran && error.value === null) shell.success('仪表盘已刷新');
  refreshing.value = false;
}

// 外壳的全局刷新按钮会把 refreshToken 加一，视图据此重新取数。
watch(() => props.refreshToken, load);

onMounted(() => {
  void load();
  timer = window.setInterval(() => {
    // 标签页在后台时没人看这份数据，省掉这轮请求。
    if (document.hidden || inflight) return;
    void load();
  }, REFRESH_MS);
});

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer);
});
</script>

<style scoped>
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
.nami-code {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 0.9em;
}
</style>
