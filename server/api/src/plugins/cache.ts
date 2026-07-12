import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { rateLimitCheck as checkRateLimit } from '@url-shortener/shared';
import type { RateLimitResult } from '@url-shortener/shared';
import { config } from '../config.js';

export type ApiCacheClient = {
  /** Evict the cached redirect entry for a short code (call on URL update / soft-delete). */
  del(shortCode: string): Promise<void>;
  /**
   * Write a short-lived negative-cache marker (`DELETED:<code>`, 30s TTL) so the
   * redirect server can answer 410 for a just-deleted code without a DB round-trip.
   */
  setDeleted(shortCode: string): Promise<void>;
  /**
   * Fixed-window rate-limit check backed by Valkey.
   * Fail-open: returns { allowed: true } when Valkey is unreachable.
   */
  rateLimitCheck(key: string, limit: number, windowSecs: number): Promise<RateLimitResult>;
};

declare module 'fastify' {
  interface FastifyInstance {
    cache: ApiCacheClient;
  }
}

const URL_KEY_PREFIX = 'url:';
// Negative-cache marker the redirect server reads to answer 410 without a DB hit.
// Key shape + TTL are fixed by API_CONTRACT.md (DELETE side effects: `DELETED:<code>`, 30s).
const DELETED_KEY_PREFIX = 'DELETED:';
const DELETED_NEGATIVE_CACHE_TTL_SECONDS = 30;

async function cachePlugin(app: FastifyInstance): Promise<void> {
  // enableOfflineQueue: false → operations fail immediately on disconnect (fail-open pattern).
  const client = new Redis(config.VALKEY_URL, {
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
  });

  client.on('error', (err: unknown) => {
    app.log.warn({ err }, 'Valkey error');
  });

  app.decorate('cache', {
    async del(shortCode: string): Promise<void> {
      try {
        await client.del(`${URL_KEY_PREFIX}${shortCode}`);
      } catch (err) {
        app.log.warn({ err }, 'Cache del failed');
      }
    },

    async setDeleted(shortCode: string): Promise<void> {
      try {
        await client.set(
          `${DELETED_KEY_PREFIX}${shortCode}`,
          '1',
          'EX',
          DELETED_NEGATIVE_CACHE_TTL_SECONDS
        );
      } catch (err) {
        app.log.warn({ err }, 'Cache setDeleted failed');
      }
    },

    async rateLimitCheck(key: string, limit: number, windowSecs: number): Promise<RateLimitResult> {
      try {
        return await checkRateLimit(client, key, limit, windowSecs);
      } catch (err) {
        // Fail open: Valkey unavailable → allow request rather than blocking the service.
        app.log.warn({ err }, 'Rate limit check failed — failing open');
        return { allowed: true, retryAfter: 0, count: 0 };
      }
    },
  });

  app.addHook('onClose', async () => {
    await client.quit().catch((err: unknown) => {
      app.log.warn({ err }, 'Valkey quit error');
    });
    app.log.info('Valkey cache disconnected');
  });

  app.log.info('Valkey cache connected');
}

export default fp(cachePlugin, { name: 'cache' });
