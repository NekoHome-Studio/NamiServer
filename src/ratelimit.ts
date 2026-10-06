/**
 * In-memory token-bucket rate limiting, keyed by API key (or client address
 * when auth is off).
 *
 * Buckets are created lazily and reaped once they have been idle long enough
 * to be fully refilled, so the map cannot grow without bound.
 */

import type { RateLimitConfig } from './config.ts';

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds the caller should wait before retrying. */
  retryAfterSeconds: number;
  /** Whole tokens left in the bucket after this call. */
  remaining: number;
  limit: number;
}

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;

  private tokens: number;
  private lastRefill: number;

  constructor(capacity: number, refillPerSecond: number, now = Date.now()) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.lastRefill = now;
  }

  private refill(now: number): void {
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Attempts to spend `cost` tokens. */
  tryConsume(cost = 1, now = Date.now()): RateLimitDecision {
    this.refill(now);
    const limit = this.capacity;

    if (this.tokens >= cost) {
      this.tokens -= cost;
      return {
        allowed: true,
        retryAfterSeconds: 0,
        remaining: Math.floor(this.tokens),
        limit,
      };
    }

    const deficit = cost - this.tokens;
    const waitSeconds = this.refillPerSecond > 0 ? deficit / this.refillPerSecond : 60;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(waitSeconds)),
      remaining: Math.floor(this.tokens),
      limit,
    };
  }

  /** True once the bucket has been idle long enough to be worth dropping. */
  isStale(now: number, idleMs: number): boolean {
    this.refill(now);
    return now - this.lastRefill >= idleMs && this.tokens >= this.capacity;
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  get capacity(): number {
    return this.config.capacity;
  }

  check(key: string, now = Date.now()): RateLimitDecision {
    if (!this.config.enabled) {
      return { allowed: true, retryAfterSeconds: 0, remaining: this.config.capacity, limit: this.config.capacity };
    }
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.config.capacity, this.config.refillPerSecond, now);
      this.buckets.set(key, bucket);
    }
    return bucket.tryConsume(1, now);
  }

  /** Number of tracked callers; exposed for the admin panel. */
  get size(): number {
    return this.buckets.size;
  }

  sweep(now = Date.now(), idleMs = 10 * 60_000): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.isStale(now, idleMs)) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  describe(): { enabled: boolean; burst: number; perSecond: number; trackedKeys: number } {
    return {
      enabled: this.config.enabled,
      burst: this.config.capacity,
      perSecond: this.config.refillPerSecond,
      trackedKeys: this.buckets.size,
    };
  }
}
