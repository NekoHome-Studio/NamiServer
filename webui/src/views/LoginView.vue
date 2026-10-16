<template>
  <v-container class="fill-height" fluid>
    <v-row justify="center" align="center" class="fill-height">
      <v-col cols="12" sm="8" md="6" lg="4">
        <div class="text-center mb-6">
          <div style="font-size: 44px; line-height: 1">🌊</div>
          <h1 class="text-h5 font-weight-bold mt-2">Nami · 控制台</h1>
          <p class="text-body-2 text-medium-emphasis">Agent Server 管理界面</p>
        </div>

        <v-card>
          <v-card-text class="pa-6">
            <v-alert
              v-if="auth.error.value"
              type="warning"
              variant="tonal"
              density="comfortable"
              class="mb-5"
              title="上次的登录已失效"
            >
              <div class="text-body-2">{{ auth.error.value }}</div>
            </v-alert>

            <!-- Account login: the normal path. -->
            <v-form v-if="!useKey" @submit.prevent="submitAccount">
              <v-text-field
                v-model="username"
                label="用户名"
                autocomplete="username"
                spellcheck="false"
                autofocus
                :disabled="busy"
              />
              <v-text-field
                v-model="password"
                label="密码"
                :type="reveal ? 'text' : 'password'"
                :append-inner-icon="reveal ? 'mdiEyeOff' : 'mdiEye'"
                autocomplete="current-password"
                :disabled="busy"
                @click:append-inner="reveal = !reveal"
              />

              <v-alert v-if="error" type="error" variant="tonal" density="comfortable" class="mb-4">
                <div class="text-body-2">{{ error }}</div>
                <div v-if="hint" class="text-caption mt-1">{{ hint }}</div>
              </v-alert>

              <v-btn type="submit" color="primary" block size="large" :loading="busy" prepend-icon="mdiLoginVariant">
                登录
              </v-btn>
            </v-form>

            <!-- API-key fallback: for a deployment with no account, or a locked-out operator. -->
            <v-form v-else @submit.prevent="submitKey">
              <v-text-field
                v-model="apiKey"
                label="API Key"
                placeholder="nami_…"
                :type="reveal ? 'text' : 'password'"
                :append-inner-icon="reveal ? 'mdiEyeOff' : 'mdiEye'"
                autocomplete="off"
                spellcheck="false"
                autofocus
                :disabled="busy"
                @click:append-inner="reveal = !reveal"
              />
              <v-alert v-if="error" type="error" variant="tonal" density="comfortable" class="mb-4">
                <div class="text-body-2">{{ error }}</div>
              </v-alert>
              <v-btn type="submit" color="primary" block size="large" :loading="busy" prepend-icon="mdiKeyOutline">
                用 API Key 进入
              </v-btn>
            </v-form>

            <v-divider class="my-5" />

            <div class="text-caption text-medium-emphasis">
              <template v-if="!useKey">
                <p class="mb-0">
                  账号由服务器创建。没有账号或忘记密码时，在服务器上执行
                  <code class="nami-mono">npm run passwd -- --user admin --generate</code>。
                </p>
                <p class="mb-0 mt-3">
                  也可以用
                  <a href="#" @click.prevent="useKey = true">API Key</a> 登录（程序化调用用的那种）。
                </p>
              </template>
              <template v-else>
                <p class="mb-0">
                  填 <code class="nami-mono">NAMI_API_KEYS</code> 中的任意一个，或
                  <code class="nami-mono">NAMI_ADMIN_TOKEN</code>。
                </p>
                <p class="mb-0 mt-3">
                  <a href="#" @click.prevent="useKey = false">返回账号登录</a>
                </p>
              </template>
            </div>
          </v-card-text>
        </v-card>

        <p class="text-caption text-medium-emphasis text-center mt-4">
          登录后凭据保存在 HttpOnly Cookie 中，页面脚本读不到它。
        </p>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '@/api/client';
import { auth } from '@/composables/useShell';

const route = useRoute();
const router = useRouter();

const username = ref('');
const password = ref('');
const apiKey = ref('');
const useKey = ref(false);
const reveal = ref(false);
const busy = ref(false);
const error = ref('');
const hint = ref('');

/** Sends the operator where they were headed, or to the dashboard. */
function go(): void {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
  void router.replace(redirect);
}

function describe(error_: unknown, keyMode: boolean): void {
  if (error_ instanceof ApiError) {
    error.value = error_.message;
    hint.value =
      error_.status === 401
        ? keyMode
          ? '凭证不匹配 NAMI_API_KEYS，也没有命中 NAMI_ADMIN_TOKEN。'
          : '用户名或密码不正确。'
        : error_.status === 403
          ? '凭证有效但没有管理权限：服务器配置了 NAMI_ADMIN_TOKEN。'
          : error_.status === 429
            ? '失败次数过多，已被暂时锁定。'
            : '请确认 Nami 正在运行，且地址与端口正确。';
    return;
  }
  error.value = error_ instanceof Error ? error_.message : String(error_);
}

async function submitAccount(): Promise<void> {
  error.value = '';
  hint.value = '';
  if (username.value.trim() === '' || password.value === '') {
    error.value = '用户名和密码都必须填写。';
    return;
  }
  busy.value = true;
  try {
    await api.login(username.value.trim(), password.value);
    go();
  } catch (error_) {
    describe(error_, false);
  } finally {
    busy.value = false;
  }
}

/**
 * Fallback: proves the key against `overview` rather than assuming it works.
 *
 * `healthz` would be the obvious probe but it needs no auth, so it would happily
 * accept a wrong key.
 */
async function submitKey(): Promise<void> {
  error.value = '';
  hint.value = '';
  const value = apiKey.value.trim();
  if (value === '') {
    error.value = '请输入 API Key。';
    return;
  }
  busy.value = true;
  auth.signInWithKey(value);
  try {
    await api.overview();
    auth.refresh();
    go();
  } catch (error_) {
    api.clearCredential();
    describe(error_, true);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 0.9em;
}
</style>
