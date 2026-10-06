<template>
  <v-container fluid class="pa-6">
    <PageHeader
      title="API 文档"
      subtitle="文档由 /openapi.json 提供，内容手写但被服务器测试套件对着真实路由表校验，因此不会悄悄和实现脱节。"
    >
      <template #actions>
        <v-btn variant="tonal" prepend-icon="mdiRefresh" :loading="loading" @click="load">
          重新拉取
        </v-btn>
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdiOpenInNew"
          href="/docs"
          target="_blank"
          rel="noopener"
        >
          经典 /docs
        </v-btn>
      </template>
    </PageHeader>

    <AsyncSection
      :loading="loading && spec === null"
      :error="loadError"
      :empty="spec === null"
      empty-title="没有拿到 OpenAPI 文档"
      empty-hint="GET /openapi.json 没有返回可用的文档。"
      @retry="load"
    >
      <template v-if="spec">
        <!-- 短文档/畸形文档：给出明确的错误状态，而不是让页面崩在某个 undefined 上。 -->
        <v-alert
          v-if="!hasPaths"
          type="error"
          variant="tonal"
          class="mb-4"
          title="OpenAPI 文档不完整"
        >
          <div class="text-body-2">
            响应里没有可用的 <code class="nami-mono">paths</code> 对象，所以渲染不出任何接口。
            这通常意味着请求被某个中间层拦截、返回了 HTML，或者服务器版本与 WebUI 不匹配。
          </div>
          <div class="text-caption mt-2">
            基本信息：{{ spec.info?.title ?? '（无 info.title）' }} ·
            paths 类型 {{ typeof spec.paths }}
          </div>
          <JsonBlock :value="spec" label="收到的原始响应" max-height="260px" class="mt-3" />
        </v-alert>

        <template v-else>
          <!-- ---------------------------- 认证说明 ---------------------------- -->
          <v-card class="mb-4">
            <v-card-title class="d-flex align-center ga-2 text-subtitle-2">
              <v-icon icon="mdiShieldKeyOutline" size="20" />
              认证
            </v-card-title>
            <v-card-text>
              <div class="text-body-2 mb-3">
                除下面列出的公开路径外，每个请求都要带凭证。两种头部任选其一即可：
              </div>
              <pre class="nami-cmd">Authorization: Bearer &lt;NAMI_API_KEYS 里的任意一个 Key&gt;
X-Admin-Token: &lt;NAMI_ADMIN_TOKEN&gt;</pre>
              <div class="text-body-2 mt-3">
                无需认证的路径：
                <code class="nami-mono">/healthz</code>、
                <code class="nami-mono">/readyz</code>、
                <code class="nami-mono">/admin</code>（前端外壳本身不含数据）、
                <code class="nami-mono">/docs</code>、
                <code class="nami-mono">/openapi.json</code>。
              </div>
              <div class="text-caption text-medium-emphasis mt-2">
                注意 <code class="nami-mono">/admin/api/*</code> 仍然需要凭证：外壳是公开的，数据不是。
                WebSocket 无法设置请求头，所以它额外接受 <code class="nami-mono">?key=</code>；
                日志 SSE 同理，接受 <code class="nami-mono">?key=</code>。
              </div>
              <div class="mt-3">
                <v-btn
                  variant="tonal"
                  prepend-icon="mdiOpenInNew"
                  href="/docs"
                  target="_blank"
                  rel="noopener"
                >
                  在新标签页打开经典 /docs
                </v-btn>
              </div>
            </v-card-text>
          </v-card>

          <!-- ---------------------------- 文档信息 ---------------------------- -->
          <v-card class="mb-4">
            <v-card-title class="text-subtitle-2">
              {{ spec.info?.title ?? '（无标题）' }}
              <v-chip size="small" variant="tonal" color="primary" class="ml-2">
                v{{ spec.info?.version ?? '?' }}
              </v-chip>
              <v-chip v-if="spec.openapi" size="small" variant="tonal" class="ml-2">
                OpenAPI {{ spec.openapi }}
              </v-chip>
            </v-card-title>
            <v-card-text>
              <div v-if="spec.info?.description" class="nami-prose text-body-2">
                {{ spec.info.description }}
              </div>
              <div class="text-caption text-medium-emphasis mt-3">
                共 {{ operations.length }} 个操作 · {{ tagOrder.length }} 个分组 ·
                当前显示 {{ filtered.length }} 个
              </div>
            </v-card-text>
          </v-card>

          <!-- ---------------------------- 过滤 ---------------------------- -->
          <div class="d-flex align-center ga-3 flex-wrap mb-4">
            <v-text-field
              v-model="search"
              label="搜索接口"
              placeholder="方法 / 路径 / 摘要 / 说明"
              prepend-inner-icon="mdiMagnify"
              clearable
              density="compact"
              variant="outlined"
              hide-details
              style="max-width: 360px; min-width: 220px"
            />
            <v-select
              v-model="tag"
              :items="tagItems"
              label="标签"
              density="compact"
              variant="outlined"
              hide-details
              style="max-width: 240px"
            />
          </div>

          <!-- ---------------------------- 接口列表 ---------------------------- -->
          <template v-for="group in groups" :key="group.name">
            <div class="d-flex align-center ga-2 mt-6 mb-2">
              <h2 class="text-subtitle-1 font-weight-bold ma-0">{{ group.name }}</h2>
              <v-chip size="x-small" variant="tonal">{{ group.items.length }}</v-chip>
            </div>
            <div v-if="group.description" class="text-caption text-medium-emphasis mb-2">
              {{ group.description }}
            </div>

            <v-expansion-panels variant="accordion">
              <v-expansion-panel v-for="op in group.items" :key="op.key" :value="op.key">
                <v-expansion-panel-title>
                  <v-chip
                    size="small"
                    variant="tonal"
                    :color="methodColor(op.method)"
                    class="nami-method"
                    label
                  >
                    {{ op.method }}
                  </v-chip>
                  <code class="nami-mono ml-3">{{ op.path }}</code>
                  <span v-if="op.summary" class="text-medium-emphasis ml-3">{{ op.summary }}</span>
                </v-expansion-panel-title>

                <v-expansion-panel-text>
                  <div class="d-flex align-center ga-2 flex-wrap mb-3">
                    <v-chip v-if="op.noAuth" size="x-small" variant="tonal" color="success" label>
                      无需认证
                    </v-chip>
                    <v-chip v-if="op.deprecated" size="x-small" variant="tonal" color="error" label>
                      已废弃
                    </v-chip>
                    <v-chip v-for="name in op.tags" :key="name" size="x-small" variant="tonal" label>
                      {{ name }}
                    </v-chip>
                  </div>

                  <div v-if="op.description" class="nami-prose text-body-2 mb-4">
                    {{ op.description }}
                  </div>

                  <!-- 参数 -->
                  <template v-if="op.parameters.length > 0">
                    <div class="text-subtitle-2 mb-2">参数</div>
                    <v-table density="compact" class="mb-4">
                      <thead>
                        <tr>
                          <th style="width: 180px">名称</th>
                          <th style="width: 90px">位置</th>
                          <th style="width: 80px">必填</th>
                          <th style="width: 220px">schema</th>
                          <th>说明</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="(param, index) in op.parameters" :key="`${param.name}-${param.in}-${index}`">
                          <td class="nami-mono">{{ param.name ?? '—' }}</td>
                          <td>
                            <v-chip size="x-small" variant="tonal">{{ param.in ?? '—' }}</v-chip>
                          </td>
                          <td>{{ param.required ? '是' : '否' }}</td>
                          <td class="nami-mono text-caption">{{ schemaSummary(param.schema) }}</td>
                          <td class="text-caption">{{ param.description ?? '' }}</td>
                        </tr>
                      </tbody>
                    </v-table>
                  </template>

                  <!-- 请求体 -->
                  <template v-if="requestSchema(op.requestBody)">
                    <div class="text-subtitle-2 mb-2">
                      请求体
                      <v-chip
                        size="x-small"
                        variant="tonal"
                        :color="requestRequired(op.requestBody) ? 'warning' : undefined"
                        class="ml-2"
                      >
                        {{ requestRequired(op.requestBody) ? '必填' : '可选' }}
                      </v-chip>
                    </div>
                    <JsonBlock
                      :value="requestSchema(op.requestBody)"
                      label="application/json"
                      max-height="320px"
                      class="mb-4"
                    />
                  </template>

                  <!-- 响应 -->
                  <div class="text-subtitle-2 mb-2">响应</div>
                  <v-table density="compact">
                    <thead>
                      <tr>
                        <th style="width: 90px">状态码</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="response in op.responses" :key="response.status">
                        <td>
                          <v-chip
                            size="x-small"
                            variant="tonal"
                            :color="statusColor(response.status)"
                            label
                          >
                            {{ response.status }}
                          </v-chip>
                        </td>
                        <td class="text-caption">{{ response.description }}</td>
                      </tr>
                      <tr v-if="op.responses.length === 0">
                        <td colspan="2" class="text-caption text-medium-emphasis">
                          文档没有描述任何响应。
                        </td>
                      </tr>
                    </tbody>
                  </v-table>
                  <JsonBlock
                    v-if="op.responseSchemas"
                    :value="op.responseSchemas"
                    label="响应 schema（按状态码）"
                    max-height="320px"
                    class="mt-3"
                  />
                </v-expansion-panel-text>
              </v-expansion-panel>
            </v-expansion-panels>
          </template>

          <v-alert
            v-if="groups.length === 0"
            type="info"
            variant="tonal"
            class="mt-4"
            title="没有匹配的接口"
          >
            <div class="text-body-2">换个关键词，或把标签筛选切回「全部标签」。</div>
          </v-alert>

          <!-- ---------------------------- 原始规范 ---------------------------- -->
          <v-expansion-panels class="mt-6">
            <v-expansion-panel value="raw">
              <v-expansion-panel-title>
                <v-icon icon="mdiCodeJson" size="18" class="mr-2" />
                原始规范
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <JsonBlock :value="spec" label="openapi.json" max-height="560px" />
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </template>
      </template>
    </AsyncSection>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '@/api/client';
import { describeError } from '@/composables/useShell';
import PageHeader from '@/components/PageHeader.vue';
import AsyncSection from '@/components/AsyncSection.vue';
import JsonBlock from '@/components/JsonBlock.vue';

const props = defineProps<{ refreshToken?: number }>();

type Json = Record<string, unknown>;

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: unknown;
  example?: unknown;
}

interface OpenApiOperation {
  tags?: unknown;
  summary?: unknown;
  description?: unknown;
  parameters?: unknown;
  requestBody?: unknown;
  responses?: unknown;
  security?: unknown;
  deprecated?: unknown;
}

interface OpenApiTag {
  name?: string;
  description?: string;
}

interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string; description?: string; summary?: string };
  tags?: OpenApiTag[];
  paths?: unknown;
  [key: string]: unknown;
}

interface OperationResponse {
  status: string;
  description: string;
  schema: unknown;
}

interface OperationEntry {
  key: string;
  method: string;
  path: string;
  tag: string;
  tags: string[];
  summary: string;
  description: string;
  parameters: OpenApiParameter[];
  requestBody: unknown;
  responses: OperationResponse[];
  responseSchemas: Record<string, unknown> | null;
  noAuth: boolean;
  deprecated: boolean;
}

/** OpenAPI 文档里会出现、但本页不当作操作的方法名。 */
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

const METHOD_COLORS: Record<string, string> = {
  GET: 'success',
  POST: 'primary',
  PUT: 'warning',
  DELETE: 'error',
  PATCH: 'info',
};

const UNTAGGED = '未分组';

const spec = ref<OpenApiSpec | null>(null);
const loading = ref(false);
const loadError = ref('');
const search = ref('');
const tag = ref('all');

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    spec.value = (await api.openapi()) as OpenApiSpec;
  } catch (e) {
    loadError.value = describeError(e);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function firstTag(operation: OpenApiOperation): string {
  const tags = operation.tags;
  if (Array.isArray(tags) && tags.length > 0) {
    const name = asString(tags[0]);
    if (name !== '') return name;
  }
  return UNTAGGED;
}

function normalizeParameters(operation: OpenApiOperation, shared: unknown): OpenApiParameter[] {
  const out: OpenApiParameter[] = [];
  const push = (raw: unknown): void => {
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (item && typeof item === 'object') out.push(item as OpenApiParameter);
    }
  };
  // 路径级参数对所有方法生效，先放进去再补操作自己的。
  push(shared);
  push(operation.parameters);
  return out;
}

function responseSchemaParts(response: unknown): unknown {
  if (!response || typeof response !== 'object') return null;
  const content = (response as { content?: unknown }).content;
  if (!content || typeof content !== 'object') return null;
  const record = content as Record<string, unknown>;
  const media = record['application/json'] ?? record['text/event-stream'] ?? record['text/html'];
  if (!media || typeof media !== 'object') return null;
  return (media as { schema?: unknown }).schema ?? null;
}

function collectResponses(operation: OpenApiOperation): {
  list: OperationResponse[];
  schemas: Record<string, unknown> | null;
} {
  const raw = operation.responses;
  if (!raw || typeof raw !== 'object') return { list: [], schemas: null };
  const list: OperationResponse[] = [];
  const schemas: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(raw as Record<string, unknown>)) {
    const description =
      response && typeof response === 'object'
        ? asString((response as { description?: unknown }).description)
        : '';
    list.push({ status, description, schema: responseSchemaParts(response) });
    const schema = responseSchemaParts(response);
    if (schema !== null && schema !== undefined) schemas[status] = schema;
  }
  return { list, schemas: Object.keys(schemas).length > 0 ? schemas : null };
}

const operations = computed<OperationEntry[]>(() => {
  const paths = spec.value?.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return [];

  const out: OperationEntry[] = [];
  for (const [path, rawItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
    const item = rawItem as Json;
    const sharedParameters = item.parameters;

    for (const method of METHODS) {
      const raw = item[method];
      if (!raw || typeof raw !== 'object') continue;
      const operation = raw as OpenApiOperation;
      const { list, schemas } = collectResponses(operation);
      const tags = Array.isArray(operation.tags)
        ? operation.tags.map((name) => asString(name)).filter((name) => name !== '')
        : [];
      out.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        tag: firstTag(operation),
        tags,
        summary: asString(operation.summary),
        description: asString(operation.description),
        parameters: normalizeParameters(operation, sharedParameters),
        requestBody: operation.requestBody,
        responses: list,
        responseSchemas: schemas,
        // security: [] 在 OpenAPI 里表示「显式关闭认证」。
        noAuth: Array.isArray(operation.security) && operation.security.length === 0,
        deprecated: operation.deprecated === true,
      });
    }
  }
  return out;
});

/** spec.tags 的顺序优先，没声明的标签按出现顺序补在后面。 */
const tagOrder = computed<string[]>(() => {
  const declared: string[] = [];
  for (const item of spec.value?.tags ?? []) {
    const name = asString(item?.name);
    if (name !== '' && !declared.includes(name)) declared.push(name);
  }
  for (const operation of operations.value) {
    if (!declared.includes(operation.tag)) declared.push(operation.tag);
  }
  return declared;
});

const tagItems = computed(() => [
  { title: '全部标签', value: 'all' },
  ...tagOrder.value.map((name) => ({ title: name, value: name })),
]);

const query = computed(() => search.value.trim().toLowerCase());

const filtered = computed(() => {
  const q = query.value;
  return operations.value.filter((operation) => {
    if (tag.value !== 'all' && operation.tag !== tag.value) return false;
    if (q === '') return true;
    return (
      operation.method.toLowerCase().includes(q) ||
      operation.path.toLowerCase().includes(q) ||
      operation.summary.toLowerCase().includes(q) ||
      operation.description.toLowerCase().includes(q)
    );
  });
});

const groups = computed(() => {
  const descriptions = new Map<string, string>();
  for (const item of spec.value?.tags ?? []) {
    const name = asString(item?.name);
    if (name !== '') descriptions.set(name, asString(item?.description));
  }
  return tagOrder.value
    .map((name) => ({
      name,
      description: descriptions.get(name) ?? '',
      items: filtered.value.filter((operation) => operation.tag === name),
    }))
    .filter((group) => group.items.length > 0);
});

/** paths 必须是非空对象，否则整个页面没有可渲染的内容。 */
const hasPaths = computed(() => {
  const paths = spec.value?.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return false;
  return Object.keys(paths as Record<string, unknown>).length > 0;
});

/* ------------------------------------------------------------------ *
 * 展示辅助
 * ------------------------------------------------------------------ */

function methodColor(method: string): string {
  return METHOD_COLORS[method] ?? 'secondary';
}

function statusColor(status: string): string {
  if (status.startsWith('2')) return 'success';
  if (status.startsWith('3')) return 'info';
  if (status.startsWith('4')) return 'warning';
  if (status.startsWith('5')) return 'error';
  return 'secondary';
}

/** 把 JSON Schema 压成一行可读摘要，避免在表格里塞一整块 JSON。 */
function schemaSummary(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return '—';
  const value = schema as Json;
  if (typeof value.$ref === 'string') return value.$ref;

  const parts: string[] = [];
  const type = value.type;
  if (typeof type === 'string') parts.push(type);
  else if (Array.isArray(type)) parts.push(type.map((item) => String(item)).join(' | '));
  if (typeof value.format === 'string') parts.push(value.format);
  if (value.const !== undefined) parts.push(`const ${JSON.stringify(value.const)}`);
  if (Array.isArray(value.enum)) parts.push(`enum: ${value.enum.map((item) => String(item)).join(' / ')}`);
  if (value.default !== undefined) parts.push(`默认 ${JSON.stringify(value.default)}`);
  if (value.minimum !== undefined) parts.push(`≥ ${String(value.minimum)}`);
  if (value.maximum !== undefined) parts.push(`≤ ${String(value.maximum)}`);
  if (value.items) parts.push(`items: ${schemaSummary(value.items)}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

function requestSchema(body: unknown): unknown {
  if (!body || typeof body !== 'object') return null;
  const content = (body as { content?: unknown }).content;
  if (!content || typeof content !== 'object') return null;
  const media = (content as Record<string, unknown>)['application/json'];
  if (!media || typeof media !== 'object') return null;
  return (media as { schema?: unknown }).schema ?? null;
}

function requestRequired(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && (body as { required?: unknown }).required === true);
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

.nami-method {
  min-width: 74px;
  justify-content: center;
}

.nami-cmd {
  margin: 0 0 6px;
  padding: 8px 12px;
  border: 1px solid rgb(var(--v-theme-border-color, 35 42 54));
  border-radius: 6px;
  background: rgb(var(--v-theme-surface-light));
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* OpenAPI 的 description 里带换行和列表，保留换行比强行压成一行更好读。 */
.nami-prose {
  white-space: pre-wrap;
  line-height: 1.7;
}
</style>
