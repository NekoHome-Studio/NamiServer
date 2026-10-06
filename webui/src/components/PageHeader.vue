<template>
  <div class="d-flex align-start ga-4 mb-5 flex-wrap">
    <div class="flex-grow-1" style="min-width: 240px">
      <h1 class="text-h5 font-weight-bold mb-1">{{ title }}</h1>
      <p v-if="subtitle" class="text-body-2 text-medium-emphasis ma-0">{{ subtitle }}</p>
    </div>
    <div class="d-flex ga-2 align-center flex-wrap">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  title: string;
  subtitle?: string;
}>();
</script>
