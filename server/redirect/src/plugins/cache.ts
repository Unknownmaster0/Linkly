import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { rateLimitCheck as checkRateLimit } from '@url-shortener/shared';
import type { RateLimitResult } from '@url-shortener/shared';
import { config } from '../config';

// Shape of a URL record stored in Valkey.
// expiresAt serialised as ISO-8601 string (Date is not JSON-safe).
export type CachedUrl = {
  originalUrl: string;
  isActive: boolean;
  isDeleted: boolean;
  isFlagged: boolean;
  expiresAt: string | null;
};

type CacheClient = {
  get(shortCode: string): Promise<CachedUrl | null>;
  set(shortCode: string, data: CachedUrl, ttlSeconds: number): Promise<void>;
  del(shortCode: string): Promise<void>;
  /**
   * Negative-cache probe: true when `DELETED:<code>` exists (the api server writes
   * it on soft-delete). Lets the redirect short-circuit to 410 without a DB hit.
   * Fail-open: returns false when Valkey is unreachable (falls through to the DB).
   */
  getDeleted(shortCode: string): Promise<boolean>;
  /** Re-arm the `DELETED:<code>` negative-cache marker (30s TTL) — see getDeleted. */
  setDeleted(shortCode: string): Promise<void>;
  /**
   * Fixed-window rate-limit check backed by Valkey.
   * Fail-open: returns { allowed: true } when Valkey is unreachable.
   */
  rateLimitCheck(key: string, limit: number, windowSecs: number): Promise<RateLimitResult>;
};

declare module 'fastify' {
  interface FastifyInstance {
    cache: CacheClient;
  }
}

const KEY_PREFIX = 'url:';
// Negative-cache marker the api server writes on soft-delete; this server reads it
// to answer 410 without a DB hit. Key + TTL are fixed by DECISIONS.md (Decision 9)
// and API_CONTRACT.md — `DELETED:<code>`, 30s — and must match the api cache plugin.
const DELETED_KEY_PREFIX = 'DELETED:';
const DELETED_NEGATIVE_CACHE_TTL_SECONDS = 30;

async function cachePlugin(app: FastifyInstance): Promise<void> {
  // enableOfflineQueue: false → operations fail immediately when disconnected (fail-open).
  // The redirect handler catches these failures and falls through to the DB.
  const client = new Redis(config.VALKEY_URL, {
    enableOfflineQueue: false,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
  });

  client.on('error', (err: unknown) => {
    app.log.warn({ err }, 'Valkey error');
  });

  app.decorate('cache', {
    async get(shortCode: string): Promise<CachedUrl | null> {
      try {
        const raw = await client.get(`${KEY_PREFIX}${shortCode}`);
        return raw !== null ? (JSON.parse(raw) as CachedUrl) : null;
      } catch (err) {
        app.log.warn({ err }, 'Cache get failed — treating as miss');
        return null;
      }
    },

    async set(shortCode: string, data: CachedUrl, ttlSeconds: number): Promise<void> {
      try {
        await client.setex(`${KEY_PREFIX}${shortCode}`, ttlSeconds, JSON.stringify(data));
      } catch (err) {
        app.log.warn({ err }, 'Cache set failed');
      }
    },

    async del(shortCode: string): Promise<void> {
      try {
        await client.del(`${KEY_PREFIX}${shortCode}`);
      } catch (err) {
        app.log.warn({ err }, 'Cache del failed');
      }
    },

    async getDeleted(shortCode: string): Promise<boolean> {
      try {
        return (await client.exists(`${DELETED_KEY_PREFIX}${shortCode}`)) === 1;
      } catch (err) {
        // Fail-open: treat as not-deleted and fall through to the DB, which is
        // authoritative. A Valkey blip costs a DB query, never a wrong redirect.
        app.log.warn({ err }, 'Cache getDeleted failed — treating as miss');
        return false;
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
        // Fail open: Valkey unavailable → allow redirect rather than blocking the hot path.
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
