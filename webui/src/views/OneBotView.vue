<template>
  <v-container fluid class="pa-6">
    <PageHeader
      title="OneBot / QQ"
      subtitle="通过 SnowLuma（或任意 OneBot v11 实现）把 QQ 接到 Nami：群里/私聊的消息触发智能体，回答再发回 QQ。"
    >
      <template #actions>
        <v-btn variant="tonal" prepend-icon="mdiRefresh" :loading="loading" @click="load">
          刷新
        </v-btn>
      </template>
    </PageHeader>

    <AsyncSection
      :loading="loading && status === null"
      :error="error"
      :empty="status === null"
      empty-title="没有拿到 OneBot 状态"
      empty-hint="服务器没有返回状态对象。"
      @retry="load"
    >
      <template v-if="status">
        <!-- ------------------------------------------------------------------
             未启用时不给一个空仪表盘：直接告诉运维要写哪几个变量。
             这段文案与 src/routes/onebot.ts 里的报错信息保持一致。
        ------------------------------------------------------------------- -->
        <template v-if="!status.enabled">
          <v-alert type="info" variant="tonal" class="mb-4" title="OneBot 连接器当前未启用">
            <div class="text-body-2 mb-3">
              Nami 没有连接任何 QQ 实现，所以这个页面上的其它面板都不会生效。
              在项目根目录的 <code class="nami-mono">.env</code> 里写入下面三个变量，然后重启 Nami：
            </div>
            <pre class="nami-cmd">NAMI_ONEBOT_ENABLED=true
NAMI_ONEBOT_URL=http://127.0.0.1:3000
NAMI_ONEBOT_EVENT_TOKEN=与上报端共享的密钥</pre>
            <div class="text-caption mt-3">
              <div>· <code class="nami-mono">NAMI_ONEBOT_URL</code> 是 OneBot 实现的 HTTP API 基地址，不要带路径后缀。</div>
              <div>· <code class="nami-mono">NAMI_ONEBOT_EVENT_TOKEN</code> 必须非空，否则上报端点会拒绝一切请求。</div>
              <div>· 入站还需要 <code class="nami-mono">NAMI_ONEBOT_INBOUND_ENABLED=true</code>（默认关闭）。</div>
              <div>· 也别忘了 <code class="nami-mono">NAMI_ONEBOT_ACCESS_TOKEN</code>：Nami 反过来调 OneBot API 时要用它。</div>
            </div>
            <template #append>
              <v-btn
                variant="text"
                size="small"
                prepend-icon="mdiTuneVariant"
                :to="{ name: 'config' }"
              >
                去配置页
              </v-btn>
            </template>
          </v-alert>
        </template>

        <template v-else>
          <!-- ---------------------------- 连接状态 ---------------------------- -->
          <v-card class="mb-4">
            <v-card-title class="d-flex align-center ga-2 text-subtitle-2">
              <v-icon
                :icon="status.connection.reachable ? 'mdiLanConnect' : 'mdiLanDisconnect'"
                :color="status.connection.reachable ? 'success' : 'error'"
                size="20"
              />
              连接状态
              <v-spacer />
              <v-chip
                :color="status.connection.reachable ? 'success' : 'error'"
                variant="tonal"
                label
              >
                {{ status.connection.reachable ? '可达' : '不可达' }}
              </v-chip>
            </v-card-title>
            <v-card-text>
              <v-row dense>
                <v-col cols="12" sm="6" md="4">
                  <div class="text-caption text-medium-emphasis">OneBot 地址</div>
                  <div class="nami-mono text-body-2">{{ status.url || '（未配置）' }}</div>
                </v-col>
                <v-col cols="12" sm="6" md="4">
                  <div class="text-caption text-medium-emphasis">登录账号</div>
                  <div class="text-body-2">
                    <template v-if="status.connection.account">
                      {{ status.connection.account.nickname || '（无昵称）' }}
                      <span class="nami-mono text-medium-emphasis">
                        ({{ status.connection.account.userId }})
                      </span>
                    </template>
                    <span v-else class="text-medium-emphasis">未知</span>
                  </div>
                </v-col>
                <v-col cols="12" sm="6" md="4">
                  <div class="text-caption text-medium-emphasis">在线 / 状态良好</div>
                  <div class="d-flex ga-2 align-center">
                    <v-chip
                      size="small"
                      variant="tonal"
                      :color="flagColor(status.connection.online)"
                    >
                      online：{{ flagText(status.connection.online) }}
                    </v-chip>
                    <v-chip size="small" variant="tonal" :color="flagColor(status.connection.good)">
                      good：{{ flagText(status.connection.good) }}
                    </v-chip>
                  </div>
                </v-col>
              </v-row>

              <v-alert
                v-if="status.connection.error"
                type="error"
                variant="tonal"
                density="comfortable"
                class="mt-4"
                title="探测失败"
              >
                <div class="text-body-2 nami-mono">{{ status.connection.error }}</div>
                <div class="text-caption mt-1">
                  常见原因：OneBot 实现没启动、地址写错、或者 NAMI_ONEBOT_ACCESS_TOKEN 与它不一致。
                </div>
              </v-alert>
            </v-card-text>
          </v-card>

          <!-- ---------------------------- 配置摘要 ---------------------------- -->
          <v-card class="mb-4">
            <v-card-title class="text-subtitle-2">配置摘要</v-card-title>
            <v-card-text>
              <v-alert
                v-if="!status.inbound.ready"
                type="warning"
                variant="tonal"
                density="comfortable"
                class="mb-4"
                title="入站尚未就绪"
              >
                <div class="text-body-2">
                  <template v-if="!status.eventTokenConfigured">
                    没有配置 <code class="nami-mono">NAMI_ONEBOT_EVENT_TOKEN</code>，所以
                    <code class="nami-mono">{{ status.inbound.path }}</code> 会拒绝每一个上报（503）。
                    这是刻意的：一个不需要密钥的上报端点等于任何人都能让你的模型开始计费。
                  </template>
                  <template v-else>
                    入站端点被关闭了：检查 <code class="nami-mono">NAMI_ONEBOT_INBOUND_ENABLED</code> 是否为 true。
                  </template>
                </div>
              </v-alert>

              <v-row dense>
                <v-col
                  v-for="row in summaryRows"
                  :key="row.label"
                  cols="12"
                  sm="6"
                  md="4"
                >
                  <div class="text-caption text-medium-emphasis">{{ row.label }}</div>
                  <div
                    class="text-body-2"
                    :class="[row.mono ? 'nami-mono' : '', row.tone ? `text-${row.tone}` : '']"
                  >
                    {{ row.value }}
                  </div>
                </v-col>
              </v-row>
            </v-card-text>
          </v-card>

          <!-- ---------------------------- 桥接计数 ---------------------------- -->
          <div class="text-subtitle-2 mb-2">桥接计数</div>
          <v-row dense class="mb-4">
            <v-col v-for="card in counters" :key="card.label" cols="6" sm="4" md="3" lg="2">
              <StatCard
                :label="card.label"
                :value="card.value"
                :icon="card.icon"
                :tone="card.tone"
              />
            </v-col>
          </v-row>

          <v-card class="mb-4">
            <v-card-text class="d-flex flex-wrap ga-6">
              <div>
                <div class="text-caption text-medium-emphasis">最近事件时间</div>
                <div class="text-body-2">{{ formatRelative(status.bridge.lastEventAt) }}</div>
              </div>
              <div>
                <div class="text-caption text-medium-emphasis">最近一次判定</div>
                <div class="text-body-2">
                  <code class="nami-mono">{{ status.bridge.lastReason ?? '—' }}</code>
                  <span v-if="lastReasonMeaning" class="text-medium-emphasis">
                    · {{ lastReasonMeaning }}
                  </span>
                </div>
              </div>
              <div>
                <div class="text-caption text-medium-emphasis">工具出站</div>
                <div class="text-body-2">
                  {{ status.tools.enabled ? '已启用' : '未启用' }} ·
                  实际可发送：{{ status.tools.sendingEnabled ? '是' : '否' }}
                </div>
              </div>
            </v-card-text>
          </v-card>

          <!-- ---------------------------- 模拟事件 ---------------------------- -->
          <v-card class="mb-4">
            <v-card-title class="d-flex align-center ga-2 text-subtitle-2">
              <v-icon icon="mdiFlaskOutline" size="20" />
              模拟事件
              <v-chip size="small" variant="tonal" color="info" class="ml-1">推荐</v-chip>
            </v-card-title>
            <v-card-text>
              <div class="text-body-2 mb-4">
                没有真实 QQ 账号也能验证整条入站链路：这里会构造一个 OneBot v11 群消息，
                同步调用 <code class="nami-mono">POST /admin/api/onebot/event</code>，并返回判定结果。
                注意它走的是完整流程——真的会跑模型，也会真的往群里发消息。
              </div>

              <v-form @submit.prevent="submitSimulate">
                <v-row dense>
                  <v-col cols="12" md="4">
                    <v-text-field
                      v-model="sim.groupId"
                      label="群号 group_id"
                      placeholder="例如 123456789"
                      inputmode="numeric"
                      :error-messages="simErrors.groupId"
                      @update:model-value="simErrors.groupId = ''"
                    />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field
                      v-model="sim.userId"
                      label="发送者 QQ user_id"
                      placeholder="例如 10001"
                      inputmode="numeric"
                      :error-messages="simErrors.userId"
                      @update:model-value="simErrors.userId = ''"
                    />
                  </v-col>
                  <v-col cols="12" md="4">
                    <v-text-field
                      v-model="sim.selfId"
                      label="机器人 QQ self_id"
                      placeholder="见上方连接卡片"
                      inputmode="numeric"
                      :error-messages="simErrors.selfId"
                      @update:model-value="simErrors.selfId = ''"
                    />
                  </v-col>
                  <v-col cols="12">
                    <v-text-field
                      v-model="sim.text"
                      label="消息文本"
                      placeholder="例如 介绍一下你自己"
                      :error-messages="simErrors.text"
                      @update:model-value="simErrors.text = ''"
                    />
                  </v-col>
                </v-row>

                <v-checkbox
                  v-model="sim.mention"
                  density="comfortable"
                  hide-details
                  label="以 @机器人 的形式发送（在消息里追加一个指向 self_id 的 at 段）"
                  class="mb-2"
                />

                <div class="d-flex align-center ga-3 flex-wrap">
                  <v-btn
                    type="submit"
                    color="primary"
                    prepend-icon="mdiPlayCircleOutline"
                    :loading="simulating"
                  >
                    发送模拟事件
                  </v-btn>
                  <span class="text-caption text-medium-emphasis">
                    当前触发规则 <code class="nami-mono">{{ status.inbound.trigger }}</code>
                    <template v-if="status.inbound.trigger === 'mention'">
                      ，所以不勾选 @ 时大概率会被判为 no-trigger。
                    </template>
                    <template v-else-if="status.inbound.trigger === 'prefix'">
                      ，消息需要以 <code class="nami-mono">{{ status.inbound.prefix }}</code> 开头。
                    </template>
                    <template v-else-if="status.inbound.trigger === 'none'">
                      ，也就是永远不触发。
                    </template>
                  </span>
                </div>
              </v-form>

              <v-alert
                v-if="simError"
                type="error"
                variant="tonal"
                density="comfortable"
                class="mt-4"
                title="模拟失败"
              >
                <div class="text-body-2">{{ simError }}</div>
              </v-alert>

              <template v-if="simResult">
                <v-divider class="my-5" />
                <div class="d-flex align-center ga-2 mb-3">
                  <v-icon
                    :icon="simResult.handled ? 'mdiCheckCircleOutline' : 'mdiMinusCircleOutline'"
                    :color="simResult.handled ? 'success' : 'warning'"
                    size="20"
                  />
                  <span class="text-subtitle-2">
                    结果：{{ simResult.handled ? '已处理' : '已跳过' }}
                  </span>
                  <v-chip
                    size="small"
                    variant="tonal"
                    :color="simResult.reason === 'handled' ? 'success' : 'warning'"
                    label
                  >
                    {{ simResult.reason }}
                  </v-chip>
                </div>

                <v-row dense class="mb-3">
                  <v-col cols="6" sm="4" md="2">
                    <div class="text-caption text-medium-emphasis">handled</div>
                    <div class="text-body-2">{{ simResult.handled }}</div>
                  </v-col>
                  <v-col cols="6" sm="4" md="2">
                    <div class="text-caption text-medium-emphasis">sessionId</div>
                    <div class="text-body-2 nami-mono">{{ simResult.sessionId ?? '—' }}</div>
                  </v-col>
                  <v-col cols="6" sm="4" md="2">
                    <div class="text-caption text-medium-emphasis">分片数 chunks</div>
                    <div class="text-body-2">{{ simResult.chunks ?? '—' }}</div>
                  </v-col>
                  <v-col cols="6" sm="4" md="2">
                    <div class="text-caption text-medium-emphasis">回复字符数</div>
                    <div class="text-body-2">{{ simResult.replyChars ?? '—' }}</div>
                  </v-col>
                  <v-col cols="6" sm="4" md="2">
                    <div class="text-caption text-medium-emphasis">耗时</div>
                    <div class="text-body-2">{{ formatDuration(simResult.durationMs) }}</div>
                  </v-col>
                  <v-col v-if="simResult.error" cols="12" sm="8" md="10">
                    <div class="text-caption text-medium-emphasis">error</div>
                    <div class="text-body-2 nami-mono text-error">{{ simResult.error }}</div>
                  </v-col>
                </v-row>

                <v-alert
                  v-if="simResult.hint"
                  type="info"
                  variant="tonal"
                  density="comfortable"
                  class="mb-3"
                >
                  <div class="text-body-2">{{ hintZh(simResult.hint) }}</div>
                </v-alert>

                <JsonBlock :value="simResult" label="原始响应" max-height="260px" />
              </template>

              <v-divider class="my-5" />

              <div class="text-subtitle-2 mb-2">reason 取值说明</div>
              <v-table density="compact" class="nami-reasons">
                <thead>
                  <tr>
                    <th style="width: 160px">reason</th>
                    <th style="width: 200px">含义</th>
                    <th>什么时候出现</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="reason in reasons" :key="reason.value">
                    <td><code class="nami-mono">{{ reason.value }}</code></td>
                    <td>{{ reason.meaning }}</td>
                    <td class="text-medium-emphasis">{{ reason.when }}</td>
                  </tr>
                </tbody>
              </v-table>
            </v-card-text>
          </v-card>

          <!-- ---------------------------- 手动发送 ---------------------------- -->
          <v-card>
            <v-card-title class="d-flex align-center ga-2 text-subtitle-2">
              <v-icon icon="mdiSendVariantOutline" size="20" />
              手动发送
            </v-card-title>
            <v-card-text>
              <v-alert
                type="warning"
                variant="tonal"
                density="comfortable"
                class="mb-4"
                title="这是诊断用的后门"
              >
                <div class="text-body-2">
                  它绕过智能体直接调用 OneBot API，但不会绕过连接器总开关：
                  <code class="nami-mono">NAMI_ONEBOT_ENABLED=false</code> 时这里会返回 503。
                </div>
              </v-alert>

              <v-form @submit.prevent="submitSend">
                <v-btn-toggle v-model="send.target" mandatory density="comfortable" class="mb-4">
                  <v-btn value="group" prepend-icon="mdiAccountGroupOutline">群消息</v-btn>
                  <v-btn value="private" prepend-icon="mdiAccountOutline">私聊</v-btn>
                </v-btn-toggle>

                <v-row dense>
                  <v-col cols="12" md="6">
                    <v-text-field
                      v-if="send.target === 'group'"
                      v-model="send.groupId"
                      label="群号 group_id"
                      placeholder="例如 123456789"
                      inputmode="numeric"
                      :error-messages="sendErrors.groupId"
                      @update:model-value="sendErrors.groupId = ''"
                    />
                    <v-text-field
                      v-else
                      v-model="send.userId"
                      label="私聊 QQ user_id"
                      placeholder="例如 10001"
                      inputmode="numeric"
                      :error-messages="sendErrors.userId"
                      @update:model-value="sendErrors.userId = ''"
                    />
                  </v-col>
                  <v-col cols="12" md="6">
                    <v-text-field
                      v-model="send.at"
                      label="@ 某人 QQ（可留空）"
                      placeholder="例如 10001"
                      inputmode="numeric"
                      :error-messages="sendErrors.at"
                      @update:model-value="sendErrors.at = ''"
                    />
                  </v-col>
                  <v-col cols="12">
                    <v-textarea
                      v-model="send.text"
                      label="内容"
                      rows="3"
                      auto-grow
                      :error-messages="sendErrors.text"
                      @update:model-value="sendErrors.text = ''"
                    />
                  </v-col>
                </v-row>

                <v-btn
                  type="submit"
                  color="primary"
                  prepend-icon="mdiSend"
                  :loading="sending"
                >
                  发送
                </v-btn>
              </v-form>

              <v-alert
                v-if="sendError"
                type="error"
                variant="tonal"
                density="comfortable"
                class="mt-4"
                title="发送失败"
              >
                <div class="text-body-2">{{ sendError }}</div>
              </v-alert>

              <v-alert
                v-else-if="sendResult"
                type="success"
                variant="tonal"
                density="comfortable"
                class="mt-4"
                title="已交给 OneBot"
              >
                <div class="text-body-2">
                  messageId：
                  <code class="nami-mono">{{ sendResult.messageId ?? '（对方未返回）' }}</code>
                  <span v-if="sendResult.target" class="text-medium-emphasis">
                    · 目标 {{ sendResult.target.kind }} {{ sendResult.target.id }}
                  </span>
                </div>
                <JsonBlock :value="sendResult" label="原始响应" max-height="200px" class="mt-3" />
              </v-alert>
            </v-card-text>
          </v-card>
        </template>
      </template>
    </AsyncSection>
  </v-container>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { api } from '@/api/client';
import type { OneBotStatus } from '@/api/client';
import {
  describeError,
  formatDuration,
  formatRelative,
  toastError,
} from '@/composables/useShell';
import PageHeader from '@/components/PageHeader.vue';
import StatCard from '@/components/StatCard.vue';
import AsyncSection from '@/components/AsyncSection.vue';
import JsonBlock from '@/components/JsonBlock.vue';

const props = defineProps<{ refreshToken?: number }>();

type Tone = 'default' | 'success' | 'warning' | 'error' | 'info' | 'primary';

const status = ref<OneBotStatus | null>(null);
const loading = ref(false);
const error = ref('');

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    status.value = await api.onebotStatus();
  } catch (e) {
    error.value = describeError(e);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 展示辅助
 * ------------------------------------------------------------------ */

/** 三态布尔转文案：null/undefined 表示该实现没回答这一项，不等于 false。 */
function flagText(value: boolean | null | undefined): string {
  if (value === true) return '是';
  if (value === false) return '否';
  return '未知';
}

function flagColor(value: boolean | null | undefined): string {
  if (value === true) return 'success';
  if (value === false) return 'error';
  return 'secondary';
}

interface SummaryRow {
  label: string;
  value: string;
  mono?: boolean;
  tone?: string;
}

const summaryRows = computed<SummaryRow[]>(() => {
  const s = status.value;
  if (!s) return [];
  const inbound = s.inbound;
  return [
    { label: 'OneBot URL', value: s.url || '（未配置）', mono: true },
    {
      label: 'NAMI_ONEBOT_ACCESS_TOKEN',
      value: s.accessTokenConfigured ? '已配置' : '未配置',
      tone: s.accessTokenConfigured ? 'success' : 'warning',
    },
    {
      // 只报告布尔，永远不显示令牌本身。
      label: 'NAMI_ONEBOT_EVENT_TOKEN',
      value: s.eventTokenConfigured ? '已配置' : '未配置',
      tone: s.eventTokenConfigured ? 'success' : 'error',
    },
    {
      label: '入站 ready',
      value: inbound.ready ? 'true' : 'false',
      tone: inbound.ready ? 'success' : 'warning',
    },
    { label: '上报路径', value: inbound.path, mono: true },
    { label: '触发规则 trigger', value: inbound.trigger, mono: true },
    { label: '触发前缀 prefix', value: inbound.prefix || '（空）', mono: true },
    {
      label: '允许的群 allowGroups',
      value: inbound.allowGroups.length > 0 ? inbound.allowGroups.join(', ') : '（不限）',
      mono: inbound.allowGroups.length > 0,
    },
    {
      label: '允许的用户 allowUsers',
      value: inbound.allowUsers.length > 0 ? inbound.allowUsers.join(', ') : '（不限）',
      mono: inbound.allowUsers.length > 0,
    },
    { label: '会话前缀 sessionPrefix', value: inbound.sessionPrefix, mono: true },
    { label: '单条回复上限', value: `${inbound.maxReplyChars} 字符` },
    { label: '剥离 Markdown', value: inbound.stripMarkdown ? '是' : '否' },
    { label: '并发上限 maxConcurrent', value: String(inbound.maxConcurrent) },
  ];
});

const counters = computed(() => {
  const b = status.value?.bridge;
  const cards: Array<{ label: string; value: number; icon: string; tone: Tone }> = [
    { label: '接收 received', value: b?.received ?? 0, icon: 'mdiInboxArrowDownOutline', tone: 'default' },
    { label: '处理 handled', value: b?.handled ?? 0, icon: 'mdiCheckCircleOutline', tone: 'success' },
    { label: '跳过 skipped', value: b?.skipped ?? 0, icon: 'mdiDebugStepOver', tone: 'info' },
    { label: '回复 replies', value: b?.replies ?? 0, icon: 'mdiSendOutline', tone: 'primary' },
    { label: '繁忙 busy', value: b?.busy ?? 0, icon: 'mdiTimerSandComplete', tone: 'warning' },
    { label: '失败 failures', value: b?.failures ?? 0, icon: 'mdiAlertCircleOutline', tone: 'error' },
    { label: '运行中 activeRuns', value: b?.activeRuns ?? 0, icon: 'mdiProgressClock', tone: 'default' },
  ];
  return cards;
});

/**
 * 把服务器的英文 hint 翻成中文。
 *
 * hint 是由 src/routes/onebot.ts 拼出来的固定英文句子，这里按关键词匹配；
 * 认不出来就原文照显——宁可显示英文，也不能把服务器给的线索吞掉。
 */
function hintZh(hint: string): string {
  if (hint.includes('did not match the trigger rule')) {
    const trigger = status.value?.inbound.trigger ?? '?';
    const detail: Record<string, string> = {
      mention: '默认规则下，群消息必须 @ 了机器人才算；私聊一律视为对机器人说。',
      prefix: `需要以配置的前缀（${status.value?.inbound.prefix || '空'}）开头。`,
      none: 'trigger=none 表示永不触发。',
      all: 'trigger=all 时这条不该出现，请检查配置是否已重启生效。',
    };
    return `消息没有命中触发规则（trigger=${trigger}）。${detail[trigger] ?? ''}`;
  }
  if (hint.includes('equals self_id')) {
    return 'user_id 等于 self_id，看起来是机器人自己发的消息，为避免自问自答被忽略。';
  }
  if (hint.includes('already in flight') || hint.includes('concurrency cap')) {
    return '同一会话已有运行在跑，或已达到 NAMI_ONEBOT_MAX_CONCURRENT 并发上限；事件被丢弃而不是排队。';
  }
  return hint;
}

const lastReasonMeaning = computed(() => {
  const reason = status.value?.bridge.lastReason;
  if (!reason) return '';
  const found = reasons.find((item) => item.value === reason);
  return found ? found.meaning : '';
});

/* ------------------------------------------------------------------ *
 * 模拟事件
 * ------------------------------------------------------------------ */

interface SimResult {
  handled?: boolean;
  reason?: string;
  sessionId?: string;
  chunks?: number;
  replyChars?: number;
  durationMs?: number;
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

const sim = reactive({ groupId: '', userId: '', selfId: '', text: '', mention: true });
const simErrors = reactive({ groupId: '', userId: '', selfId: '', text: '' });
const simulating = ref(false);
const simError = ref('');
const simResult = ref<SimResult | null>(null);

const reasons: Array<{ value: string; meaning: string; when: string }> = [
  {
    value: 'handled',
    meaning: '已触发',
    when: '通过全部过滤，模型已经跑完并且回复已经发出去。',
  },
  {
    value: 'no-trigger',
    meaning: '触发规则没命中',
    when: '默认 trigger=mention：群里只有 @ 了机器人才算；私聊一律算。trigger=prefix 时要求以指定前缀开头。',
  },
  {
    value: 'from-self',
    meaning: '自己发的',
    when: 'user_id 等于 self_id，为避免机器人自己和自己对话被忽略。',
  },
  {
    value: 'group-not-allowed',
    meaning: '群不在白名单',
    when: 'NAMI_ONEBOT_ALLOW_GROUPS 非空，且这个群号不在里面。',
  },
  {
    value: 'user-not-allowed',
    meaning: '用户不在白名单',
    when: 'NAMI_ONEBOT_ALLOW_USERS 非空，且发送者不在里面。',
  },
  {
    value: 'empty',
    meaning: '没有文字',
    when: '消息里只有图片/表情/@ 等段，抽不出任何文本。',
  },
  {
    value: 'busy',
    meaning: '同一会话繁忙',
    when: '该会话还有一次运行没结束，或者已经达到 NAMI_ONEBOT_MAX_CONCURRENT 并发上限。',
  },
  {
    value: 'not-message',
    meaning: '不是消息事件',
    when: 'post_type 不是 message、message_type 不是 group/private，或者缺少 group_id/user_id。',
  },
  {
    value: 'failed',
    meaning: '处理过程中出错',
    when: '模型或发送环节抛错，接口会返回 502，error 字段里是原因。',
  },
];

const DIGITS = /^\d+$/;

/** 只允许纯数字：把 "123abc" 交给服务器只会换来一个模糊的 400。 */
function requireDigits(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === '') return `请填写${label}`;
  if (!DIGITS.test(trimmed)) return `${label}只能是数字`;
  return '';
}

async function submitSimulate(): Promise<void> {
  simError.value = '';
  simResult.value = null;

  simErrors.groupId = requireDigits(sim.groupId, '群号');
  simErrors.userId = requireDigits(sim.userId, '发送者 QQ');
  simErrors.selfId = requireDigits(sim.selfId, '机器人 QQ');
  simErrors.text = sim.text.trim() === '' ? '请填写消息文本' : '';
  if (Object.values(simErrors).some((message) => message !== '')) return;

  const selfId = sim.selfId.trim();
  // 数组形式的 message：先 @ 再正文，与 bridge.extractMessage 的解析方式一致。
  const message: Array<Record<string, unknown>> = [];
  if (sim.mention) message.push({ type: 'at', data: { qq: selfId } });
  message.push({ type: 'text', data: { text: sim.text } });

  const event = {
    post_type: 'message',
    message_type: 'group',
    group_id: Number(sim.groupId.trim()),
    user_id: Number(sim.userId.trim()),
    self_id: Number(selfId),
    message,
    sender: { nickname: '控制台测试' },
  };

  simulating.value = true;
  try {
    simResult.value = (await api.onebotSimulate(event)) as SimResult;
  } catch (e) {
    simError.value = describeError(e);
    toastError(e, '模拟事件');
  } finally {
    simulating.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * 手动发送
 * ------------------------------------------------------------------ */

interface SendResult {
  messageId?: string | number | null;
  target?: { kind: string; id: string };
}

const send = reactive({ target: 'group' as 'group' | 'private', groupId: '', userId: '', text: '', at: '' });
const sendErrors = reactive({ groupId: '', userId: '', at: '', text: '' });
const sending = ref(false);
const sendError = ref('');
const sendResult = ref<SendResult | null>(null);

async function submitSend(): Promise<void> {
  sendError.value = '';
  sendResult.value = null;
  sendErrors.groupId = '';
  sendErrors.userId = '';
  sendErrors.at = '';
  sendErrors.text = '';

  if (send.target === 'group') sendErrors.groupId = requireDigits(send.groupId, '群号');
  else sendErrors.userId = requireDigits(send.userId, '私聊 QQ');
  if (send.at.trim() !== '' && !DIGITS.test(send.at.trim())) sendErrors.at = '@ 目标只能是数字';
  if (send.text.trim() === '') sendErrors.text = '请填写要发送的内容';
  if (Object.values(sendErrors).some((message) => message !== '')) return;

  const body: { text: string; group_id?: string; user_id?: string; at?: string } = {
    text: send.text,
  };
  if (send.target === 'group') body.group_id = send.groupId.trim();
  else body.user_id = send.userId.trim();
  if (send.at.trim() !== '') body.at = send.at.trim();

  sending.value = true;
  try {
    sendResult.value = (await api.onebotSend(body)) as SendResult;
  } catch (e) {
    sendError.value = describeError(e);
    toastError(e, '手动发送');
  } finally {
    sending.value = false;
  }
}

onMounted(() => {
  void load();
});

// 顶栏的全局刷新按钮会自增 refreshToken，这里跟着重新拉一次状态。
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
  margin: 0;
  padding: 12px 14px;
  border: 1px solid rgb(var(--v-theme-border-color, 35 42 54));
  border-radius: 8px;
  background: rgb(var(--v-theme-surface-light));
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.7;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.nami-reasons :deep(td) {
  vertical-align: top;
}
</style>
