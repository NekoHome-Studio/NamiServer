<template>
  <div class="pa-6 text-center">
    <v-icon icon="mdiMapSearchOutline" size="48" class="text-medium-emphasis mb-3" />
    <h1 class="text-h6 mb-1">页面不存在</h1>
    <p class="text-body-2 text-medium-emphasis">
      没有找到 <span class="nami-mono">{{ route.fullPath }}</span>。
    </p>
    <v-btn color="primary" class="mt-3" prepend-icon="mdiHomeOutline" @click="router.push({ name: 'dashboard' })">
      返回仪表盘
    </v-btn>
  </div>
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';

const route = useRoute();
const router = useRouter();
</script>

<style scoped>
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
</style>
