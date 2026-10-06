/**
 * Query-string parsing helpers.
 *
 * `URLSearchParams.get` returns `null` for an absent parameter, and
 * `Number(null)` is `0` — a silent trap that clamps "no limit given" down to the
 * minimum. Every numeric query parameter goes through here instead.
 */

/** Parses a query parameter into an integer clamped to `[min, max]`. */
export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export const LIMITS = {
  sessionList: { fallback: 50, min: 1, max: 200 },
  sessionMessages: { fallback: 500, min: 1, max: 2000 },
  runs: { fallback: 20, min: 1, max: 200 },
  wsHistory: { fallback: 100, min: 1, max: 500 },
} as const;
