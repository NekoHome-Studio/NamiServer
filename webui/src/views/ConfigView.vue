<template>
  <v-container fluid class="pa-6">
    <PageHeader
      title="配置"
      subtitle="这里的修改会写进项目根目录的 .env。Nami 不做热重载，所有字段都需要重启后才生效。"
    >
      <template #actions>
        <v-btn variant="tonal" prepend-icon="mdiRefresh" :loading="loading" @click="load">
          刷新
        </v-btn>
      </template>
    </PageHeader>

    <!-- 保存成功后的持久提示：重启这一步最容易被忘掉，所以不做成会消失的 toast。 -->
    <v-alert
      v-if="savedNotice"
      type="success"
      variant="tonal"
      class="mb-4"
      title="已写入 .env，重启 Nami 后生效"
    >
      <div class="text-body-2">
        配置在进程启动时读取一次，没有热加载。请在项目根目录重新执行启动命令。
      </div>
      <div class="d-flex align-center ga-3 mt-3 flex-wrap">
        <code class="nami-cmd">npm start</code>
        <v-btn
          size="small"
          variant="tonal"
          prepend-icon="mdiContentCopy"
          @click="copyRestartCommand"
        >
          复制重启命令
        </v-btn>
        <v-btn size="small" variant="text" @click="savedNotice = false">知道了</v-btn>
      </div>
    </v-alert>

    <AsyncSection
      :loading="loading && schema === null"
      :error="loadError"
      :empty="schema === null"
      empty-title="没有拿到配置描述"
      @retry="load"
    >
      <template v-if="schema">
        <!-- ---------------------------- .env 文件 ---------------------------- -->
        <v-card class="mb-4">
          <v-card-title class="text-subtitle-2">配置文件</v-card-title>
          <v-card-text>
            <v-row dense>
              <v-col cols="12" md="6">
                <div class="text-caption text-medium-emphasis">路径 envFile.path</div>
                <div class="nami-mono text-body-2">{{ schema.envFile.path }}</div>
              </v-col>
              <v-col cols="6" md="3">
                <div class="text-caption text-medium-emphasis">存在</div>
                <div class="text-body-2">
                  <v-chip
                    size="small"
                    variant="tonal"
                    :color="schema.envFile.exists ? 'success' : 'warning'"
                  >
                    {{ schema.envFile.exists ? '是' : '否（保存时会创建）' }}
                  </v-chip>
                </div>
              </v-col>
              <v-col cols="6" md="3">
                <div class="text-caption text-medium-emphasis">可写</div>
                <div class="text-body-2">
                  <v-chip
                    size="small"
                    variant="tonal"
                    :color="schema.envFile.writable ? 'success' : 'error'"
                  >
                    {{ schema.envFile.writable ? '是' : '否' }}
                  </v-chip>
                </div>
              </v-col>
            </v-row>

            <v-alert
              v-if="!schema.envFile.writable"
              type="warning"
              variant="tonal"
              density="comfortable"
              class="mt-4"
              title=".env 不可写，保存已禁用"
            >
              <div class="text-body-2">
                服务器判定该文件不可写（权限或只读挂载）。
                请先修正文件权限，或者直接在宿主机上编辑它——这里的所有字段都是普通环境变量，
                格式为 <code class="nami-mono">NAMI_XXX=值</code>。
              </div>
            </v-alert>
          </v-card-text>
        </v-card>

        <!-- ---------------------------- 搜索 ---------------------------- -->
        <div class="d-flex align-center ga-3 flex-wrap mb-4">
          <v-text-field
            v-model="search"
            label="搜索配置项"
            placeholder="键名或说明，例如 onebot / 并发"
            prepend-inner-icon="mdiMagnify"
            clearable
            density="compact"
            hide-details
            variant="outlined"
            class="nami-search"
          />
          <v-chip variant="tonal" :color="dirtyCount > 0 ? 'primary' : undefined">
            共 {{ schema.fields.length }} 项 · 已修改 {{ dirtyCount }} 项
          </v-chip>
          <v-chip variant="tonal" color="info">全部字段 restartRequired</v-chip>
        </div>

        <v-alert
          v-if="saveError"
          type="error"
          variant="tonal"
          density="comfortable"
          class="mb-4"
          title="保存失败（服务器没有写入任何内容）"
        >
          <div class="text-body-2">{{ saveError }}</div>
          <div class="text-caption mt-1">
            服务器会在一次请求里校验所有键：只要有一项非法，整批都不会写。
          </div>
        </v-alert>

        <!-- ---------------------------- 分组表单 ---------------------------- -->
        <v-expansion-panels v-model="openPanels" multiple variant="accordion">
          <v-expansion-panel
            v-for="group in visibleGroups"
            :key="group.name"
            :value="group.name"
          >
            <v-expansion-panel-title>
              <span class="text-subtitle-2">{{ group.name }}</span>
              <v-chip size="x-small" variant="tonal" class="ml-3">{{ group.fields.length }}</v-chip>
              <v-chip
                v-if="groupDirtyCount(group.name) > 0"
                size="x-small"
                variant="tonal"
                color="primary"
                class="ml-2"
              >
                已修改 {{ groupDirtyCount(group.name) }}
              </v-chip>
            </v-expansion-panel-title>
            <v-expansion-panel-text>
              <ConfigFieldRow
                v-for="field in group.fields"
                :key="field.key"
                v-model="drafts[field.key]"
                :field="field"
                :dirty="isDirty(field)"
                :error="fieldErrors[field.key]"
              />
            </v-expansion-panel-text>
          </v-expansion-panel>
        </v-expansion-panels>

        <v-alert
          v-if="visibleGroups.length === 0"
          type="info"
          variant="tonal"
          class="mt-4"
          title="没有匹配的配置项"
        >
          <div class="text-body-2">换个关键词试试，或者点输入框右侧的清除按钮。</div>
        </v-alert>

        <!-- 粘性保存条：只在有改动时出现，避免误以为点一下就写盘。 -->
        <v-sheet v-if="dirtyCount > 0" class="nami-savebar d-flex align-center ga-3 pa-4 mt-6">
          <v-icon icon="mdiPencilOutline" size="20" />
          <span class="text-body-2">已修改 {{ dirtyCount }} 项</span>
          <v-spacer />
          <v-btn variant="text" prepend-icon="mdiUndoVariant" @click="discard">放弃</v-btn>
          <v-btn
            color="primary"
            prepend-icon="mdiContentSaveOutline"
            :loading="saving"
            :disabled="!schema.envFile.writable"
            @click="save"
          >
            保存
          </v-btn>
        </v-sheet>

        <!-- ---------------------------- 只读概览 ---------------------------- -->
        <v-card class="mt-6">
          <v-card-title class="text-subtitle-2">只读概览</v-card-title>
          <v-card-text>
            <div class="text-caption text-medium-emphasis mb-3">
              <code class="nami-mono">GET /admin/api/config</code> ·
              生效中的配置（密钥已脱敏）。这里显示的是进程当前真正在用的值，与上面表单里待保存的草稿无关。
            </div>
            <JsonBlock
              :value="effective?.config ?? null"
              label="生效中的配置（密钥已脱敏）"
              max-height="440px"
            />
          </v-card-text>
        </v-card>
      </template>
    </AsyncSection>

    <!-- ---------------------------- 保存结果 ---------------------------- -->
    <v-dialog v-model="saveDialog" max-width="760">
      <v-card>
        <v-card-title class="text-subtitle-2">已写入 {{ saveResult?.written ?? '.env' }}</v-card-title>
        <v-card-text>
          <div class="text-caption text-medium-emphasis mb-3">
            共 {{ saveResult?.applied.length ?? 0 }} 项。密钥类字段的新值以
            <code class="nami-mono">***</code> 回显——接口在任何情况下都不会把密钥原文吐回来。
          </div>
          <v-table density="compact">
            <thead>
              <tr>
                <th>配置项</th>
                <th>原值</th>
                <th>新值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="change in saveResult?.applied ?? []" :key="change.key">
                <td class="nami-mono">{{ change.key }}</td>
                <td class="nami-mono text-medium-emphasis">{{ change.from ?? '（未设置）' }}</td>
                <td class="nami-mono">{{ change.to }}</td>
              </tr>
            </tbody>
          </v-table>
          <v-alert type="info" variant="tonal" density="comfortable" class="mt-4">
            <div class="text-body-2">
              这些改动不会热加载：重启 Nami 后才会生效。可以直接复制
              <code class="nami-mono">npm start</code>。
            </div>
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-btn variant="text" prepend-icon="mdiContentCopy" @click="copyRestartCommand">
            复制重启命令
          </v-btn>
          <v-spacer />
          <v-btn color="primary" variant="tonal" @click="saveDialog = false">关闭</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import type { ConfigField, ConfigResponse, ConfigSaveResult } from '@/api/client';
import { describeError, shell, toastError } from '@/composables/useShell';
import PageHeader from '@/components/PageHeader.vue';
import AsyncSection from '@/components/AsyncSection.vue';
import JsonBlock from '@/components/JsonBlock.vue';
import ConfigFieldRow from '@/components/ConfigFieldRow.vue';

const props = defineProps<{ refreshToken?: number }>();

/** 服务器额外下发的字段：configured（仅密钥）与 groups/note。 */
type ConfigFieldMeta = ConfigField & { configured?: boolean };
type SchemaResponse = {
  fields: ConfigFieldMeta[];
  envFile: { path: string; exists: boolean; writable: boolean };
  groups?: string[];
  note?: string;
};

const schema = ref<SchemaResponse | null>(null);
const effective = ref<ConfigResponse | null>(null);
const loading = ref(false);
const loadError = ref('');

/** 草稿与原始值：脏状态就是这两份数据的逐字段比较。 */
const drafts = ref<Record<string, unknown>>({});
const originals = ref<Record<string, unknown>>({});
const fieldErrors = ref<Record<string, string>>({});

const search = ref('');
const openPanels = ref<string[]>([]);
const saving = ref(false);
const saveError = ref('');
const saveDialog = ref(false);
const savedNotice = ref(false);
const saveResult = ref<ConfigSaveResult | null>(null);

/** 把服务器给的当前值收敛成控件可以直接用的形状。 */
function normalize(field: ConfigFieldMeta): unknown {
  // 密钥没有可读值（恒为 null），草稿一律从空串开始 = 不修改。
  if (field.secret) return '';
  if (field.type === 'bool') return field.value === true;
  if (field.type === 'list') return Array.isArray(field.value) ? field.value.map(String) : [];
  return field.value === null || field.value === undefined ? '' : String(field.value);
}

function clone(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value;
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const response = (await api.configSchema()) as SchemaResponse;
    schema.value = response;

    const next: Record<string, unknown> = {};
    const base: Record<string, unknown> = {};
    for (const field of response.fields) {
      const value = normalize(field);
      next[field.key] = clone(value);
      base[field.key] = clone(value);
    }
    drafts.value = next;
    originals.value = base;
    fieldErrors.value = {};
    saveError.value = '';
    syncPanels();
  } catch (e) {
    loadError.value = describeError(e);
  } finally {
    loading.value = false;
  }

  // 只读概览是独立请求：它失败不该把整个编辑页变成错误页。
  try {
    effective.value = await api.config();
  } catch {
    effective.value = null;
  }
}

/* ------------------------------------------------------------------ *
 * 分组与过滤
 * ------------------------------------------------------------------ */

/** 用服务器给的 groups 顺序；万一它没给，就按字段出现的顺序兜底。 */
const groups = computed<string[]>(() => {
  const fields = schema.value?.fields ?? [];
  const present = new Set(fields.map((field) => field.group));
  const ordered = (schema.value?.groups ?? []).filter((name) => present.has(name));
  for (const name of present) {
    if (!ordered.includes(name)) ordered.push(name);
  }
  return ordered;
});

const query = computed(() => search.value.trim().toLowerCase());

function fieldsOf(group: string): ConfigFieldMeta[] {
  const q = query.value;
  const fields = schema.value?.fields ?? [];
  return fields.filter((field) => {
    if (field.group !== group) return false;
    if (q === '') return true;
    return (
      field.key.toLowerCase().includes(q) || field.description.toLowerCase().includes(q)
    );
  });
}

const visibleGroups = computed(() =>
  groups.value
    .map((name) => ({ name, fields: fieldsOf(name) }))
    .filter((group) => group.fields.length > 0),
);

/** 面板保持展开，否则搜索结果会藏在收起的标题后面。 */
function syncPanels(): void {
  if (query.value !== '') {
    openPanels.value = visibleGroups.value.map((group) => group.name);
    return;
  }
  const first = visibleGroups.value[0];
  openPanels.value = first ? [first.name] : [];
}

watch(query, () => syncPanels());

/* ------------------------------------------------------------------ *
 * 脏状态
 * ------------------------------------------------------------------ */

function isDirty(field: ConfigFieldMeta): boolean {
  const draft = drafts.value[field.key];
  if (field.secret) {
    // 密钥的「有改动」只有一个含义：真的输入了内容。
    return typeof draft === 'string' && draft.trim() !== '';
  }
  // JSON 比较顺带处理了数组（列表）与布尔。
  return JSON.stringify(draft) !== JSON.stringify(originals.value[field.key]);
}

const dirtyKeys = computed(() =>
  (schema.value?.fields ?? []).filter((field) => isDirty(field)).map((field) => field.key),
);

const dirtyCount = computed(() => dirtyKeys.value.length);

function groupDirtyCount(group: string): number {
  return (schema.value?.fields ?? []).filter(
    (field) => field.group === group && isDirty(field),
  ).length;
}

function discard(): void {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(originals.value)) next[key] = clone(value);
  drafts.value = next;
  fieldErrors.value = {};
  saveError.value = '';
  shell.info('已放弃未保存的改动');
}

/* ------------------------------------------------------------------ *
 * 校验与保存
 * ------------------------------------------------------------------ */

const INT = /^-?\d+$/;
const FLOAT = /^-?\d+(\.\d+)?$/;

/**
 * 客户端校验刻意与 src/config-schema.ts 的规则对齐，
 * 目的是让明显的错误在发请求之前就被指出来；服务器仍然是最终裁判。
 */
function validate(): boolean {
  const errors: Record<string, string> = {};
  for (const field of schema.value?.fields ?? []) {
    if (!isDirty(field)) continue;
    const draft = drafts.value[field.key];

    if (field.secret) {
      // 密钥不做类型猜测（有的密钥本身就是列表），交给服务器按类型校验。
      continue;
    }

    if (field.type === 'bool') {
      if (typeof draft !== 'boolean') errors[field.key] = '必须是布尔值';
      continue;
    }

    if (field.type === 'list') {
      const items = Array.isArray(draft) ? draft.map(String) : [];
      if (items.some((item) => item.includes('\n'))) errors[field.key] = '列表项不能包含换行';
      else if (items.some((item) => item.trim() === '')) {
        errors[field.key] = '列表项不能为空（注意多余的逗号）';
      }
      continue;
    }

    const text = String(draft ?? '').trim();
    if (field.type === 'int') {
      if (text !== '' && !INT.test(text)) errors[field.key] = '必须是整数';
    } else if (field.type === 'float') {
      if (text !== '' && !FLOAT.test(text)) errors[field.key] = '必须是数字';
    } else if (field.type === 'enum') {
      if (text !== '' && field.options && !field.options.includes(text)) {
        errors[field.key] = `只能取以下值之一：${field.options.join(', ')}`;
      }
    } else if (
      text.includes('\n') &&
      field.key !== 'NAMI_SYSTEM_PROMPT' &&
      field.key !== 'NAMI_ONEBOT_SYSTEM_PROMPT'
    ) {
      errors[field.key] = '该配置项不能包含换行';
    }
  }

  fieldErrors.value = errors;
  return Object.keys(errors).length === 0;
}

/** 按客户端类型把草稿转成 .env 里的字符串。 */
function buildChanges(): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const field of schema.value?.fields ?? []) {
    if (!isDirty(field)) continue;
    const draft = drafts.value[field.key];

    // 密钥优先：列表型密钥（NAMI_API_KEYS）也以逗号分隔的原文交给服务器。
    if (field.secret) {
      changes[field.key] = String(draft ?? '');
      continue;
    }
    if (field.type === 'list') {
      const items = Array.isArray(draft)
        ? draft.map((item) => String(item).trim()).filter((item) => item !== '')
        : [];
      changes[field.key] = items.join(',');
      continue;
    }
    if (field.type === 'bool') {
      changes[field.key] = draft === true ? 'true' : 'false';
      continue;
    }
    changes[field.key] = String(draft ?? '');
  }
  return changes;
}

/**
 * ApiError 目前只暴露 message，不暴露 error.details。
 * 这里防御性地从错误对象上读一次 details（数组 [{key, message}]），
 * 读不到就退回到「扫一遍 message 里出现的键名」，任何情况都不会抛异常。
 */
function extractDetails(error: unknown): Array<{ key: string; message: string }> {
  const raw = (error as { details?: unknown } | null | undefined)?.details;
  const out: Array<{ key: string; message: string }> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const key = (item as { key?: unknown }).key;
      const message = (item as { message?: unknown }).message;
      if (typeof key === 'string' && typeof message === 'string') out.push({ key, message });
    }
  }
  if (out.length > 0) return out;

  // 退路：服务器有些错误只在 message 文本里点名键。
  const text = describeError(error);
  for (const field of schema.value?.fields ?? []) {
    if (text.includes(field.key)) out.push({ key: field.key, message: text });
  }
  return out;
}

async function save(): Promise<void> {
  if (!schema.value) return;
  saveError.value = '';
  if (!schema.value.envFile.writable) {
    shell.warning('.env 不可写', '请先修正文件权限，保存已禁用。');
    return;
  }
  if (dirtyCount.value === 0) return;
  if (!validate()) {
    const count = Object.keys(fieldErrors.value).length;
    shell.error('还有字段没通过校验', `共 ${count} 项，请修正后再保存。`);
    return;
  }

  saving.value = true;
  try {
    saveResult.value = await api.saveConfig(buildChanges());
    saveDialog.value = true;
    savedNotice.value = true;
    shell.success('配置已写入 .env', '重启 Nami 后生效。');
    // 重新拉一次：保存后当前值就是新值，脏状态随之清零。
    await load();
  } catch (e) {
    const details = extractDetails(e);
    if (details.length > 0) {
      const mapped: Record<string, string> = {};
      for (const detail of details) mapped[detail.key] = detail.message;
      fieldErrors.value = mapped;
    }
    saveError.value = describeError(e);
    toastError(e, '保存配置');
  } finally {
    saving.value = false;
  }
}

async function copyRestartCommand(): Promise<void> {
  try {
    await navigator.clipboard.writeText('npm start');
    shell.success('已复制重启命令', '在项目根目录执行 npm start。');
  } catch {
    // 剪贴板可能被浏览器拒绝，命令本身在上面的代码块里是可选中复制的。
    shell.warning('复制失败', '请手动执行 npm start。');
  }
}

onMounted(() => {
  void load();
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

.nami-cmd {
  padding: 6px 10px;
  border-radius: 6px;
  background: rgb(var(--v-theme-surface-light));
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
}

.nami-search {
  max-width: 420px;
  min-width: 240px;
}

.nami-savebar {
  position: sticky;
  bottom: 0;
  z-index: 6;
  border: 1px solid rgb(var(--v-theme-border-color, 35 42 54));
  border-radius: 12px;
  background: rgb(var(--v-theme-surface-bright, 26 33 44));
  box-shadow: 0 -6px 20px rgb(0 0 0 / 28%);
}
</style>
