export type RateLimitResult = { allowed: boolean; retryAfter: number; count: number };

/**
 * Minimal Redis interface required for rate limiting.
 * Satisfied by ioredis.Redis without importing ioredis in this package.
 */
export interface RateLimitClient {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
}

/**
 * Fixed-window counter rate limiter using Valkey INCR + EXPIRE.
 *
 * How it works:
 *   1. INCR key  — atomic; creates at 1 on first call within the window.
 *   2. count === 1 → EXPIRE key, so the window resets automatically.
 *   3. count > limit → return { allowed: false, retryAfter: TTL }.
 *
 * Callers MUST wrap this in try/catch and fail-open on Redis errors
 * (allow the request rather than taking down the service).
 */
export async function rateLimitCheck(
  client: RateLimitClient,
  key: string,
  limit: number,
  windowSecs: number,
): Promise<RateLimitResult> {
  const count = await client.incr(key);

  // Set window expiry only on first increment to avoid resetting the window.
  if (count === 1) {
    await client.expire(key, windowSecs);
  }

  if (count > limit) {
    const ttl = await client.ttl(key);
    return { allowed: false, retryAfter: ttl > 0 ? ttl : windowSecs, count };
  }

  return { allowed: true, retryAfter: 0, count };
}
