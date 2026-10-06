<template>
  <!--
    一行配置 = 左侧「这是谁 + 干什么用」+ 右侧「控件」。
    类型驱动的控件选择放在这里，ConfigView 只负责分组、脏状态与保存。
  -->
  <div class="nami-field py-3">
    <v-row dense align="start">
      <v-col cols="12" md="5">
        <div class="d-flex align-center flex-wrap ga-2">
          <code class="nami-mono font-weight-bold">{{ field.key }}</code>
          <v-chip v-if="field.secret" size="x-small" variant="tonal" color="warning" label>
            密钥
          </v-chip>
          <v-chip v-if="dirty" size="x-small" variant="tonal" color="primary" label>
            已修改
          </v-chip>
        </div>
        <div class="text-caption text-medium-emphasis mt-1">{{ field.description }}</div>
        <div v-if="field.secret" class="text-caption mt-1">
          当前状态：
          <span :class="field.configured ? 'text-success' : 'text-warning'">
            {{ field.configured ? '已配置' : '未配置' }}
          </span>
          <br />
          真实值永远不会下发到浏览器；<strong>留空表示不修改</strong>，只有真的输入了内容才会写进 .env。
        </div>
      </v-col>

      <v-col cols="12" md="7">
        <!-- 密钥：一律用密码框，服务器只告诉我们「配没配」。 -->
        <v-text-field
          v-if="field.secret"
          :model-value="textValue"
          label="新值"
          placeholder="留空表示不修改"
          :type="reveal ? 'text' : 'password'"
          :append-inner-icon="reveal ? 'mdiEyeOff' : 'mdiEye'"
          autocomplete="off"
          spellcheck="false"
          :error-messages="error"
          @click:append-inner="reveal = !reveal"
          @update:model-value="setText"
        />

        <v-switch
          v-else-if="field.type === 'bool'"
          :model-value="boolValue"
          :label="boolValue ? '开启' : '关闭'"
          color="primary"
          inset
          :error-messages="error"
          @update:model-value="setBool"
        />

        <v-select
          v-else-if="field.type === 'enum'"
          :model-value="textValue"
          :items="field.options ?? []"
          label="取值"
          :error-messages="error"
          @update:model-value="setText"
        />

        <v-text-field
          v-else-if="field.type === 'int' || field.type === 'float'"
          :model-value="textValue"
          :label="field.type === 'int' ? '整数' : '数字'"
          type="number"
          :step="field.type === 'int' ? 1 : 'any'"
          :error-messages="error"
          @update:model-value="setText"
        />

        <v-combobox
          v-else-if="field.type === 'list'"
          :model-value="listValue"
          label="列表（输入后回车添加，可留空表示不限）"
          multiple
          chips
          closable-chips
          hide-no-data
          :items="[]"
          :error-messages="error"
          @update:model-value="setList"
        />

        <v-textarea
          v-else-if="field.key === 'NAMI_SYSTEM_PROMPT' || field.key === 'NAMI_ONEBOT_SYSTEM_PROMPT'"
          :model-value="textValue"
          label="内容"
          rows="6"
          auto-grow
          :error-messages="error"
          @update:model-value="setText"
        />

        <v-text-field
          v-else
          :model-value="textValue"
          label="值"
          :error-messages="error"
          @update:model-value="setText"
        />
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ConfigField } from '@/api/client';

/**
 * 服务器额外下发的字段（client.ts 的 ConfigField 还没有声明）：
 *   configured —— 仅密钥字段，表示当前是否已有一个值。
 * 这里就地扩展，避免为了一个字段去改共享的 API 类型。
 */
type ConfigFieldMeta = ConfigField & { configured?: boolean };

const props = defineProps<{
  field: ConfigFieldMeta;
  /** 当前草稿值：密钥为字符串，bool 为布尔，list 为字符串数组。 */
  modelValue: unknown;
  error?: string;
  dirty?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [unknown] }>();

const reveal = ref(false);

/* 读值一律做成只读 computed；写值走显式 handler。
   这样 v-model 的联合类型不会和 Vuetify 各组件的 prop 类型打架。 */

const textValue = computed<string>(() => {
  const value = props.modelValue;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(',');
  return String(value);
});

const boolValue = computed<boolean>(() => props.modelValue === true);

const listValue = computed<string[]>(() =>
  Array.isArray(props.modelValue) ? props.modelValue.map((item) => String(item)) : [],
);

/**
 * v-text-field / v-select 在清空时会给出 null，number 输入可能给出数字。
 * 统一收敛成字符串，脏状态比较才不会把 8787 和 "8787" 当成两次改动。
 */
function setText(value: unknown): void {
  emit('update:modelValue', value === null || value === undefined ? '' : String(value));
}

function setBool(value: unknown): void {
  emit('update:modelValue', value === true);
}

function setList(value: unknown): void {
  emit('update:modelValue', Array.isArray(value) ? value.map((item) => String(item)) : []);
}
</script>

<style scoped>
.nami-mono {
  font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
}

.nami-field + .nami-field {
  border-top: 1px solid rgb(var(--v-theme-border-color, 35 42 54));
}
</style>
