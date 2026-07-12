import type { FastifyRequest, FastifyReply } from 'fastify';
import { RateLimitError } from '../utils/errors.js';

export type RateLimitOptions = {
  /** Key builder — called per request to produce the Valkey counter key. */
  key: (request: FastifyRequest) => string;
  limit: number;
  windowSecs: number;
};

/**
 * Returns a Fastify preHandler that enforces a fixed-window rate limit.
 * Throws RateLimitError (→ 429) when the caller exceeds `limit` within `windowSecs`.
 * Errors from Valkey are swallowed inside the cache plugin (fail-open).
 */
export function makeRateLimiter(options: RateLimitOptions) {
  return async function rateLimitPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const key = options.key(request);
    const result = await request.server.cache.rateLimitCheck(
      key,
      options.limit,
      options.windowSecs,
    );
    reply.header('X-RateLimit-Limit', options.limit);
    reply.header('X-RateLimit-Remaining', Math.max(0, options.limit - result.count));
    if (!result.allowed) {
      throw new RateLimitError(result.retryAfter);
    }
  };
}
