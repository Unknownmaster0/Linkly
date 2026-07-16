import type { FastifyInstance } from 'fastify';
import { successResponse } from '../utils/api-response.js';
import { createAnalyticsService } from '../services/analytics.service.js';
import { eventsQuerySchema, type EventsQueryInput } from '../schemas/analytics.schema.js';
import { authenticate } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';
import {
  zodToJsonSchema,
  successEnvelope,
  errorEnvelope,
} from '../utils/openapi.js';

// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI schemas (docs only — see plugins/swagger.ts; Zod stays the validator)
// ─────────────────────────────────────────────────────────────────────────────

const shortCodeParam = {
  type: 'object',
  properties: { shortCode: { type: 'string', description: 'Short code or custom alias' } },
  required: ['shortCode'],
} as const;

const summaryData = {
  type: 'object',
  properties: {
    shortCode: { type: 'string' },
    originalUrl: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    expiresAt: { type: 'string', format: 'date-time', nullable: true },
    totalClicks: { type: 'integer' },
    last7Days: { type: 'integer' },
    last30Days: { type: 'integer' },
    dailyBreakdown: {
      type: 'array',
      items: {
        type: 'object',
        properties: { date: { type: 'string', example: '2026-04-18' }, clicks: { type: 'integer' } },
      },
    },
    topReferrers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { referrer: { type: 'string', example: 'direct' }, clicks: { type: 'integer' } },
      },
    },
    countries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          countryCode: { type: 'string', example: 'US' },
          countryName: { type: 'string', example: 'United States' },
          clicks: { type: 'integer' },
        },
      },
    },
  },
} as const;

const eventsData = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          clickedAt: { type: 'string', format: 'date-time' },
          countryCode: { type: 'string', nullable: true },
          deviceType: { type: 'string' },
          browser: { type: 'string', nullable: true },
          os: { type: 'string', nullable: true },
          referrerDomain: { type: 'string', nullable: true },
        },
      },
    },
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  },
} as const;

const notFoundError = errorEnvelope('Not found, or not owned by the caller (404 for both — IDOR protection)', { error: 'Not found' });
const unauthorizedError = errorEnvelope('Not authenticated', { error: 'Unauthorized' });

const summarySchema = {
  tags: ['Analytics'],
  summary: 'Get click-analytics summary',
  description: 'Aggregated click analytics for a short URL. Owner only — a non-owner gets 404, not 403.',
  security: [{ bearerAuth: [] }],
  params: shortCodeParam,
  response: {
    200: successEnvelope(summaryData, 'Analytics retrieved'),
    401: unauthorizedError,
    404: notFoundError,
  },
};

const eventsSchema = {
  tags: ['Analytics'],
  summary: 'List raw click events (paginated)',
  description: 'Paginated raw click events for a short URL. Owner only — a non-owner gets 404, not 403.',
  security: [{ bearerAuth: [] }],
  params: shortCodeParam,
  querystring: zodToJsonSchema(eventsQuerySchema),
  response: {
    200: successEnvelope(eventsData, 'Events retrieved'),
    401: unauthorizedError,
    404: notFoundError,
  },
};

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const service = createAnalyticsService(app.prisma);

  // GET /api/analytics/:shortCode — click analytics summary (owner only)
  app.get<{ Params: { shortCode: string } }>(
    '/:shortCode',
    { preHandler: [authenticate], schema: summarySchema },
    async (request, reply) => {
      const summary = await service.getSummary(request.params.shortCode, request.userId);
      return reply.status(200).send(successResponse('Analytics retrieved', summary));
    }
  );

  // GET /api/analytics/:shortCode/events — paginated raw click events (owner only)
  app.get<{ Params: { shortCode: string }; Querystring: EventsQueryInput }>(
    '/:shortCode/events',
    { preHandler: [authenticate], schema: eventsSchema },
    async (request, reply) => {
      const parsed = eventsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ValidationError(issue?.message ?? 'Validation failed', { field: issue?.path[0] });
      }
      const { limit, offset } = parsed.data;
      const result = await service.getEvents(
        request.params.shortCode,
        request.userId,
        limit,
        offset
      );
      return reply.status(200).send(successResponse('Events retrieved', result));
    }
  );
}
