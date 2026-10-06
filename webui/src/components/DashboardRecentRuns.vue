<template>
  <v-card class="h-100">
    <v-card-title class="text-subtitle-1 d-flex align-center ga-2">
      <v-icon icon="mdiHistory" size="20" />
      最近运行
      <v-spacer />
      <span class="text-caption text-medium-emphasis">点击任意行查看详情</span>
    </v-card-title>
    <v-divider />
    <v-card-text>
      <AsyncSection
        :empty="runs.length === 0"
        empty-title="暂无运行记录"
        empty-hint="在「对话」页发起一次请求后，这里会出现运行历史。"
        empty-icon="mdiHistory"
      >
        <v-table density="comfortable">
          <thead>
            <tr>
              <th class="text-left">运行 ID</th>
              <th class="text-left">状态</th>
              <th class="text-right">轮次</th>
              <th class="text-right">工具</th>
              <th class="text-right">Token</th>
              <th class="text-right">耗时</th>
              <th class="text-left">开始</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="run in runs"
              :key="run.id"
              class="nami-row"
              tabindex="0"
              @click="open(run.id)"
              @keydown.enter="open(run.id)"
            >
              <td class="nami-mono" :title="run.id">{{ shortId(run.id) }}</td>
              <td>
                <v-chip :color="statusOf(run.status).color" variant="tonal" size="small" label>
                  {{ statusOf(run.status).label }}
                </v-chip>
              </td>
              <td class="text-right">{{ formatNumber(run.rounds) }}</td>
              <td class="text-right">{{ formatNumber(run.toolCalls) }}</td>
              <td
                class="text-right"
                :title="`prompt ${formatNumber(run.promptTokens)} / completion ${formatNumber(run.completionTokens)}`"
              >
                {{ formatNumber(run.promptTokens + run.completionTokens) }}
              </td>
              <td class="text-right">{{ runDuration(run) }}</td>
              <td :title="formatTime(run.startedAt)">{{ formatRelative(run.startedAt) }}</td>
            </tr>
          </tbody>
        </v-table>
      </AsyncSection>
    </v-card-text>

    <!-- 详情放在卡片里，但 v-dialog 会 teleport 到 body，不影响布局 -->
    <v-dialog v-model="dialog" max-width="880" scrollable>
      <v-card>
        <v-card-title class="d-flex align-center ga-2">
          <v-icon icon="mdiHistory" size="20" />
          <span class="text-body-2 nami-mono">{{ activeId }}</span>
          <v-spacer />
          <v-btn icon="mdiClose" variant="text" size="small" @click="dialog = false" />
        </v-card-title>
        <v-divider />
        <v-card-text>
          <AsyncSection
            :loading="loading"
            :error="error"
            :empty="detail === null"
            empty-title="没有这次运行的记录"
            empty-hint="运行记录可能已被清理。"
            @retry="retry"
          >
            <v-table density="comfortable" class="mb-4">
              <tbody>
                <tr v-for="row in rows" :key="row.label">
                  <td class="text-medium-emphasis" style="width: 132px">{{ row.label }}</td>
                  <td class="nami-break">{{ row.value }}</td>
                </tr>
              </tbody>
            </v-table>
            <JsonBlock :value="runJson" label="运行记录（原始 JSON）" class="mb-4" />
            <JsonBlock :value="toolJson" label="工具调用（原始 JSON）" />
          </AsyncSection>
        </v-card-text>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '@/api/client';
import type { Run } from '@/api/client';
import AsyncSection from '@/components/AsyncSection.vue';
import JsonBlock from '@/components/JsonBlock.vue';
import {
  describeError,
  formatDuration,
  formatNumber,
  formatRelative,
  formatTime,
} from '@/composables/useShell';

// 列表数据由父视图持有并轮询更新，这里只负责渲染与按需取详情。
defineProps<{ runs: Run[] }>();

const dialog = ref(false);
const activeId = ref('');
const detail = ref<{ run: Run; toolInvocations: unknown[] } | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);

const RUN_STATUS: Record<string, { label: string; color: string }> = {
  succeeded: { label: '成功', color: 'success' },
  failed: { label: '失败', color: 'error' },
  running: { label: '运行中', color: 'info' },
  cancelled: { label: '已取消', color: 'warning' },
};

function statusOf(status: string): { label: string; color: string } {
  return RUN_STATUS[status] ?? { label: status, color: 'secondary' };
}

function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 10)}…`;
}

/** 未结束的运行没有 endedAt，此时显示状态而不是一个假的耗时。 */
function runDuration(run: Run): string {
  if (run.endedAt === undefined || run.endedAt <= 0) return '运行中';
  return formatDuration(run.endedAt - run.startedAt);
}

const rows = computed(() => {
  const run = detail.value?.run;
  if (!run) return [];
  return [
    { label: '状态', value: `${statusOf(run.status).label}${run.error ? ` · ${run.error}` : ''}` },
    { label: '会话', value: run.sessionId },
    { label: '提供方 / 模型', value: `${run.provider} / ${run.model}` },
    { label: '轮次 / 工具调用', value: `${formatNumber(run.rounds)} / ${formatNumber(run.toolCalls)}` },
    {
      label: 'Token',
      value: `prompt ${formatNumber(run.promptTokens)} · completion ${formatNumber(run.completionTokens)}`,
    },
    { label: '耗时', value: runDuration(run) },
    { label: '开始时间', value: formatTime(run.startedAt) },
    { label: '结束时间', value: run.endedAt ? formatTime(run.endedAt) : '—' },
  ];
});

const runJson = computed<unknown>(() => detail.value?.run ?? null);
const toolJson = computed<unknown>(() => detail.value?.toolInvocations ?? []);

/** 工具调用明细单独取，列表接口不带它。 */
async function open(id: string): Promise<void> {
  activeId.value = id;
  detail.value = null;
  error.value = null;
  loading.value = true;
  dialog.value = true;
  try {
    const response = await api.run(id);
    detail.value = { run: response.run, toolInvocations: response.toolInvocations };
  } catch (caught) {
    error.value = describeError(caught);
  } finally {
    loading.value = false;
  }
}

function retry(): void {
  if (activeId.value !== '') void open(activeId.value);
}
</script>

<style scoped>
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
.nami-break {
  word-break: break-all;
  white-space: normal;
}
.nami-row {
  cursor: pointer;
}
.nami-row:focus-visible {
  outline: 2px solid rgb(var(--v-theme-primary));
  outline-offset: -2px;
}
</style>
