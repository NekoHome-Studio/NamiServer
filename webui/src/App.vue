<template>
  <!-- The login route renders without any chrome so a signed-out operator sees
       only the form. -->
  <v-app v-if="bare">
    <v-main>
      <router-view />
    </v-main>
  </v-app>

  <v-app v-else>
    <!-- Sidebar -->
    <v-navigation-drawer v-model="drawer" :rail="rail" permanent width="236" class="nami-drawer">
      <div class="d-flex align-center px-4 py-3 nami-brand">
        <span class="nami-brand__mark">🌊</span>
        <div v-if="!rail" class="ml-2">
          <div class="text-subtitle-1 font-weight-bold">Nami</div>
          <div class="text-caption text-medium-emphasis">Agent Server</div>
        </div>
      </div>

      <v-divider />

      <v-list nav density="comfortable" class="py-2">
        <v-list-item
          v-for="item in navItems"
          :key="item.name"
          :to="{ name: item.name }"
          :prepend-icon="item.icon"
          :title="item.title"
          rounded="lg"
        />
      </v-list>

      <template #append>
        <v-divider />
        <div v-if="!rail" class="pa-3">
          <div class="d-flex align-center ga-2 mb-1">
            <v-icon
              :icon="health.ok ? 'mdiCheckCircle' : 'mdiAlertCircle'"
              :color="health.ok ? 'success' : 'error'"
              size="16"
            />
            <span class="text-caption">{{ health.ok ? '服务正常' : '服务不可达' }}</span>
          </div>
          <div class="text-caption text-medium-emphasis nami-mono">
            v{{ overview?.version ?? '—' }} · {{ overview?.provider ?? '—' }}
          </div>
          <div class="text-caption text-medium-emphasis nami-mono">
            运行 {{ formatUptime(overview?.uptimeSeconds) }}
          </div>
        </div>
        <div class="d-flex justify-center pb-2">
          <v-btn
            :icon="rail ? 'mdiChevronRight' : 'mdiChevronLeft'"
            variant="text"
            size="small"
            :title="rail ? '展开侧栏' : '收起侧栏'"
            @click="rail = !rail"
          />
        </div>
      </template>
    </v-navigation-drawer>

    <!-- Top bar -->
    <v-app-bar flat height="60" class="nami-appbar">
      <v-app-bar-nav-icon class="d-md-none" @click="drawer = !drawer" />
      <v-app-bar-title>
        <span class="text-subtitle-1">{{ currentTitle }}</span>
      </v-app-bar-title>

      <v-spacer />

      <v-btn
        :icon="theme.global.name.value === 'namiDark' ? 'mdiWeatherSunny' : 'mdiWeatherNight'"
        variant="text"
        :title="theme.global.name.value === 'namiDark' ? '切换到浅色' : '切换到深色'"
        @click="toggleTheme"
      />
      <v-btn
        icon="mdiRefresh"
        variant="text"
        title="刷新当前页数据"
        @click="refreshAll"
      />

      <v-menu location="bottom end">
        <template #activator="{ props }">
          <v-btn v-bind="props" variant="text" prepend-icon="mdiAccountCircle" class="text-none">
            <span class="d-none d-sm-inline">{{ maskedCredential }}</span>
          </v-btn>
        </template>
        <v-list density="comfortable" min-width="240">
          <v-list-item
            prepend-icon="mdiKeyOutline"
            title="更换凭证"
            @click="changeCredential"
          />
          <v-list-item
            prepend-icon="mdiOpenInNew"
            title="打开 API 文档"
            @click="openDocs"
          />
          <v-divider />
          <v-list-item
            prepend-icon="mdiLogout"
            title="退出登录"
            @click="signOut"
          />
        </v-list>
      </v-menu>
    </v-app-bar>

    <v-main class="nami-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" :refresh-token="refreshToken" />
      </router-view>
    </v-main>

    <!-- Global toasts -->
    <div class="nami-toasts">
      <v-alert
        v-for="toastItem in shell.toasts.value"
        :key="toastItem.id"
        :type="toastItem.kind"
        variant="tonal"
        density="comfortable"
        closable
        class="nami-toast"
        @click:close="shell.dismiss(toastItem.id)"
      >
        <div class="text-body-2">{{ toastItem.message }}</div>
        <div v-if="toastItem.detail" class="text-caption text-medium-emphasis mt-1">
          {{ toastItem.detail }}
        </div>
      </v-alert>
    </div>
  </v-app>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTheme } from 'vuetify';
import { api } from '@/api/client';
import type { HealthResponse, OverviewResponse } from '@/api/client';
import { auth, formatUptime, shell } from '@/composables/useShell';

const route = useRoute();
const router = useRouter();
const theme = useTheme();

const drawer = ref(true);
const rail = ref(false);
const overview = ref<OverviewResponse | null>(null);
const health = ref<{ ok: boolean; data: HealthResponse | null }>({ ok: false, data: null });

/** Bumped to ask the active view to re-fetch, e.g. from the refresh button. */
const refreshToken = ref(0);
let healthTimer: number | undefined;

const bare = computed(() => route.meta.bare === true);
const currentTitle = computed(() =>
  typeof route.meta.title === 'string' ? route.meta.title : 'Nami',
);

const navItems = computed(() =>
  router
    .getRoutes()
    .filter((record) => typeof record.meta.icon === 'string' && record.meta.public !== true)
    .map((record) => ({
      name: String(record.name),
      title: typeof record.meta.title === 'string' ? record.meta.title : String(record.name),
      icon: String(record.meta.icon),
    })),
);

/** Never show the credential itself; just enough to tell which one is loaded. */
const maskedCredential = computed(() => {
  const value = api.credential.value;
  if (value === '') return '未登录';
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 6)}…${value.slice(-3)}`;
});

function toggleTheme(): void {
  theme.global.name.value = theme.global.name.value === 'namiDark' ? 'namiLight' : 'namiDark';
  try {
    localStorage.setItem('nami.theme', theme.global.name.value);
  } catch {
    /* storage unavailable */
  }
}

function refreshAll(): void {
  refreshToken.value += 1;
  void loadShellData();
  shell.info('已请求刷新');
}

function changeCredential(): void {
  void router.push({ name: 'login', query: { redirect: route.fullPath } });
}

function openDocs(): void {
  void router.push({ name: 'api' });
}

function signOut(): void {
  auth.signOut();
  void router.push({ name: 'login' });
}

/** Lightweight poll: the shell only needs enough to colour the status dot. */
async function loadShellData(): Promise<void> {
  if (!api.authenticated) return;
  try {
    health.value = { ok: true, data: await api.health() };
  } catch {
    health.value = { ok: false, data: health.value.data };
  }
  try {
    overview.value = await api.overview();
  } catch {
    // A failure here is usually the credential; describeError already handled
    // the sign-out side effect on the request itself.
  }
}

onMounted(() => {
  try {
    const stored = localStorage.getItem('nami.theme');
    if (stored === 'namiDark' || stored === 'namiLight') theme.global.name.value = stored;
  } catch {
    /* storage unavailable */
  }
  void loadShellData();
  healthTimer = window.setInterval(() => void loadShellData(), 15_000);
});

onUnmounted(() => {
  if (healthTimer !== undefined) window.clearInterval(healthTimer);
});
</script>

<style>
.nami-brand__mark {
  font-size: 22px;
  line-height: 1;
}
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}
.nami-main {
  background: rgb(var(--v-theme-background));
}
.nami-toasts {
  position: fixed;
  top: 72px;
  right: 16px;
  z-index: 2400;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
}
.nami-toast {
  pointer-events: auto;
  box-shadow: 0 6px 24px rgb(0 0 0 / 35%);
}
</style>
