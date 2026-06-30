import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createUrlRepository } from '../repositories/url.repository';
import { NotFoundError, GoneError, LegalError } from '../utils/errors';
import type { CachedUrl } from '../plugins/cache';
import { makeRateLimiter } from '../middleware/rateLimit';
import { config } from '../config';
import type { ClickJob } from '@url-shortener/shared';
import { errorEnvelope } from '../utils/openapi';

// OpenAPI schema (docs only — see plugins/swagger.ts). A 302 carries no JSON body,
// so the success case is documented via the `302` response description + Location
// header; the error envelopes cover 404 / 410 / 429.
const redirectSchema = {
  tags: ['Redirect'],
  summary: 'Resolve a short code and redirect',
  description:
    'Looks up the short code (Valkey cache → PostgreSQL) and issues a 302 to the ' +
    'original URL with `Cache-Control: no-cache`. A click event is enqueued ' +
    'fire-and-forget. Never rate-limited away for normal use.',
  params: {
    type: 'object',
    properties: { shortCode: { type: 'string', description: 'Short code or custom alias' } },
    required: ['shortCode'],
  },
  response: {
    302: {
      description: 'Found — redirect to the original URL',
      type: 'null',
      headers: {
        Location: { schema: { type: 'string' }, description: 'The original URL' },
        'Cache-Control': { schema: { type: 'string', example: 'no-cache' } },
      },
    },
    404: errorEnvelope('Short code not found', { error: 'Not found' }),
    410: errorEnvelope('URL expired or deleted', { error: 'Short URL expired or deleted' }),
    429: errorEnvelope('Rate limit exceeded', { error: 'Rate limit exceeded', retryAfter: 60 }),
  },
};

const MAX_CACHE_TTL_SECS = 86_400; // 24 hours

// Per-IP limit: 100 redirects / 60 s — guards against bot enumeration.
const redirectRateLimit = makeRateLimiter({
  key: (request) => `rl:redirect:${request.ip}`,
  limit: config.RATE_LIMIT_REDIRECT_LIMIT,
  windowSecs: config.RATE_LIMIT_WINDOW_SECS,
});

/** Returns TTL to use when writing to Valkey: min(URL remaining lifetime, 24 h). */
function cacheTtl(expiresAt: Date | null): number {
  if (expiresAt === null) return MAX_CACHE_TTL_SECS;
  const remainingSecs = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  return Math.min(remainingSecs, MAX_CACHE_TTL_SECS);
}

/** Build the fire-and-forget click payload from the request. Raw IP is carried
 *  for geo lookup in the worker; the worker stores only a hash of it. */
function buildClickJob(request: FastifyRequest, shortCode: string): ClickJob {
  const userAgent = request.headers['user-agent'];
  const referrer = request.headers['referer'];
  return {
    shortCode,
    ip: request.ip,
    ...(userAgent !== undefined ? { userAgent } : {}),
    ...(referrer !== undefined ? { referrer } : {}),
    ts: Date.now(),
  };
}

export async function redirectRoutes(app: FastifyInstance): Promise<void> {
  const repo = createUrlRepository(app.prisma);

  app.get<{ Params: { shortCode: string } }>(
    '/:shortCode',
    { preHandler: redirectRateLimit, schema: redirectSchema },
    async (request, reply) => {
    const { shortCode } = request.params;

    // ── L2: Valkey cache lookup ───────────────────────────────────────────────
    const cached = await app.cache.get(shortCode);
    if (cached !== null) {
      if (cached.isDeleted || !cached.isActive) throw new GoneError();
      if (cached.isFlagged) throw new LegalError();
      if (cached.expiresAt !== null && new Date(cached.expiresAt) < new Date()) {
        throw new GoneError();
      }
      request.log.debug({ shortCode }, 'Redirect served from cache');
      // Fire-and-forget: record the click without blocking the hot path.
      void app.queue.enqueueClick(buildClickJob(request, shortCode));
      return reply.header('Cache-Control', 'no-cache').redirect(cached.originalUrl, 302);
    }

    // ── L2.5: negative cache — a recently-deleted code answers 410, no DB hit ──
    // (Decision 9). The api DELETE handler writes DELETED:<code>; reading it here
    // is what makes that write count. Runs only on a positive-cache miss, so the
    // common (cached-redirect) hot path is untouched.
    if (await app.cache.getDeleted(shortCode)) {
      request.log.debug({ shortCode }, 'Redirect 410 from negative cache');
      throw new GoneError();
    }

    // ── L3: PostgreSQL lookup (cache miss) ───────────────────────────────────
    const url = await repo.findByShortCode(shortCode);
    if (url === null) throw new NotFoundError();

    if (url.isDeleted || !url.isActive) {
      // Re-arm the negative cache so the next 30s of hits skip the DB (Decision 9,
      // step 8). Fire-and-forget. Only for genuine deletes — `DELETED:` means
      // deleted; an inactive-but-not-deleted URL is a distinct state, keep the DB path.
      if (url.isDeleted) void app.cache.setDeleted(shortCode);
      throw new GoneError();
    }
    if (url.isFlagged) throw new LegalError();
    if (url.expiresAt !== null && url.expiresAt < new Date()) throw new GoneError();

    // ── Populate L2 cache (fire-and-forget, TTL = min(remaining, 24 h)) ──────
    const toCache: CachedUrl = {
      originalUrl: url.originalUrl,
      isActive: url.isActive,
      isDeleted: url.isDeleted,
      isFlagged: url.isFlagged,
      expiresAt: url.expiresAt !== null ? url.expiresAt.toISOString() : null,
    };
    void app.cache.set(shortCode, toCache, cacheTtl(url.expiresAt));

    // Fire-and-forget: record the click without blocking the hot path.
    void app.queue.enqueueClick(buildClickJob(request, shortCode));

    return reply.header('Cache-Control', 'no-cache').redirect(url.originalUrl, 302);
  });
}
