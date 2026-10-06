<template>
  <div class="nami-json">
    <div class="d-flex align-center ga-1 mb-1">
      <span v-if="label" class="text-caption text-medium-emphasis">{{ label }}</span>
      <v-spacer />
      <v-btn
        size="x-small"
        variant="text"
        :prepend-icon="copied ? 'mdiCheck' : 'mdiContentCopy'"
        @click="copy"
      >
        {{ copied ? '已复制' : '复制' }}
      </v-btn>
    </div>
    <pre class="nami-json__body" :style="{ maxHeight: maxHeight }">{{ text }}</pre>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { prettyJson } from '@/composables/useShell';

const props = withDefaults(
  defineProps<{
    value: unknown;
    label?: string;
    maxHeight?: string;
  }>(),
  { maxHeight: '340px' },
);

const copied = ref(false);
const text = computed(() => prettyJson(props.value));

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(text.value);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard access can be denied; the text is selectable either way.
  }
}
</script>

<style scoped>
.nami-json__body {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid rgb(var(--v-theme-border-color, 35 42 54));
  border-radius: 8px;
  background: rgb(var(--v-theme-surface-light));
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
