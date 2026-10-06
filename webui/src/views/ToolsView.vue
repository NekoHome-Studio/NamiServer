<template>
  <v-container fluid class="pa-6">
    <PageHeader title="工具" :subtitle="subtitle">
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

    <AsyncSection
      :loading="loading"
      :error="error"
      :empty="tools.length === 0"
      empty-title="没有注册任何工具"
      empty-hint="服务器启动时会注册内置工具；一个都没有说明启动参数或配置异常。"
      empty-icon="mdiToolboxOutline"
      @retry="load"
    >
      <!-- 概览：按危险等级分组，先说清楚哪些是危险的 -->
      <v-card class="mb-5">
        <v-card-title class="text-subtitle-1 d-flex flex-wrap align-center ga-2">
          <v-icon icon="mdiToolboxOutline" size="20" />
          工具概览
          <v-spacer />
          <v-chip variant="tonal" color="success" prepend-icon="mdiCheckCircleOutline" label>
            已启用 {{ enabledCount }}
          </v-chip>
          <v-chip variant="tonal" prepend-icon="mdiCancel" label>
            已禁用 {{ tools.length - enabledCount }}
          </v-chip>
          <v-chip variant="tonal" color="secondary" label>共 {{ tools.length }}</v-chip>
        </v-card-title>
        <v-divider />
        <v-card-text>
          <v-row dense>
            <v-col v-for="group in dangerGroups" :key="group.level" cols="12" sm="4">
              <div class="d-flex align-center ga-3">
                <v-avatar :color="group.color" variant="tonal" size="40" rounded="lg">
                  <v-icon :icon="group.icon" size="20" />
                </v-avatar>
                <div>
                  <div class="text-caption text-medium-emphasis">{{ group.label }}</div>
                  <div class="text-h6 font-weight-bold">{{ group.total }} 个</div>
                  <div class="text-caption text-medium-emphasis">已启用 {{ group.enabled }}</div>
                </div>
              </div>
            </v-col>
          </v-row>

          <v-alert
            type="warning"
            variant="tonal"
            density="comfortable"
            class="mt-4"
            icon="mdiShieldAlertOutline"
          >
            <div class="text-body-2">
              危险（dangerous）工具默认禁用：需要在服务器 .env 里显式打开对应开关与白名单，
              模型才可能调用到它们。风险等级只是提示，真正的边界始终由服务器端配置决定。
            </div>
          </v-alert>
        </v-card-text>
      </v-card>

      <!-- 过滤区 -->
      <div class="d-flex flex-wrap align-center ga-3 mb-4">
        <v-text-field
          v-model="filter"
          label="按名称或描述过滤"
          placeholder="例如 fs 或 读取文件"
          prepend-inner-icon="mdiMagnify"
          clearable
          density="comfortable"
          hide-details="auto"
          style="max-width: 360px"
        />
        <v-btn-toggle
          v-model="stateFilter"
          mandatory
          divided
          variant="outlined"
          density="comfortable"
          color="primary"
        >
          <v-btn value="all" prepend-icon="mdiFormatListBulleted">全部</v-btn>
          <v-btn value="enabled" prepend-icon="mdiCheckCircleOutline">已启用</v-btn>
          <v-btn value="disabled" prepend-icon="mdiCancel">已禁用</v-btn>
        </v-btn-toggle>
        <v-spacer />
        <span class="text-caption text-medium-emphasis">
          显示 {{ filtered.length }} / {{ tools.length }}
        </span>
      </div>

      <v-alert
        v-if="filtered.length === 0"
        type="info"
        variant="tonal"
        density="comfortable"
        icon="mdiMagnifyClose"
        title="没有匹配的工具"
      >
        <div class="text-body-2">换个关键字，或把筛选切回「全部」。</div>
      </v-alert>

      <!-- 工具卡片 -->
      <v-row v-else dense>
        <v-col v-for="tool in filtered" :key="tool.name" cols="12" md="6" xl="4">
          <v-card class="h-100 d-flex flex-column">
            <v-card-title class="d-flex flex-wrap align-center ga-2">
              <span class="nami-mono text-body-1">{{ tool.name }}</span>
              <DangerChip :level="tool.danger" />
              <v-chip
                :color="tool.enabled ? 'success' : 'secondary'"
                variant="tonal"
                size="small"
                label
              >
                {{ tool.enabled ? '已启用' : '已禁用' }}
              </v-chip>
              <v-chip
                v-if="!tool.implemented"
                color="warning"
                variant="tonal"
                size="small"
                label
                title="工具声明存在，但尚未实现，调用会直接失败。"
              >
                未实现
              </v-chip>
            </v-card-title>

            <v-card-text class="flex-grow-1 d-flex flex-column">
              <p class="text-body-2 mb-0">{{ tool.description }}</p>

              <v-alert
                v-if="hintFor(tool) !== ''"
                type="info"
                variant="tonal"
                density="comfortable"
                class="mt-3"
                icon="mdiInformationOutline"
              >
                <div class="text-body-2">{{ hintFor(tool) }}</div>
              </v-alert>

              <v-expansion-panels variant="accordion" class="mt-3">
                <v-expansion-panel>
                  <v-expansion-panel-title class="text-body-2">
                    <v-icon icon="mdiCodeJson" size="18" class="mr-2" />
                    参数 schema
                  </v-expansion-panel-title>
                  <v-expansion-panel-text>
                    <JsonBlock :value="tool.parameters" max-height="260px" />
                  </v-expansion-panel-text>
                </v-expansion-panel>
              </v-expansion-panels>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </AsyncSection>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import type { ToolEntry } from '@/api/client';
import AsyncSection from '@/components/AsyncSection.vue';
import DangerChip from '@/components/DangerChip.vue';
import JsonBlock from '@/components/JsonBlock.vue';
import PageHeader from '@/components/PageHeader.vue';
import { describeError, shell } from '@/composables/useShell';

const props = defineProps<{ refreshToken?: number }>();

const tools = ref<ToolEntry[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);

const filter = ref('');
const stateFilter = ref<'all' | 'enabled' | 'disabled'>('all');

const enabledCount = computed(() => tools.value.filter((tool) => tool.enabled).length);

const subtitle = computed(
  () =>
    `模型的每一次工具调用都经过服务器沙箱：入参按 schema 校验、超时会被中止、过长的结果会被截断。` +
    `已启用 ${enabledCount.value} / 共 ${tools.value.length} 个工具。`,
);

interface DangerGroup {
  level: ToolEntry['danger'];
  label: string;
  color: string;
  icon: string;
  total: number;
  enabled: number;
}

/** 三个等级固定展示（哪怕为 0），这样一眼能看出「危险工具一个都没开」。 */
const dangerGroups = computed<DangerGroup[]>(() => {
  const metas: Array<Pick<DangerGroup, 'level' | 'label' | 'color' | 'icon'>> = [
    { level: 'safe', label: '安全', color: 'success', icon: 'mdiShieldCheckOutline' },
    { level: 'caution', label: '需谨慎', color: 'warning', icon: 'mdiAlertOutline' },
    { level: 'dangerous', label: '危险', color: 'error', icon: 'mdiAlertOctagonOutline' },
  ];
  return metas.map((meta) => {
    const group = tools.value.filter((tool) => tool.danger === meta.level);
    return {
      ...meta,
      total: group.length,
      enabled: group.filter((tool) => tool.enabled).length,
    };
  });
});

const filtered = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  return tools.value.filter((tool) => {
    if (stateFilter.value === 'enabled' && !tool.enabled) return false;
    if (stateFilter.value === 'disabled' && tool.enabled) return false;
    if (needle === '') return true;
    return (
      tool.name.toLowerCase().includes(needle) ||
      tool.description.toLowerCase().includes(needle)
    );
  });
});

/**
 * 禁用的原因写在服务器配置里，前端只能按工具名把可能的原因列出来。
 * 顺序重要：`onebot_send_*` 的开关比 `onebot_*` 多一层。
 */
function hintFor(tool: ToolEntry): string {
  if (tool.enabled) return '';
  const { name } = tool;
  if (name === 'http_get') {
    return '需要 NAMI_TOOL_HTTP_ENABLED=true，并且 NAMI_TOOL_HTTP_ALLOW_HOSTS 非空（没有白名单就不会开放外网请求）。';
  }
  if (name === 'fs_read' || name === 'fs_list') {
    return '需要 NAMI_TOOL_FS_ENABLED=true，并且 NAMI_TOOL_FS_ALLOW_ROOTS 非空（没有允许的根目录就不会开放文件访问）。';
  }
  if (name.startsWith('onebot_send_')) {
    return '需要 NAMI_ONEBOT_ENABLED=true，还需要 NAMI_ONEBOT_TOOL_ENABLED=true，以及非空的 NAMI_ONEBOT_TOOL_ALLOW_GROUPS 或 NAMI_ONEBOT_TOOL_ALLOW_USERS。';
  }
  if (name.startsWith('onebot_')) {
    return '需要 NAMI_ONEBOT_ENABLED=true。';
  }
  return '';
}

async function load(): Promise<void> {
  error.value = null;
  try {
    const response = await api.tools();
    tools.value = response.data;
  } catch (caught) {
    error.value = describeError(caught);
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  await load();
  if (error.value === null) shell.success('工具列表已刷新');
  refreshing.value = false;
}

// 外壳的全局刷新按钮会加一 refreshToken，视图据此重新取数。
watch(() => props.refreshToken, load);

onMounted(() => {
  void load();
});
</script>

<style scoped>
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
</style>
