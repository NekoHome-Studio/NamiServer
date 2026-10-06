<template>
  <v-container fluid class="pa-6">
    <PageHeader
      title="会话"
      subtitle="每个会话在 SQLite 里独立保存自己的转录、运行记录与记忆键值，互不影响；这里可以查看、改名或删除它们。"
    >
      <template #actions>
        <v-chip variant="tonal" :prepend-icon="icons.db" label>
          {{ formatNumber(sessions.length) }} 个会话
        </v-chip>
        <v-btn
          variant="tonal"
          size="small"
          :prepend-icon="icons.refresh"
          :loading="listLoading"
          @click="loadSessions"
        >
          刷新
        </v-btn>
      </template>
    </PageHeader>

    <v-row dense>
      <!-- 左列：可滚动的会话列表，带过滤与排序。 -->
      <v-col cols="12" md="4" lg="3">
        <v-card class="d-flex flex-column nami-sessions__panel">
          <v-card-title class="text-subtitle-2 py-3">会话列表</v-card-title>
          <v-divider />
          <v-card-text class="pb-2">
            <v-text-field
              v-model="filter"
              density="comfortable"
              placeholder="按标题或 ID 过滤"
              spellcheck="false"
              :prepend-inner-icon="icons.search"
              hide-details="auto"
              clearable
            />
            <div class="d-flex align-center mt-3">
              <v-btn-toggle
                :model-value="sortMode"
                density="comfortable"
                variant="tonal"
                divided
                mandatory
                @update:model-value="setSort"
              >
                <v-btn value="updated" size="small" :prepend-icon="icons.clock">最近更新</v-btn>
                <v-btn value="messages" size="small" :prepend-icon="icons.list">消息数</v-btn>
              </v-btn-toggle>
              <v-spacer />
              <span class="text-caption text-medium-emphasis">{{ visibleSessions.length }} / {{ sessions.length }}</span>
            </div>
          </v-card-text>

          <v-divider />

          <AsyncSection
            :loading="listLoading"
            :error="listError"
            :empty="sessions.length === 0"
            empty-title="还没有会话"
            empty-hint="在「对话」页发一句话就会创建第一个会话。"
            :empty-icon="icons.emptyChat"
            @retry="loadSessions"
          >
            <div class="nami-sessions__scroll">
              <div v-if="visibleSessions.length === 0" class="text-center py-8 text-caption text-medium-emphasis">
                没有匹配「{{ filter }}」的会话
              </div>
              <v-list v-else nav density="comfortable" class="py-2">
                <v-list-item
                  v-for="session in visibleSessions"
                  :key="session.id"
                  :active="session.id === selectedId"
                  color="primary"
                  rounded="lg"
                  @click="select(session.id)"
                >
                  <v-list-item-title class="text-body-2">
                    {{ session.title || '（无标题）' }}
                  </v-list-item-title>
                  <v-list-item-subtitle class="d-flex align-center ga-2">
                    <span>{{ formatNumber(session.messageCount ?? 0) }} 条消息</span>
                    <span>·</span>
                    <span>{{ formatRelative(session.updatedAt) }}</span>
                  </v-list-item-subtitle>
                </v-list-item>
              </v-list>
            </div>
          </AsyncSection>
        </v-card>
      </v-col>

      <!-- 右列：选中会话的全部内容。 -->
      <v-col cols="12" md="8" lg="9">
        <v-card v-if="!selectedId">
          <v-card-text class="text-center py-16">
            <v-icon :icon="icons.chat" size="44" class="text-medium-emphasis mb-3" />
            <div class="text-body-1">选择一个会话</div>
            <div class="text-caption text-medium-emphasis mt-1">
              左侧列表里的任意一项都会在这里展开转录与记忆。
            </div>
          </v-card-text>
        </v-card>

        <template v-else>
          <v-card class="mb-4">
            <v-card-title class="d-flex align-center ga-2 flex-wrap py-3">
              <v-icon :icon="icons.chat" size="20" />
              <span class="text-subtitle-1">{{ detailTitle }}</span>
              <v-spacer />
              <v-btn
                size="small"
                variant="tonal"
                :prepend-icon="icons.edit"
                @click="openTitleDialog"
              >
                改名
              </v-btn>
              <v-btn
                size="small"
                variant="tonal"
                color="error"
                :prepend-icon="icons.delete"
                @click="deleteDialog = true"
              >
                删除
              </v-btn>
            </v-card-title>
            <v-divider />
            <v-card-text>
              <div class="d-flex align-center ga-2 flex-wrap mb-2">
                <span class="text-caption text-medium-emphasis">ID</span>
                <code class="nami-mono text-body-2">{{ selectedId }}</code>
                <v-btn
                  size="x-small"
                  variant="text"
                  :prepend-icon="copied ? icons.check : icons.copy"
                  @click="copyId(selectedId)"
                >
                  {{ copied ? '已复制' : '复制' }}
                </v-btn>
              </div>
              <v-alert v-if="copyError" type="warning" variant="tonal" density="comfortable" class="mb-2">
                <div class="text-body-2">{{ copyError }}</div>
              </v-alert>
              <div class="text-caption text-medium-emphasis">
                创建 {{ formatTime(detail?.session.createdAt) }} · 更新
                {{ formatTime(detail?.session.updatedAt) }} （{{ formatRelative(detail?.session.updatedAt) }}）
              </div>
            </v-card-text>
          </v-card>

          <v-card class="mb-4">
            <v-card-title class="d-flex align-center ga-2 py-3">
              <v-icon :icon="icons.list" size="20" />
              <span class="text-subtitle-1">转录</span>
              <v-chip size="small" variant="tonal" label>
                {{ formatNumber(detail?.messages.length ?? 0) }} 条
              </v-chip>
            </v-card-title>
            <v-divider />
            <v-card-text>
              <AsyncSection
                :loading="detailLoading"
                :error="detailError"
                :empty="(detail?.messages.length ?? 0) === 0"
                empty-title="这个会话还没有消息"
                empty-hint="它可能是刚创建、或者消息已被清理。"
                :empty-icon="icons.emptyMessage"
                @retry="loadDetail(selectedId)"
              >
                <div
                  v-for="message in detail?.messages ?? []"
                  :key="message.id"
                  class="mb-4"
                >
                  <div class="d-flex align-center ga-2 flex-wrap">
                    <v-chip :color="roleMeta(message.role).color" size="small" variant="tonal" label>
                      {{ roleMeta(message.role).label }}
                    </v-chip>
                    <span class="text-caption text-medium-emphasis nami-mono">#{{ message.seq }}</span>
                    <span class="text-caption text-medium-emphasis">{{ formatTime(message.createdAt) }}</span>
                    <span v-if="message.name" class="text-caption text-medium-emphasis nami-mono">
                      {{ message.name }}
                    </span>
                  </div>

                  <div v-if="message.content" class="nami-pre mt-2">{{ message.content }}</div>

                  <!-- assistant 消息可能一行文本都没说，只发起了工具调用，所以这里不能有 v-else。 -->
                  <div v-if="message.toolCalls?.length" class="d-flex flex-wrap ga-1 mt-2">
                    <v-chip
                      v-for="call in message.toolCalls"
                      :key="call.id"
                      size="small"
                      variant="tonal"
                      color="info"
                      label
                      class="nami-mono"
                    >
                      {{ call.function.name }}({{ truncate(call.function.arguments) }})
                    </v-chip>
                  </div>

                  <div v-if="message.role === 'tool' && !message.content" class="text-caption text-medium-emphasis mt-2">
                    （工具没有返回内容）
                  </div>
                </div>
              </AsyncSection>
            </v-card-text>
          </v-card>

          <v-card>
            <v-card-title class="d-flex align-center ga-2 py-3">
              <v-icon :icon="icons.brain" size="20" />
              <span class="text-subtitle-1">记忆</span>
              <v-chip size="small" variant="tonal" label>{{ memoryKeys.length }} 项</v-chip>
            </v-card-title>
            <v-divider />
            <v-card-text>
              <div v-if="memoryKeys.length === 0" class="text-body-2 text-medium-emphasis">
                这个会话还没有写入记忆（memory_set 工具会往这里写）。
              </div>
              <div v-for="key in memoryKeys" :key="key" class="mb-4">
                <div class="d-flex align-center ga-2 mb-1">
                  <v-icon :icon="icons.key" size="16" class="text-medium-emphasis" />
                  <span class="text-body-2 font-weight-medium nami-mono">{{ key }}</span>
                </div>
                <JsonBlock v-if="isStructured(memory[key])" :value="memory[key]" />
                <div v-else class="nami-pre">{{ scalarText(memory[key]) }}</div>
              </div>
            </v-card-text>
          </v-card>
        </template>
      </v-col>
    </v-row>

    <!-- 改名：只提交 title，其他字段由服务端保留。 -->
    <v-dialog v-model="titleDialog" max-width="520">
      <v-card>
        <v-card-title class="text-subtitle-1">重命名会话</v-card-title>
        <v-card-text>
          <v-text-field
            v-model="titleDraft"
            label="标题"
            autofocus
            spellcheck="false"
            :error-messages="titleError"
            @keydown.enter.prevent="saveTitle"
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="titleDialog = false">取消</v-btn>
          <v-btn color="primary" :loading="saving" @click="saveTitle">保存</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 删除：把连带影响写清楚，避免有人以为只删了一行标题。 -->
    <v-dialog v-model="deleteDialog" max-width="560">
      <v-card>
        <v-card-title class="text-subtitle-1">删除会话</v-card-title>
        <v-card-text>
          <p class="mb-3">
            确定要删除
            <strong>{{ detailTitle }}</strong>
            （<code class="nami-mono">{{ selectedId }}</code>）吗？
          </p>
          <v-alert type="warning" variant="tonal" density="comfortable">
            <div class="text-body-2">
              这会同时删除它的全部消息、运行记录、工具调用记录与记忆键值。操作不可撤销。
            </div>
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="deleteDialog = false">取消</v-btn>
          <v-btn color="error" :loading="deleting" @click="confirmDelete">删除</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
/**
 * 会话管理页。
 *
 * 布局是「列表 + 详情」而不是单页表格：一条会话的详情（转录 + 记忆）通常比列表
 * 本身更值得看，并排摆放可以让操作者在多个会话之间来回对比，而不用反复进出。
 *
 * 删除是这个页面唯一的破坏性操作，所以它同时要求一个说明连带影响的确认弹窗，
 * 并且在成功后把列表和详情一起收拾干净——留着一条已被删除的详情会把 404 的
 * 错误当成页面状态的一部分。
 */
import { computed, onMounted, ref, watch } from 'vue';
import {
  mdiBrain,
  mdiCheck,
  mdiChatProcessingOutline,
  mdiCommentMultipleOutline,
  mdiContentCopy,
  mdiDatabaseOutline,
  mdiDelete,
  mdiFormatListBulleted,
  mdiKeyOutline,
  mdiMagnify,
  mdiMessageTextOutline,
  mdiPencil,
  mdiRefresh,
  mdiSortClockDescendingOutline,
} from '@mdi/js';
import { api } from '@/api/client';
import type { Message, Session, SessionDetail } from '@/api/client';
import PageHeader from '@/components/PageHeader.vue';
import AsyncSection from '@/components/AsyncSection.vue';
import JsonBlock from '@/components/JsonBlock.vue';
import { describeError, formatNumber, formatRelative, formatTime, shell, toastError } from '@/composables/useShell';

const props = defineProps<{ refreshToken?: number }>();

const icons = {
  brain: mdiBrain,
  chat: mdiChatProcessingOutline,
  check: mdiCheck,
  clock: mdiSortClockDescendingOutline,
  copy: mdiContentCopy,
  db: mdiDatabaseOutline,
  delete: mdiDelete,
  edit: mdiPencil,
  /** AsyncSection 的空状态图标同样只能给 path，不能给 `mdiXxx` 名字。 */
  emptyChat: mdiCommentMultipleOutline,
  emptyMessage: mdiMessageTextOutline,
  key: mdiKeyOutline,
  list: mdiFormatListBulleted,
  refresh: mdiRefresh,
  search: mdiMagnify,
} as const;

/* ------------------------------ 列表状态 ------------------------------ */

const sessions = ref<Session[]>([]);
const listLoading = ref(false);
const listError = ref('');

const filter = ref('');
const sortMode = ref<'updated' | 'messages'>('updated');

const visibleSessions = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  const matched = needle === ''
    ? [...sessions.value]
    : sessions.value.filter(
        (session) =>
          session.title.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle),
      );
  return matched.sort((a, b) =>
    sortMode.value === 'messages'
      ? (b.messageCount ?? 0) - (a.messageCount ?? 0) || b.updatedAt - a.updatedAt
      : b.updatedAt - a.updatedAt,
  );
});

function setSort(value: unknown): void {
  // v-btn-toggle 会给回字符串；显式收窄，避免把任意值塞进排序状态。
  if (value === 'updated' || value === 'messages') sortMode.value = value;
}

async function loadSessions(): Promise<void> {
  listLoading.value = true;
  listError.value = '';
  try {
    const response = await api.sessions(200);
    sessions.value = response.data;
  } catch (error) {
    listError.value = describeError(error);
  } finally {
    listLoading.value = false;
  }
}

/* ------------------------------ 详情状态 ------------------------------ */

const selectedId = ref('');
const detail = ref<SessionDetail | null>(null);
const detailLoading = ref(false);
const detailError = ref('');

const copied = ref(false);
const copyError = ref('');

const titleDialog = ref(false);
const deleteDialog = ref(false);
const titleDraft = ref('');
const titleError = ref('');
const saving = ref(false);
const deleting = ref(false);

const detailTitle = computed(
  () => detail.value?.session.title || sessions.value.find((s) => s.id === selectedId.value)?.title || '（无标题会话）',
);

const memory = computed<Record<string, unknown>>(() => detail.value?.memory ?? {});
const memoryKeys = computed(() => Object.keys(memory.value));

async function select(id: string): Promise<void> {
  selectedId.value = id;
  await loadDetail(id);
}

/** 详情请求的序号：只有最后一次发起的请求有权写入 `detail`。 */
let detailRequest = 0;

async function loadDetail(id: string): Promise<void> {
  if (id === '') return;
  const request = ++detailRequest;
  detailLoading.value = true;
  detailError.value = '';
  detail.value = null;
  try {
    const response = await api.session(id);
    // 用序号而不是 id 判重：快速 A → B → A 时两个 id 相同，只有最后一次才算数。
    if (request !== detailRequest) return;
    detail.value = response;
  } catch (error) {
    if (request === detailRequest) detailError.value = describeError(error);
  } finally {
    if (request === detailRequest) detailLoading.value = false;
  }
}

/** 选中项被删除或列表刷新后，用它把详情面板收回到一个干净状态。 */
function clearSelection(): void {
  detailRequest += 1;
  selectedId.value = '';
  detail.value = null;
  detailError.value = '';
  copied.value = false;
  copyError.value = '';
}

/* ------------------------------ 改名 / 删除 ------------------------------ */

function openTitleDialog(): void {
  titleDraft.value = detail.value?.session.title ?? '';
  titleError.value = '';
  titleDialog.value = true;
}

async function saveTitle(): Promise<void> {
  const id = selectedId.value;
  const title = titleDraft.value.trim();
  if (id === '' || title === '') {
    titleError.value = '标题不能为空。';
    return;
  }
  saving.value = true;
  titleError.value = '';
  try {
    await api.renameSession(id, title);
    // 本地先改，界面立刻一致；随后拉一次列表覆盖 messageCount 等派生字段。
    if (detail.value) detail.value.session.title = title;
    const listed = sessions.value.find((session) => session.id === id);
    if (listed) listed.title = title;
    titleDialog.value = false;
    shell.success('已重命名会话', title);
    void loadSessions();
  } catch (error) {
    titleError.value = describeError(error);
  } finally {
    saving.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  const id = selectedId.value;
  if (id === '') return;
  deleting.value = true;
  try {
    await api.deleteSession(id);
    sessions.value = sessions.value.filter((session) => session.id !== id);
    clearSelection();
    deleteDialog.value = false;
    shell.success('已删除会话', id);
  } catch (error) {
    toastError(error, '删除会话失败');
  } finally {
    deleting.value = false;
  }
}

/* ------------------------------ 小工具 ------------------------------ */

interface RoleMeta {
  label: string;
  color: string;
}

function roleMeta(role: Message['role']): RoleMeta {
  switch (role) {
    case 'user':
      return { label: '用户', color: 'primary' };
    case 'assistant':
      return { label: 'Nami', color: 'success' };
    case 'tool':
      return { label: '工具', color: 'warning' };
    default:
      return { label: '系统', color: 'secondary' };
  }
}

/** 工具参数是模型输出的字符串，可能很长；chip 只做摘要，完整内容看「对话」页的卡片。 */
function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function isStructured(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return String(value);
}

/**
 * 复制会话 ID。
 *
 * 用 `navigator.clipboard`，因为它需要安全上下文（http://127.0.0.1 算，局域网
 * 明文 http 不算）；失败时退回一个临时 textarea + `document.execCommand`，
 * 再失败才告诉用户手动选。
 */
async function copyId(id: string): Promise<void> {
  copyError.value = '';
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(id);
    } else if (!fallbackCopy(id)) {
      throw new Error('浏览器拒绝了剪贴板写入');
    }
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1500);
  } catch (error) {
    copyError.value = `无法写入剪贴板：${error instanceof Error ? error.message : String(error)}。请手动选中复制。`;
  }
}

function fallbackCopy(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------ 生命周期 ------------------------------ */

watch(
  () => props.refreshToken,
  () => {
    void loadSessions();
    if (selectedId.value !== '') void loadDetail(selectedId.value);
  },
);

onMounted(() => {
  void loadSessions();
});
</script>

<style scoped>
.nami-sessions__panel {
  /* 与「对话」页同高：列表随会话增多而内部滚动，筛选区始终留在视野里。 */
  height: calc(100vh - 220px);
  min-height: 420px;
}
.nami-sessions__scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 120px;
}
.nami-pre {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 10px 12px;
  border: 1px solid rgb(var(--v-theme-border-color, 35 42 54));
  border-radius: 8px;
  background: rgb(var(--v-theme-surface-light));
  font-size: 13.5px;
  line-height: 1.65;
}
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
</style>
