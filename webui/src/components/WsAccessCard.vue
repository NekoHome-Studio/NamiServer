<template>
  <v-card class="mt-4">
    <v-card-title class="text-subtitle-2 d-flex align-center flex-wrap ga-2">
      <v-icon icon="mdiLanConnect" size="18" class="mr-1" />
      WebSocket 接入
      <v-chip
        :color="status?.tokenConfigured ? 'success' : 'secondary'"
        variant="tonal"
        size="small"
        label
      >
        {{ status?.tokenConfigured ? '专用令牌已启用' : '沿用 API Key' }}
      </v-chip>
      <v-spacer />
      <v-btn
        size="small"
        variant="text"
        prepend-icon="mdiRefresh"
        :loading="loading"
        @click="load"
      >
        刷新
      </v-btn>
    </v-card-title>

    <v-card-text>
      <v-alert v-if="error" type="error" variant="tonal" density="comfortable" class="mb-4">
        <div class="text-body-2">{{ error }}</div>
      </v-alert>

      <!-- The freshly minted token: shown exactly once, so it is impossible to miss. -->
      <v-alert v-if="minted" type="warning" variant="tonal" class="mb-4">
        <template #title>新令牌（只显示这一次）</template>
        <div class="d-flex align-center ga-2 flex-wrap mt-1">
          <code class="nami-token">{{ minted }}</code>
          <v-btn size="small" variant="tonal" prepend-icon="mdiContentCopy" @click="copy(minted)">
            复制令牌
          </v-btn>
          <v-btn size="small" variant="tonal" prepend-icon="mdiLinkVariant" @click="copy(fullUrl(minted))">
            复制连接串
          </v-btn>
        </div>
        <div class="text-caption mt-2">
          关掉这条提示后就再也读不回来了（接口只报告「已配置」，不回显值）。丢失了就重新生成一个。
        </div>
      </v-alert>

      <p class="text-body-2 mb-3">
        <template v-if="status?.tokenConfigured">
          现在 <code class="nami-mono">/ws</code> <strong>只认</strong>这个专用令牌——API Key 与 Admin
          Token 都不再能连。令牌对 <code class="nami-mono">/v1/*</code> 和
          <code class="nami-mono">/admin/api/*</code> 无效，泄露也只能连 WS。
        </template>
        <template v-else>
          当前 <code class="nami-mono">/ws</code> 与 <code class="nami-mono">/v1/*</code> 共用 API
          Key。浏览器无法为 WebSocket 握手设置请求头，只能把凭据放进 URL 查询串——那会进代理日志与浏览器历史。
          生成一个专用令牌可以避免把通用钥匙撒出去。
        </template>
      </p>

      <v-row dense>
        <v-col cols="12" md="6">
          <div class="text-caption text-medium-emphasis">连接地址</div>
          <code class="nami-mono">{{ url }}</code>
        </v-col>
        <v-col cols="6" md="2">
          <div class="text-caption text-medium-emphasis">活跃连接</div>
          <div>{{ status?.activeConnections ?? '—' }} / {{ status?.maxConnectionsPerKey ?? '—' }}</div>
        </v-col>
        <v-col cols="6" md="2">
          <div class="text-caption text-medium-emphasis">心跳</div>
          <div>{{ Math.round((status?.heartbeatMs ?? 0) / 1000) }}s</div>
        </v-col>
        <v-col cols="6" md="2">
          <div class="text-caption text-medium-emphasis">消息 收/发</div>
          <div>{{ status?.messagesIn ?? '—' }} / {{ status?.messagesOut ?? '—' }}</div>
        </v-col>
      </v-row>

      <div class="mt-4">
        <div class="text-caption text-medium-emphasis mb-1">浏览器连接示例</div>
        <pre class="nami-snippet">{{ snippet }}</pre>
      </div>
    </v-card-text>

    <v-card-actions class="flex-wrap ga-2">
      <v-btn
        color="primary"
        variant="tonal"
        prepend-icon="mdiKeyPlus"
        :loading="busy"
        @click="confirmAction = 'generate'"
      >
        {{ status?.tokenConfigured ? '轮换令牌' : '生成专用令牌' }}
      </v-btn>
      <v-btn
        v-if="status?.tokenConfigured"
        variant="text"
        color="error"
        prepend-icon="mdiKeyRemove"
        :loading="busy"
        @click="confirmAction = 'remove'"
      >
        移除令牌（回落到 API Key）
      </v-btn>
      <v-spacer />
      <span class="text-caption text-medium-emphasis">
        {{
          status?.hotReload === false
            ? '热重载已关闭：改动需要点顶栏「重启」生效'
            : '改动会写入 .env 并自动热重载，约 1 秒生效'
        }}
      </span>
    </v-card-actions>

    <!-- Rotating disconnects every live client, so it is never one click away. -->
    <v-dialog :model-value="confirmAction !== null" max-width="520" @update:model-value="confirmAction = null">
      <v-card :title="confirmAction === 'remove' ? '移除 WebSocket 令牌' : '生成新的 WebSocket 令牌'">
        <v-card-text>
          <p v-if="confirmAction === 'remove'" class="text-body-2">
            清空 <code class="nami-mono">NAMI_WS_TOKEN</code> 后，<code class="nami-mono">/ws</code>
            重新接受 API Key。所有只用专用令牌的客户端需要改用 API Key 才能连上。
          </p>
          <p v-else class="text-body-2">
            新令牌会写入 <code class="nami-mono">.env</code> 并热重载。<strong>所有现有 WS 连接会被断开</strong>，
            客户端必须换成新令牌才能重连。旧令牌立即失效。
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmAction = null">取消</v-btn>
          <v-btn
            color="primary"
            :loading="busy"
            @click="confirmAction === 'remove' ? remove() : generate()"
          >
            确认
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '@/api/client';
import type { WsStatus } from '@/api/client';
import { describeError, shell } from '@/composables/useShell';

const status = ref<WsStatus | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
/** The token from the last generate call; cleared as soon as it is copied away. */
const minted = ref('');
const confirmAction = ref<'generate' | 'remove' | null>(null);

/** The address a browser would use, derived from the page it is served from. */
const url = computed(() => {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}${status.value?.path ?? '/ws'}`;
});

function fullUrl(token: string): string {
  return `${url.value}?key=${encodeURIComponent(token)}`;
}

const snippet = computed(() => {
  const credential = status.value?.tokenConfigured ? '$WS_TOKEN' : '$API_KEY';
  return `const ws = new WebSocket(\n  \`${url.value}?key=\${encodeURIComponent('${credential}')}\`,\n);`;
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    status.value = await api.wsStatus();
  } catch (failure) {
    error.value = describeError(failure);
  } finally {
    loading.value = false;
  }
}

async function generate(): Promise<void> {
  confirmAction.value = null;
  busy.value = true;
  error.value = '';
  try {
    const result = await api.generateWsToken();
    minted.value = result.token;
    shell.success('已生成 WebSocket 专用令牌', result.note);
    // Give the reload a moment so the status reflects the new value.
    window.setTimeout(() => void load(), 1500);
  } catch (failure) {
    error.value = describeError(failure);
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  confirmAction.value = null;
  busy.value = true;
  error.value = '';
  try {
    const result = await api.removeWsToken();
    minted.value = '';
    shell.success('已移除 WebSocket 专用令牌', result.note);
    window.setTimeout(() => void load(), 1500);
  } catch (failure) {
    error.value = describeError(failure);
  } finally {
    busy.value = false;
  }
}

async function copy(value: string): Promise<void> {
  if (!navigator.clipboard || !window.isSecureContext) {
    // Plain HTTP is not a secure context: say so instead of throwing.
    shell.warning('当前环境不支持自动复制', '请手动选中并复制上面的文本。');
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    shell.success('已复制');
  } catch {
    shell.warning('复制失败', '请手动选中并复制。');
  }
}

onMounted(() => {
  void load();
});
</script>

<style scoped>
.nami-token {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  word-break: break-all;
}
.nami-snippet {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  background: rgb(var(--v-theme-surface-variant));
  border-radius: 8px;
  padding: 10px 12px;
  margin: 0;
}
</style>
