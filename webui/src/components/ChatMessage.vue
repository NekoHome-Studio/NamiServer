<template>
  <div class="nami-msg" :class="{ 'nami-msg--user': isUser }">
    <div class="d-flex align-center ga-2 mb-1">
      <v-avatar :color="isUser ? 'primary' : 'success'" size="22" variant="tonal">
        <v-icon :icon="isUser ? icons.user : icons.assistant" size="14" />
      </v-avatar>
      <span class="text-caption font-weight-medium">{{ isUser ? '你' : 'Nami' }}</span>
      <v-progress-circular
        v-if="streaming"
        indeterminate
        size="12"
        width="2"
        color="primary"
      />
    </div>

    <v-card
      :variant="isUser ? 'tonal' : 'flat'"
      :color="cardColor"
      :border="!isUser"
      class="nami-msg__card"
    >
      <v-card-text class="py-3">
        <!-- 纯文本插值：消息内容来自模型和工具，绝不能被当成 HTML 解析。 -->
        <div v-if="text" class="nami-msg__text">{{ text }}</div>
        <div v-else class="text-caption text-medium-emphasis">
          {{ streaming ? '正在生成…' : '（空回复）' }}
        </div>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 转录里的一条消息气泡。
 *
 * 只负责「谁说的、说了什么」，工具调用由 ChatToolCall 单独承载——两者视觉上
 * 必须能被一眼区分，否则 agent 循环的信息就淹在文本里了。
 */
import { computed } from 'vue';
import { mdiAccountOutline, mdiRobotHappyOutline } from '@mdi/js';

const props = defineProps<{
  role: 'user' | 'assistant';
  text: string;
  streaming?: boolean;
  /** 服务端或网络错误，用 error 色调呈现。 */
  error?: boolean;
}>();

const icons = { user: mdiAccountOutline, assistant: mdiRobotHappyOutline } as const;

const isUser = computed(() => props.role === 'user');
const cardColor = computed(() => {
  if (props.error) return 'error';
  return isUser.value ? 'primary' : undefined;
});
</script>

<style scoped>
.nami-msg {
  margin-bottom: 14px;
}
.nami-msg--user {
  /* 用户消息靠右收窄，视觉上就不必细看标签也能分清对话双方。 */
  max-width: min(760px, 92%);
  margin-left: auto;
}
.nami-msg__card {
  max-width: 100%;
}
.nami-msg__text {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 14px;
  line-height: 1.7;
}
</style>
