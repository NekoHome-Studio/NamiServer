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
            <span class="d-none d-sm-inline">{{ auth.displayName.value }}</span>
          </v-btn>
        </template>
        <v-list density="comfortable" min-width="240">
          <v-list-item
            v-if="auth.currentUser.value"
            :title="auth.currentUser.value.username"
            :subtitle="auth.currentUser.value.isAdmin ? '管理员' : '普通用户'"
            prepend-icon="mdiAccountOutline"
          />
          <v-divider v-if="auth.currentUser.value" />
          <v-list-item
            v-if="auth.currentUser.value"
            prepend-icon="mdiLockReset"
            title="修改密码"
            @click="passwordDialog = true"
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

    <!-- Change your own password. Revokes every other session, so it says so. -->
    <v-dialog v-model="passwordDialog" max-width="520">
      <v-card title="修改密码">
        <v-card-text>
          <v-alert type="info" variant="tonal" density="comfortable" class="mb-4">
            <div class="text-body-2">
              修改成功后，该账号在<strong>其它设备上的登录会全部失效</strong>，当前浏览器会自动续期。
            </div>
          </v-alert>
          <v-text-field
            v-model="currentPassword"
            label="当前密码"
            type="password"
            autocomplete="current-password"
          />
          <v-text-field
            v-model="newPassword"
            label="新密码（至少 10 个字符）"
            type="password"
            autocomplete="new-password"
          />
          <v-text-field
            v-model="confirmPassword"
            label="再输一次新密码"
            type="password"
            autocomplete="new-password"
          />
          <v-alert v-if="passwordError" type="error" variant="tonal" density="comfortable">
            <div class="text-body-2">{{ passwordError }}</div>
          </v-alert>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="closePasswordDialog">取消</v-btn>
          <v-btn color="primary" :loading="passwordSaving" @click="submitPassword">保存</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useTheme } from 'vuetify';
import { api } from '@/api/client';
import type { HealthResponse, OverviewResponse } from '@/api/client';
import { auth, describeError, formatUptime, shell } from '@/composables/useShell';

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

const passwordDialog = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const passwordError = ref('');
const passwordSaving = ref(false);

function closePasswordDialog(): void {
  passwordDialog.value = false;
  currentPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';
  passwordError.value = '';
}

async function submitPassword(): Promise<void> {
  passwordError.value = '';
  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = '两次输入的新密码不一致。';
    return;
  }
  passwordSaving.value = true;
  try {
    const result = await api.changePassword(currentPassword.value, newPassword.value);
    closePasswordDialog();
    shell.success(
      '密码已修改',
      result.revokedSessions > 0 ? `已注销其它 ${result.revokedSessions} 个会话` : undefined,
    );
  } catch (error) {
    passwordError.value = describeError(error);
  } finally {
    passwordSaving.value = false;
  }
}

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

function openDocs(): void {
  void router.push({ name: 'api' });
}

function signOut(): void {
  void auth.signOut().finally(() => router.push({ name: 'login' }));
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

/*
 * Signing in happens *after* this component mounts — the login route renders
 * inside the same `v-app` — so without this the status footer would read
 * "服务不可达" until the next 15-second tick.
 */
watch(
  () => auth.authState.value?.authenticated === true,
  (signedIn) => {
    if (signedIn) void loadShellData();
  },
);

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
