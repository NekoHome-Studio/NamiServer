<template>
  <v-card>
    <v-card-title class="text-subtitle-1 d-flex align-center ga-2">
      <v-icon icon="mdiServerOutline" size="20" />
      运行时信息
    </v-card-title>
    <v-divider />
    <v-card-text>
      <v-row dense>
        <v-col cols="12" md="6">
          <v-table density="compact">
            <tbody>
              <tr v-for="row in runtimeRows" :key="row.label">
                <td class="text-medium-emphasis" style="width: 132px">{{ row.label }}</td>
                <td :class="row.mono ? 'nami-mono' : undefined" class="nami-break">{{ row.value }}</td>
              </tr>
            </tbody>
          </v-table>
        </v-col>

        <v-col cols="12" md="6">
          <template v-if="onebotRows.length > 0">
            <div class="d-flex align-center ga-2 mb-1">
              <v-icon icon="mdiQqchat" size="18" />
              <span class="text-body-2 font-weight-medium">OneBot 桥接</span>
              <v-chip
                :color="onebot?.sendingEnabled ? 'success' : 'warning'"
                variant="tonal"
                size="small"
                label
              >
                {{ onebot?.sendingEnabled ? '可发送' : '仅接收' }}
              </v-chip>
            </div>
            <v-table density="compact">
              <tbody>
                <tr v-for="row in onebotRows" :key="row.label">
                  <td class="text-medium-emphasis" style="width: 132px">{{ row.label }}</td>
                  <td class="nami-break">{{ row.value }}</td>
                </tr>
              </tbody>
            </v-table>
          </template>

          <v-alert
            v-else
            type="info"
            variant="tonal"
            density="comfortable"
            icon="mdiQqchat"
            title="OneBot 未启用"
          >
            <div class="text-body-2">
              在 .env 中设置 <code class="nami-code">NAMI_ONEBOT_ENABLED=true</code>
              后，这里会显示 QQ 桥接的地址与计数。
            </div>
          </v-alert>
        </v-col>
      </v-row>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { HealthResponse, OverviewResponse } from '@/api/client';
import { formatTime } from '@/composables/useShell';

const props = defineProps<{
  overview: OverviewResponse | null;
  health: HealthResponse | null;
}>();

interface InfoRow {
  label: string;
  value: string;
  mono?: boolean;
}

type OneBotInfo = Extract<OverviewResponse['onebot'], { enabled: true }>;

/**
 * 就绪与指标的细节都在别的卡片里，这张卡只回答「这台机器现在拿什么在跑」，
 * 所以缺失的值统一显示为破折号而不是把 undefined 漏到界面上。
 */
const runtimeRows = computed<InfoRow[]>(() => {
  const info = props.overview;
  const models = info?.models;

  const rows: InfoRow[] = [
    { label: '提供方', value: info?.provider ?? '—', mono: true },
    { label: '默认模型', value: info && info.model !== '' ? info.model : '未选择', mono: true },
    {
      label: '模型目录',
      value: models
        ? models.discoveryOk
          ? `已发现 ${models.discovered} · 已暴露 ${models.exposed.length} · 别名 ${models.aliases.length}`
          : `探测失败：${models.lastError ?? '原因未知'}`
        : '—',
    },
    {
      label: '客户端选模型',
      value: models ? (models.allowClientModel ? '允许' : '不允许（始终用默认模型）') : '—',
    },
    {
      label: '限流',
      value: info?.rateLimit
        ? info.rateLimit.enabled
          ? `${info.rateLimit.perSecond}/秒 · 突发 ${info.rateLimit.burst} · 跟踪键 ${info.rateLimit.trackedKeys}`
          : '未启用'
        : '—',
    },
    {
      label: 'WebSocket',
      value: info
        ? `${info.websocket.path} · 当前 ${info.websocket.activeConnections} 连接`
        : '—',
      mono: true,
    },
    { label: '数据库', value: info?.store.dbPath ?? '—', mono: true },
    {
      label: '运行时',
      value: props.health ? `${props.health.node} · PID ${props.health.pid}` : '—',
      mono: true,
    },
    { label: '版本 / 启动', value: info ? `v${info.version} · ${formatTime(info.startedAt)}` : '—' },
  ];

  return rows;
});

const onebot = computed<OneBotInfo | null>(() => {
  const info = props.overview?.onebot;
  return info !== undefined && info.enabled ? info : null;
});

const onebotRows = computed<InfoRow[]>(() => {
  const info = onebot.value;
  if (!info) return [];
  const counter = (key: string): string => {
    const value = info.stats[key];
    return value === undefined || value === null ? '0' : String(value);
  };
  return [
    { label: '地址', value: info.url, mono: true },
    {
      label: '入站触发',
      value: info.inboundReady ? info.trigger : `${info.trigger}（未就绪：需启用入站并配置事件令牌）`,
    },
    { label: '发送能力', value: info.sendingEnabled ? '已开启' : '未开启（需开启工具与白名单）' },
    {
      label: '桥接计数',
      value: `收到 ${counter('received')} · 处理 ${counter('handled')} · 跳过 ${counter('skipped')} · 回复 ${counter('replies')} · 失败 ${counter('failures')}`,
    },
  ];
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
.nami-break {
  word-break: break-all;
  white-space: normal;
}
</style>
