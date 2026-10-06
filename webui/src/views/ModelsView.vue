<template>
  <v-container fluid class="pa-6">
    <PageHeader
      title="模型"
      subtitle="这是客户端可以选择的模型目录：别名与暴露范围决定了对外可见的名字，模型本身来自上游提供方。"
    >
      <template #actions>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdiRadar"
          :loading="refreshing"
          @click="rediscover"
        >
          重新探测
        </v-btn>
      </template>
    </PageHeader>

    <v-alert
      v-if="catalogue && !catalogue.discoveryOk"
      type="warning"
      variant="tonal"
      class="mb-5"
      icon="mdiAlertOutline"
      title="上游模型探测失败"
    >
      <div class="text-body-2">{{ catalogue.lastError ?? '上游没有返回可用的模型列表。' }}</div>
      <div class="text-caption mt-1">
        下面展示的可能是上一次探测的缓存结果；修正上游地址或让 Ollama 起来后再点「重新探测」。
      </div>
    </v-alert>

    <AsyncSection
      :loading="loading"
      :error="error"
      :empty="(catalogue?.data.length ?? 0) === 0"
      empty-title="没有发现任何模型"
      empty-hint="上游目录为空：请确认提供方可达，或先在上游拉取一个模型。"
      empty-icon="mdiCubeOutline"
      @retry="reload"
    >
      <!-- 状态条 -->
      <v-card class="mb-5">
        <v-card-text class="d-flex flex-wrap align-center ga-3">
          <v-chip variant="tonal" color="primary" prepend-icon="mdiServerOutline" label>
            {{ catalogue?.provider ?? '—' }}
          </v-chip>
          <v-chip variant="tonal" prepend-icon="mdiLinkVariant" label>
            {{ catalogue?.baseUrl ?? '—' }}
          </v-chip>
          <v-chip variant="tonal" prepend-icon="mdiStarOutline" label>
            默认 {{ catalogue?.defaultModel ? catalogue.defaultModel : '未选择' }}
          </v-chip>
          <v-chip
            :color="catalogue?.discoveryOk ? 'success' : 'error'"
            variant="tonal"
            :prepend-icon="catalogue?.discoveryOk ? 'mdiCheckCircleOutline' : 'mdiCloseCircleOutline'"
            label
          >
            探测{{ catalogue?.discoveryOk ? '正常' : '失败' }}
          </v-chip>
          <v-chip
            :color="catalogue?.allowClientModel ? 'success' : 'secondary'"
            variant="tonal"
            :prepend-icon="catalogue?.allowClientModel ? 'mdiAccountCheckOutline' : 'mdiAccountOffOutline'"
            label
          >
            客户端可选模型：{{ catalogue?.allowClientModel ? '开' : '关' }}
          </v-chip>
          <v-chip variant="tonal" color="secondary" label>
            共 {{ catalogue?.data.length ?? 0 }} 个 · 未安装 {{ notInstalledCount }}
          </v-chip>
          <v-spacer />
          <span class="text-caption text-medium-emphasis">
            探测结果有缓存 TTL，只有「重新探测」才会强制忽略它。
          </span>
        </v-card-text>
      </v-card>

      <!-- 目录表 -->
      <v-card class="mb-5">
        <v-card-title class="text-subtitle-1 d-flex align-center ga-2">
          <v-icon icon="mdiCubeOutline" size="20" />
          模型目录
          <v-spacer />
          <span class="text-caption text-medium-emphasis">按 ID 或别名过滤</span>
        </v-card-title>
        <v-divider />
        <v-card-text>
          <v-text-field
            v-model="filter"
            label="过滤模型"
            placeholder="例如 llama3 或 nami-fast"
            prepend-inner-icon="mdiMagnify"
            clearable
            density="comfortable"
            hide-details="auto"
            class="mb-4"
            style="max-width: 420px"
          />

          <AsyncSection
            :empty="rows.length === 0"
            empty-title="没有匹配的模型"
            empty-hint="换个关键字，或清空过滤框。"
            empty-icon="mdiMagnifyClose"
          >
            <v-table density="comfortable">
              <thead>
                <tr>
                  <th class="text-left">模型 ID</th>
                  <th class="text-left">状态</th>
                  <th class="text-left">别名</th>
                  <th class="text-left">参数</th>
                  <th class="text-left">量化</th>
                  <th class="text-right">大小</th>
                  <th class="text-left">家族</th>
                  <th class="text-right">元数据</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.entry.id">
                  <td class="nami-mono" :class="row.entry.isDefault ? 'font-weight-bold' : undefined">
                    {{ row.entry.id }}
                  </td>
                  <td>
                    <div class="d-flex flex-wrap ga-1">
                      <v-chip
                        v-if="row.entry.isDefault"
                        color="primary"
                        variant="tonal"
                        size="small"
                        label
                      >
                        默认
                      </v-chip>
                      <v-chip
                        :color="row.entry.exposed ? 'success' : 'secondary'"
                        variant="tonal"
                        size="small"
                        label
                      >
                        {{ row.entry.exposed ? '已暴露' : '未暴露' }}
                      </v-chip>
                      <v-chip
                        v-if="row.notInstalled"
                        color="warning"
                        variant="tonal"
                        size="small"
                        label
                        prepend-icon="mdiAlertOutline"
                        title="NAMI_MODEL_ALIASES 指向了这个模型，但上游目录里没有它。"
                      >
                        未安装
                      </v-chip>
                    </div>
                  </td>
                  <td>
                    <div v-if="row.entry.aliases.length > 0" class="d-flex flex-wrap ga-1">
                      <v-chip
                        v-for="alias in row.entry.aliases"
                        :key="alias"
                        variant="tonal"
                        size="small"
                        label
                        class="nami-mono"
                      >
                        {{ alias }} → {{ row.entry.id }}
                      </v-chip>
                    </div>
                    <span v-else class="text-medium-emphasis">—</span>
                  </td>
                  <td>{{ row.parameters || '—' }}</td>
                  <td>{{ row.quantization || '—' }}</td>
                  <td class="text-right">{{ row.sizeBytes === null ? '—' : formatBytes(row.sizeBytes) }}</td>
                  <td>{{ row.family || '—' }}</td>
                  <td class="text-right">
                    <v-btn
                      size="small"
                      variant="text"
                      :prepend-icon="row.hasMeta ? 'mdiCodeJson' : 'mdiInformationOutline'"
                      @click="openDetail(row.entry)"
                    >
                      详情
                    </v-btn>
                  </td>
                </tr>
              </tbody>
            </v-table>
          </AsyncSection>

          <p class="text-caption text-medium-emphasis mt-3 mb-0">
            「未安装」表示 <code class="nami-code">NAMI_MODEL_ALIASES</code>
            指向的模型在上游目录里不存在——通常是别名拼错了，或者模型还没 pull 下来。
          </p>
        </v-card-text>
      </v-card>

      <!-- 对外可见的名字 -->
      <v-card class="mb-5">
        <v-card-title class="text-subtitle-1 d-flex align-center ga-2">
          <v-icon icon="mdiAccountMultipleOutline" size="20" />
          对外可见的模型名
          <v-spacer />
          <span class="text-caption text-medium-emphasis">GET /v1/models 的原始返回</span>
        </v-card-title>
        <v-divider />
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis">
            这就是一个 OpenAI 客户端调用 <code class="nami-code">GET /v1/models</code>
            时看到的全部名字；标为「别名」的条目会由服务器解析到真实的上游模型。
          </p>

          <AsyncSection
            :loading="openaiLoading"
            :error="openaiError"
            :empty="exposedModels.length === 0"
            empty-title="没有对外可见的模型"
            empty-hint="暴露列表为空且上游无模型，或者全部模型都被 NAMI_MODELS_EXPOSE 过滤掉了。"
            empty-icon="mdiAccountOffOutline"
            @retry="reload"
          >
            <v-table density="comfortable">
              <thead>
                <tr>
                  <th class="text-left">模型名</th>
                  <th class="text-left">类型</th>
                  <th class="text-left">归属</th>
                  <th class="text-left">别名指向</th>
                  <th class="text-left">创建时间</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="model in exposedModels" :key="model.id">
                  <td class="nami-mono">
                    {{ model.id }}
                    <v-chip
                      v-if="aliasOf(model) !== ''"
                      color="info"
                      variant="tonal"
                      size="small"
                      label
                      class="ml-2"
                    >
                      别名
                    </v-chip>
                  </td>
                  <td class="nami-mono">{{ model.object }}</td>
                  <td class="nami-mono">{{ model.owned_by }}</td>
                  <td class="nami-mono">{{ aliasOf(model) || '—' }}</td>
                  <td>{{ formatTime(model.created * 1000) }}</td>
                </tr>
              </tbody>
            </v-table>
          </AsyncSection>
        </v-card-text>
      </v-card>

      <!-- 配置提示 -->
      <v-card>
        <v-card-title class="text-subtitle-1 d-flex align-center ga-2">
          <v-icon icon="mdiTuneVariant" size="20" />
          配置提示
        </v-card-title>
        <v-divider />
        <v-card-text>
          <p class="text-body-2 text-medium-emphasis mb-3">
            这两项决定哪些模型对外可见，它们在「配置」页修改
            （<code class="nami-code">NAMI_MODELS_EXPOSE</code> /
            <code class="nami-code">NAMI_MODEL_ALIASES</code>），本页只做展示。
          </p>

          <div class="text-caption text-medium-emphasis mb-1">暴露列表（expose）</div>
          <div class="d-flex flex-wrap ga-2 mb-4">
            <v-chip
              v-for="name in catalogue?.expose ?? []"
              :key="name"
              variant="tonal"
              color="primary"
              label
              class="nami-mono"
            >
              {{ name }}
            </v-chip>
            <span v-if="(catalogue?.expose.length ?? 0) === 0" class="text-body-2 text-medium-emphasis">
              空 —— 不限制，所有已发现的模型都对外可见。
            </span>
          </div>

          <div class="text-caption text-medium-emphasis mb-1">别名映射（aliases）</div>
          <div class="d-flex flex-wrap ga-2">
            <v-chip
              v-for="entry in aliasEntries"
              :key="entry[0]"
              variant="tonal"
              color="info"
              label
              class="nami-mono"
            >
              {{ entry[0] }} → {{ entry[1] }}
            </v-chip>
            <span v-if="aliasEntries.length === 0" class="text-body-2 text-medium-emphasis">
              空 —— 没有配置别名。
            </span>
          </div>
        </v-card-text>
      </v-card>
    </AsyncSection>

    <!-- 模型详情：meta 是上游自由字段，直接给原始 JSON 比猜字段更可靠 -->
    <v-dialog v-model="detailDialog" max-width="720" scrollable>
      <v-card>
        <v-card-title class="d-flex align-center ga-2">
          <v-icon icon="mdiCubeOutline" size="20" />
          <span class="nami-mono text-body-2">{{ activeEntry?.id ?? '' }}</span>
          <v-spacer />
          <v-btn icon="mdiClose" variant="text" size="small" @click="detailDialog = false" />
        </v-card-title>
        <v-divider />
        <v-card-text>
          <v-table density="compact" class="mb-4">
            <tbody>
              <tr>
                <td class="text-medium-emphasis" style="width: 120px">归属</td>
                <td class="nami-mono">{{ activeEntry?.ownedBy ?? '—' }}</td>
              </tr>
              <tr>
                <td class="text-medium-emphasis">默认模型</td>
                <td>{{ activeEntry?.isDefault ? '是' : '否' }}</td>
              </tr>
              <tr>
                <td class="text-medium-emphasis">对外暴露</td>
                <td>{{ activeEntry?.exposed ? '是' : '否' }}</td>
              </tr>
              <tr>
                <td class="text-medium-emphasis">别名</td>
                <td class="nami-mono">
                  {{ activeEntry && activeEntry.aliases.length > 0 ? activeEntry.aliases.join('、') : '—' }}
                </td>
              </tr>
              <tr>
                <td class="text-medium-emphasis">创建时间</td>
                <td>
                  {{ activeEntry?.created ? formatTime(activeEntry.created * 1000) : '—' }}
                </td>
              </tr>
            </tbody>
          </v-table>

          <v-alert
            v-if="activeEntry?.meta?.notInstalled === true"
            type="warning"
            variant="tonal"
            density="comfortable"
            class="mb-4"
            icon="mdiAlertOutline"
          >
            <div class="text-body-2">
              这个模型只在别名映射里出现，上游目录中并不存在，因此任何请求都会失败。
            </div>
          </v-alert>

          <JsonBlock :value="activeEntry?.meta ?? {}" label="上游元数据（meta）" />
        </v-card-text>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import type { ModelEntry, ModelsResponse, OpenAiModel } from '@/api/client';
import AsyncSection from '@/components/AsyncSection.vue';
import JsonBlock from '@/components/JsonBlock.vue';
import PageHeader from '@/components/PageHeader.vue';
import { describeError, formatBytes, formatTime, shell } from '@/composables/useShell';

const props = defineProps<{ refreshToken?: number }>();

const catalogue = ref<ModelsResponse | null>(null);
const exposedModels = ref<OpenAiModel[]>([]);

const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);
const openaiLoading = ref(false);
const openaiError = ref<string | null>(null);

const filter = ref('');
const detailDialog = ref(false);
const activeEntry = ref<ModelEntry | null>(null);

/** meta 是上游的自由字段（Ollama 给 size/参数/量化，别的提供方可能什么都没有）。 */
function metaString(meta: Record<string, unknown> | undefined, key: string): string {
  const value = meta?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function metaNumber(meta: Record<string, unknown> | undefined, key: string): number | null {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function aliasOf(model: OpenAiModel): string {
  const value = model.nami?.aliasOf;
  return typeof value === 'string' ? value : '';
}

/** 过滤只针对 ID 与别名：这两个才是调用方真正会写的名字。 */
const rows = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  const list = catalogue.value?.data ?? [];
  const matched =
    needle === ''
      ? list
      : list.filter(
          (entry) =>
            entry.id.toLowerCase().includes(needle) ||
            entry.aliases.some((alias) => alias.toLowerCase().includes(needle)),
        );

  return matched.map((entry) => ({
    entry,
    parameters: metaString(entry.meta, 'parameters'),
    quantization: metaString(entry.meta, 'quantization'),
    family: metaString(entry.meta, 'family'),
    sizeBytes: metaNumber(entry.meta, 'sizeBytes'),
    notInstalled: entry.meta?.notInstalled === true,
    hasMeta: entry.meta !== undefined && Object.keys(entry.meta).length > 0,
  }));
});

const notInstalledCount = computed(
  () => (catalogue.value?.data ?? []).filter((entry) => entry.meta?.notInstalled === true).length,
);

const aliasEntries = computed(() => Object.entries(catalogue.value?.aliases ?? {}));

/**
 * 取目录并顺带刷新 /v1/models。
 *
 * `force` 只在用户明确要重新探测时为 true：目录有缓存 TTL，每次进页面都强制探测
 * 会让上游被无谓地打一遍。
 */
async function load(force: boolean): Promise<void> {
  // 只有首屏才清空页面；之后的重载就地更新，免得每次刷新都闪一下。
  loading.value = catalogue.value === null;
  error.value = null;
  openaiError.value = null;

  try {
    catalogue.value = await api.models(force);
  } catch (caught) {
    error.value = describeError(caught);
  } finally {
    loading.value = false;
  }

  // 目录本身都拿不到时，再去问 /v1/models 只会撞上同一个错误。
  if (error.value !== null) return;

  openaiLoading.value = true;
  try {
    const response = await api.openaiModels();
    exposedModels.value = response.data;
  } catch (caught) {
    openaiError.value = describeError(caught);
  } finally {
    openaiLoading.value = false;
  }
}

function reload(): Promise<void> {
  return load(false);
}

async function rediscover(): Promise<void> {
  refreshing.value = true;
  await load(true);
  if (error.value === null) shell.success('已重新探测模型目录');
  refreshing.value = false;
}

function openDetail(entry: ModelEntry): void {
  activeEntry.value = entry;
  detailDialog.value = true;
}

// 外壳的全局刷新按钮会加一 refreshToken；这里用箭头包一层，避免把序号当成 force 参数。
watch(() => props.refreshToken, () => {
  void reload();
});

onMounted(() => {
  void reload();
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
