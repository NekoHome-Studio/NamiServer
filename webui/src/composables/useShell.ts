/**
 * Shell-wide state: the credential, the toast queue, and the theme.
 *
 * A single module-level store rather than a state library — the app has exactly
 * one piece of global state (auth) and one transient channel (toasts), and
 * pulling in Pinia for that would be more machinery than the problem deserves.
 */

import { computed, ref, readonly } from 'vue';
import { ApiError, api } from '@/api/client';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info' | 'warning';
  message: string;
  detail?: string;
}

const toasts = ref<Toast[]>([]);
let toastSeq = 0;

function pushToast(kind: Toast['kind'], message: string, detail?: string): number {
  const id = ++toastSeq;
  const toast: Toast = { id, kind, message };
  if (detail !== undefined && detail !== '') toast.detail = detail;
  toasts.value = [...toasts.value, toast];
  // Errors stay a little longer: they usually carry something to act on.
  const ttl = kind === 'error' ? 8000 : 4500;
  window.setTimeout(() => dismissToast(id), ttl);
  return id;
}

function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

/* ------------------------------------------------------------------ *
 * Authentication
 * ------------------------------------------------------------------ */

/** Set when the server rejected the stored credential, so login can explain why. */
const authError = ref<string>('');

export const auth = {
  credential: api.credential,
  authenticated: computed(() => api.authenticated),
  error: readonly(authError),

  signIn(credential: string): void {
    authError.value = '';
    api.setCredential(credential);
  },

  signOut(reason?: string): void {
    api.clearCredential();
    authError.value = reason ?? '';
  },

  /** Records a rejected credential and clears it, so the guard sends us to login. */
  reject(reason: string): void {
    authError.value = reason;
    api.clearCredential();
  },
};

/**
 * Turns any thrown value into an operator-readable message.
 *
 * Auth failures additionally drop the stored credential, so the next navigation
 * lands on the login page instead of retrying a credential the server has
 * already refused.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.isAuthProblem) {
      auth.reject(
        error.status === 403
          ? '凭证有效，但没有管理权限。若服务器配置了 NAMI_ADMIN_TOKEN，请填该令牌。'
          : '凭证被拒绝。请检查 NAMI_API_KEYS 或 NAMI_ADMIN_TOKEN。',
      );
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function toastError(error: unknown, context?: string): void {
  const message = describeError(error);
  pushToast('error', context ? `${context}：${message}` : message);
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

export const shell = {
  toasts: readonly(toasts),
  notify: pushToast,
  success: (message: string, detail?: string) => pushToast('success', message, detail),
  info: (message: string, detail?: string) => pushToast('info', message, detail),
  error: (message: string, detail?: string) => pushToast('error', message, detail),
  warning: (message: string, detail?: string) => pushToast('warning', message, detail),
  dismiss: dismissToast,
};

/* ------------------------------------------------------------------ *
 * Formatting helpers shared by every view
 * ------------------------------------------------------------------ */

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatNumber(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN');
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Compact uptime, e.g. `3d 4h 12m`. */
export function formatUptime(seconds: number | undefined | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${total % 60}s`;
  return `${total}s`;
}

export function formatTime(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function formatClock(iso: string | undefined | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

/** Relative time, e.g. `3 分钟前`. */
export function formatRelative(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
  const delta = Date.now() - ms;
  if (delta < 0) return '刚刚';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatTime(ms);
}

/** Pretty-prints a JSON value, tolerating already-stringified input. */
export function prettyJson(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}
