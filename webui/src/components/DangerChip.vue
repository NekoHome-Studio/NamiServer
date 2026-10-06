<template>
  <v-chip :color="meta.color" :prepend-icon="meta.icon" size="small" variant="tonal" label>
    {{ meta.label }}
  </v-chip>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ level: string | undefined | null }>();

/** Mirrors the server's DangerLevel vocabulary; unknown values degrade safely. */
const meta = computed(() => {
  switch (props.level) {
    case 'dangerous':
      return { label: '危险', color: 'error', icon: 'mdiAlertOctagonOutline' };
    case 'caution':
      return { label: '需谨慎', color: 'warning', icon: 'mdiAlertOutline' };
    case 'safe':
      return { label: '安全', color: 'success', icon: 'mdiShieldCheckOutline' };
    default:
      return { label: props.level ?? '未知', color: 'secondary', icon: 'mdiHelpCircleOutline' };
  }
});
</script>
