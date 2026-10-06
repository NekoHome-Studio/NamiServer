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
              title="上次的凭证被拒绝"
            >
              <div class="text-body-2">{{ auth.error.value }}</div>
            </v-alert>

            <v-form @submit.prevent="submit">
              <v-text-field
                v-model="credential"
                label="API Key 或 Admin Token"
                placeholder="nami_…"
                :type="reveal ? 'text' : 'password'"
                :append-inner-icon="reveal ? 'mdiEyeOff' : 'mdiEye'"
                autocomplete="off"
                spellcheck="false"
                autofocus
                @click:append-inner="reveal = !reveal"
              />

              <v-alert
                v-if="probeError"
                type="error"
                variant="tonal"
                density="comfortable"
                class="mb-4"
              >
                <div class="text-body-2">{{ probeError }}</div>
                <div class="text-caption mt-1">{{ probeHint }}</div>
              </v-alert>

              <v-alert
                v-else-if="probeOk"
                type="success"
                variant="tonal"
                density="comfortable"
                class="mb-4"
              >
                <div class="text-body-2">
                  连接成功：{{ probeOk.version }} · {{ probeOk.provider }} / {{ probeOk.model }}
                </div>
              </v-alert>

              <v-btn
                type="submit"
                color="primary"
                block
                size="large"
                :loading="probing"
                prepend-icon="mdiLoginVariant"
              >
                登录
              </v-btn>
            </v-form>

            <v-divider class="my-6" />

            <div class="text-caption text-medium-emphasis">
              <p class="mb-2">填 <code class="nami-mono">NAMI_API_KEYS</code> 中的任意一个，或 <code class="nami-mono">NAMI_ADMIN_TOKEN</code>。</p>
              <p class="mb-0">
                若未设置 <code class="nami-mono">NAMI_API_KEYS</code>，服务器会在启动时随机生成一个并打印在日志里；
                也可以在这个界面左侧「日志」页找不到——那需要先登录。此时请查看 Nami 进程的控制台输出。
              </p>
            </div>
          </v-card-text>
        </v-card>

        <p class="text-caption text-medium-emphasis text-center mt-4">
          凭证保存在本机 localStorage，不会离开浏览器。
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

const credential = ref(api.credential.value);
const reveal = ref(false);
const probing = ref(false);
const probeError = ref('');
const probeHint = ref('');
const probeOk = ref<{ version: string; provider: string; model: string } | null>(null);

/**
 * Signs in by *proving* the credential works rather than assuming it.
 *
 * The probe is `overview` and not `healthz`, because healthz needs no auth and
 * would happily accept a wrong key.
 */
async function submit(): Promise<void> {
  probeError.value = '';
  probeHint.value = '';
  probeOk.value = null;

  const value = credential.value.trim();
  if (value === '') {
    probeError.value = '请输入凭证。';
    return;
  }

  probing.value = true;
  auth.signIn(value);
  try {
    const overview = await api.overview();
    probeOk.value = {
      version: overview.version,
      provider: overview.provider,
      model: overview.model,
    };
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    window.setTimeout(() => void router.replace(redirect), 350);
  } catch (error) {
    api.clearCredential();
    probeError.value = error instanceof ApiError ? error.message : String(error);
    probeHint.value =
      error instanceof ApiError && error.status === 403
        ? '凭证有效但没有管理权限：服务器配置了 NAMI_ADMIN_TOKEN，请填该令牌。'
        : error instanceof ApiError && error.status === 401
          ? '凭证不匹配 NAMI_API_KEYS，也没有命中 NAMI_ADMIN_TOKEN。'
          : '请确认 Nami 正在运行，且地址与端口正确。';
  } finally {
    probing.value = false;
  }
}
</script>

<style scoped>
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
  font-size: 0.9em;
}
</style>
