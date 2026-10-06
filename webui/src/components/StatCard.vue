<template>
  <v-card class="h-100">
    <v-card-text class="d-flex align-start ga-3">
      <v-avatar :color="toneColor" variant="tonal" size="40" rounded="lg">
        <v-icon :icon="icon" size="20" />
      </v-avatar>
      <div class="flex-grow-1" style="min-width: 0">
        <div class="text-caption text-medium-emphasis">{{ label }}</div>
        <div class="text-h5 font-weight-bold nami-stat__value" :title="String(value)">
          {{ value }}
        </div>
        <div v-if="hint" class="text-caption text-medium-emphasis mt-1">{{ hint }}</div>
        <slot />
      </div>
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    icon?: string;
    tone?: 'default' | 'success' | 'warning' | 'error' | 'info' | 'primary';
  }>(),
  { icon: 'mdiChartBoxOutline', tone: 'default' },
);

const toneColor = computed(() => (props.tone === 'default' ? undefined : props.tone));
</script>

<style scoped>
.nami-stat__value {
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
