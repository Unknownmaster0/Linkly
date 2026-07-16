import type { FastifyInstance, FastifyRequest } from 'fastify';
import { successResponse } from '../utils/api-response.js';
import { config } from '../config.js';
import { createUrlService } from '../services/url.service.js';
import {
  shortenBodySchema,
  type ShortenBodyInput,
} from '../schemas/url.schema.js';
import { authenticate } from '../middleware/auth.js';
import { makeRateLimiter } from '../middleware/rateLimit.js';
import { ValidationError } from '../utils/errors.js';
import {
  zodToJsonSchema,
  successEnvelope,
  errorEnvelope,
  noContentResponse,
} from '../utils/openapi.js';

// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI schema (docs only — see plugins/swagger.ts; Zod stays the validator)
// ─────────────────────────────────────────────────────────────────────────────

const shortenResultSchema = {
  type: 'object',
  properties: {
    shortCode: { type: 'string', example: 'gY1k' },
    shortUrl: { type: 'string', example: 'https://short.url/gY1k' },
    originalUrl: { type: 'string', example: 'https://example.com/very/long/url' },
    customAlias: { type: 'string', nullable: true, example: 'my-project' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

const shortenSchema = {
  tags: ['URLs'],
  summary: 'Create a short URL',
  description:
    'Creates a short URL for the authenticated user.\n\n' +
    'Validation enforced by the handler (not shown in the request schema): the ' +
    '`url` must use http/https and must not resolve to a private/loopback address ' +
    '(SSRF guard); `customAlias` must not be a reserved word ' +
    '(`api`, `health`, `docs`, `admin`, `static`).\n\n' +
    'Rate limited per user (see `X-RateLimit-*` response headers).',
  security: [{ bearerAuth: [] }],
  body: zodToJsonSchema(shortenBodySchema),
  response: {
    201: successEnvelope(shortenResultSchema, 'URL shortened successfully'),
    400: errorEnvelope('Validation failed', { error: 'Invalid URL format', details: { field: 'url' } }),
    401: errorEnvelope('Not authenticated', { error: 'Unauthorized' }),
    409: errorEnvelope('Custom alias already in use', { error: 'Custom alias already in use', details: { field: 'customAlias' } }),
    429: errorEnvelope('Rate limit exceeded', { error: 'Rate limit exceeded', retryAfter: 3600 }),
    500: errorEnvelope('Server error', { error: 'Internal server error' }),
  },
};

// Data-payload schemas (docs only). The item mirrors UrlListItem in url.schema.ts.
const urlListItemSchema = {
  type: 'object',
  properties: {
    shortCode: { type: 'string', example: 'gY1k' },
    shortUrl: { type: 'string', example: 'https://short.url/gY1k' },
    originalUrl: { type: 'string', example: 'https://example.com/very/long/url' },
    customAlias: { type: 'string', nullable: true, example: 'my-project' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    clickCount: { type: 'integer', example: 42 },
    isDeleted: { type: 'boolean', example: false },
  },
} as const;

const urlListResultSchema = {
  type: 'object',
  properties: {
    urls: { type: 'array', items: urlListItemSchema },
    total: { type: 'integer', example: 2 },
  },
} as const;

const listUrlsSchema = {
  tags: ['URLs'],
  summary: 'List URLs created by the authenticated user',
  security: [{ bearerAuth: [] }],
  response: {
    200: successEnvelope(urlListResultSchema, 'URLs retrieved'),
    401: errorEnvelope('Not authenticated', { error: 'Unauthorized' }),
  },
};

const deleteUrlSchema = {
  tags: ['URLs'],
  summary: 'Soft-delete a short URL',
  description:
    'Soft-deletes a short URL the caller owns (`is_deleted = true`; analytics are ' +
    'preserved). The `:shortCode` path param may be the short code or a custom alias. ' +
    'A code that does not exist OR belongs to another user returns the same 404 — the ' +
    'response never reveals whether the resource exists (IDOR prevention).',
  security: [{ bearerAuth: [] }],
  params: {
    type: 'object',
    properties: { shortCode: { type: 'string', example: 'gY1k' } },
    required: ['shortCode'],
  },
  response: {
    204: noContentResponse,
    401: errorEnvelope('Not authenticated', { error: 'Unauthorized' }),
    404: errorEnvelope('Not found', { error: 'Not found' }),
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// Per-user limit: 100 creates / hour per API_CONTRACT.md (runs after authenticate
// sets request.userId).
const shortenRateLimit = makeRateLimiter({
  key: (request: FastifyRequest) => `rl:create:${request.userId}`,
  limit: config.RATE_LIMIT_CREATE_LIMIT,
  windowSecs: config.RATE_LIMIT_WINDOW_SECS,
});

export async function urlRoutes(app: FastifyInstance): Promise<void> {
  const urlService = createUrlService(app.prisma);

  // POST /api/urls — create a new short URL
  app.post<{ Body: ShortenBodyInput }>(
    '/urls',
    { preHandler: [authenticate, shortenRateLimit], schema: shortenSchema },
    async (request, reply) => {

      // Validate request body (Layer 1). Everything past this point is delegated
      // to the service, which throws typed errors handled by the global handler —
      // this route stays thin with zero try-catch for business/DB logic.
      const parsed = shortenBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ValidationError(issue?.message ?? 'Validation failed', { field: issue?.path[0] });
      }

      const result = await urlService.createShortUrl(parsed.data, request.userId);
      return reply.status(201).send(successResponse('URL shortened successfully', result));
    }
  );

  // GET /api/urls — list the authenticated user's URLs (no rate limit; the
  // service scopes the query by request.userId, so a caller only ever sees
  // their own rows — no ownership check beyond authenticate is possible to fail).
  app.get(
    '/urls',
    { preHandler: [authenticate], schema: listUrlsSchema },
    async (request, reply) => {
      const result = await urlService.listUrls(request.userId);
      return reply.status(200).send(successResponse('URLs retrieved', result));
    }
  );

  // DELETE /api/urls/:shortCode — soft-delete a URL the caller owns (no rate
  // limit). The service scopes by request.userId and throws OwnershipError (404)
  // when nothing matches, so ownership mismatch is indistinguishable from a
  // missing code. Cache eviction lives here, not in the service: the service
  // takes only prisma; Valkey is infrastructure at the handler's layer. Both
  // cache ops swallow their own errors, so a Valkey hiccup can't fail the delete.
  app.delete<{ Params: { shortCode: string } }>(
    '/urls/:shortCode',
    { preHandler: [authenticate], schema: deleteUrlSchema },
    async (request, reply) => {
      const { shortCode } = request.params;
      const record = await urlService.deleteUrl(shortCode, request.userId);

      await app.cache.del(record.shortCode);
      await app.cache.setDeleted(record.shortCode);

      return reply.status(204).send();
    }
  );
}
