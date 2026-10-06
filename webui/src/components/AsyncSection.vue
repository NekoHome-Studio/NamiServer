<template>
  <!-- One place decides what "loading", "failed" and "empty" look like, so every
       view reports them identically instead of each inventing its own spinner. -->
  <div>
    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" rounded />

    <v-alert
      v-if="error"
      type="error"
      variant="tonal"
      class="mb-4"
      :title="errorTitle"
    >
      <div class="text-body-2">{{ error }}</div>
      <template #append>
        <v-btn variant="text" size="small" prepend-icon="mdiRefresh" @click="emit('retry')">
          重试
        </v-btn>
      </template>
    </v-alert>

    <v-card v-if="!loading && !error && empty" variant="flat" border>
      <v-card-text class="text-center py-10">
        <v-icon :icon="emptyIcon" size="40" class="text-medium-emphasis mb-3" />
        <div class="text-body-1">{{ emptyTitle }}</div>
        <div v-if="emptyHint" class="text-caption text-medium-emphasis mt-1">{{ emptyHint }}</div>
        <div class="mt-4">
          <slot name="empty-action" />
        </div>
      </v-card-text>
    </v-card>

    <slot v-if="!loading && !error && !empty" />
  </div>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    loading?: boolean;
    error?: string | null;
    empty?: boolean;
    errorTitle?: string;
    emptyTitle?: string;
    emptyHint?: string;
    emptyIcon?: string;
  }>(),
  {
    loading: false,
    error: null,
    empty: false,
    errorTitle: '加载失败',
    emptyTitle: '暂无数据',
    emptyIcon: 'mdiInboxOutline',
  },
);

const emit = defineEmits<{ retry: [] }>();
</script>
