<template>
  <v-card variant="tonal" :color="meta.color" class="mb-2 nami-tool">
    <!-- 折叠标题本身就是状态行：一眼能看出是哪个工具、风险等级、成没成、花了多久。 -->
    <v-card-title class="d-flex align-center ga-2 py-2 text-body-2 flex-wrap">
      <v-icon :icon="meta.icon" :color="meta.color" size="18" />
      <span class="nami-mono font-weight-medium">{{ name }}</span>
      <DangerChip :level="danger" />
      <v-chip
        v-if="pending"
        size="x-small"
        color="info"
        variant="tonal"
        label
        :prepend-icon="icons.loading"
      >
        执行中
      </v-chip>
      <v-chip v-else size="x-small" :color="meta.color" variant="tonal" label>
        {{ meta.label }}
      </v-chip>
      <span v-if="result" class="text-caption text-medium-emphasis nami-mono">
        {{ formatDuration(result.durationMs) }}
      </span>
      <v-spacer />
      <v-progress-circular v-if="pending" indeterminate size="16" width="2" color="info" />
      <v-btn
        :icon="open ? icons.chevronUp : icons.chevronDown"
        variant="text"
        size="x-small"
        :title="open ? '折叠工具调用' : '展开工具调用'"
        @click="open = !open"
      />
    </v-card-title>

    <v-expand-transition>
      <div v-show="open">
        <v-divider />
        <v-card-text class="py-3">
          <!-- 参数是模型自己给出的原文，只展示不解释，便于核对它到底想干什么。 -->
          <JsonBlock :value="args" label="参数" max-height="200px" />

          <template v-if="result">
            <div v-if="result.content" class="mt-3">
              <div class="text-caption text-medium-emphasis mb-1">返回内容</div>
              <pre class="nami-tool__body">{{ result.content }}</pre>
            </div>

            <v-alert
              v-if="!result.ok"
              type="error"
              variant="tonal"
              density="comfortable"
              class="mt-3"
              title="工具调用失败"
            >
              <div class="text-body-2">{{ result.error || '工具没有返回错误详情。' }}</div>
            </v-alert>
          </template>
          <div v-else class="text-caption text-medium-emphasis mt-3">
            等待执行结果…
          </div>
        </v-card-text>
      </div>
    </v-expand-transition>
  </v-card>
</template>

<script setup lang="ts">
/**
 * 单个工具调用的可视化。
 *
 * 之所以把 `tool.call` 和 `tool.result` 合成一个组件而不是两条消息：SSE 到达时
 * 它们天然是一对（同一个 id），中途拆开会闪现一个语义不完整的空壳；同一个卡片
 * 先占位、后填结果，正好对应「模型决定调用」→「沙箱执行完」这两拍。
 *
 * 图标用 `@mdi/js` 的 path 字符串而不是 `mdiXxx` 名称：这个应用注册的是
 * `mdi-svg` 图标集（见 plugins/vuetify.ts），它只认 SVG path；`mdiXxx` 是
 * webfont 的类名，在这里会被当成一段非法 path 渲染成空白。
 */
import { computed, ref, watch } from 'vue';
import {
  mdiAlertCircleOutline,
  mdiCheckCircleOutline,
  mdiChevronDown,
  mdiChevronUp,
  mdiLoading,
  mdiTimerSand,
} from '@mdi/js';
import DangerChip from '@/components/DangerChip.vue';
import JsonBlock from '@/components/JsonBlock.vue';
import { formatDuration } from '@/composables/useShell';

/** 与 ChatView 的 TranscriptTool 对齐；单独声明是为了组件不反向依赖视图。 */
export interface ChatToolResult {
  ok: boolean;
  content: string;
  error?: string;
  durationMs: number;
}

const props = defineProps<{
  name: string;
  args: Record<string, unknown>;
  danger?: string;
  /** 尚未收到 `tool.result`。 */
  pending?: boolean;
  result?: ChatToolResult | null;
}>();

const open = ref(true);
const icons = {
  loading: mdiLoading,
  chevronDown: mdiChevronDown,
  chevronUp: mdiChevronUp,
} as const;

const meta = computed(() => {
  if (props.pending) return { label: '执行中', color: 'info', icon: mdiTimerSand };
  if (props.result?.ok === false) return { label: '失败', color: 'error', icon: mdiAlertCircleOutline };
  if (props.result?.ok === true) return { label: '成功', color: 'success', icon: mdiCheckCircleOutline };
  return { label: '已发起', color: 'secondary', icon: mdiTimerSand };
});

// 失败默认展开：那多半是操作者最想看的一张卡；成功则折叠，避免长返回内容刷屏。
watch(
  () => props.result,
  (result) => {
    if (result && !result.ok) open.value = true;
  },
);
</script>

<style scoped>
.nami-tool__body {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid rgb(var(--v-theme-border-color, 35 42 54));
  border-radius: 8px;
  background: rgb(var(--v-theme-surface-light));
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
</style>
