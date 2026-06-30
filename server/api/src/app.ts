import Fastify from 'fastify';
import { config } from './config';
import { healthCheckRoutes } from './routes/health';
import { urlRoutes } from './routes/url';
import { authRoutes } from './routes/auth';
import { analyticsRoutes } from './routes/analytics';
import PrismaPlugin from './db/index';
import CachePlugin from './plugins/cache';
import SecurityPlugin from './plugins/security';
import SwaggerPlugin from './plugins/swagger';
import { Prisma } from './generated/prisma/client';
import { AppError, RateLimitError } from './utils/errors';
import { errorResponse, rateLimitResponse } from './utils/api-response';
import {
  getFastifyLoggerConfig,
  genReqId,
  REQUEST_ID_HEADER,
  REQUEST_ID_LOG_LABEL,
} from '@url-shortener/shared';

export async function createApp() {
  const app = Fastify({
    logger: getFastifyLoggerConfig(config.NODE_ENV),
    // Request-ID correlation: adopt an upstream `x-request-id` if present,
    // otherwise mint a UUID. `requestIdLogLabel` makes every per-request log
    // line carry it as `requestId` (matching the structured-logging plan).
    genReqId,
    requestIdHeader: REQUEST_ID_HEADER,
    requestIdLogLabel: REQUEST_ID_LOG_LABEL,
  });

  // Echo the request id back so clients (and downstream services) can quote it
  // when reporting an issue. Set on every response, including error envelopes.
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('X-Request-ID', request.id);
    done();
  });

  // ── Plugins ────────────────────────────────────────────────────────────────
  // Security first so helmet headers + CORS attach to every response, including
  // the 4xx/5xx envelopes produced by the global error handler below.
  await app.register(SecurityPlugin);
  await app.register(PrismaPlugin);
  await app.register(CachePlugin);

  // Swagger must register before the routes it documents (it hooks `onRoute`) and
  // it neutralizes Fastify's validator/serializer so attaching route `schema`s for
  // docs leaves Zod-in-handler validation and the response envelopes untouched.
  await app.register(SwaggerPlugin);

  // ── Global error handler ───────────────────────────────────────────────────
  // Single place that maps every thrown error to the ERROR_CONTRACT envelope:
  //   { error: string, details?: object, retryAfter?: number }
  // Route handlers must contain zero try-catch for business/DB logic.
  app.setErrorHandler((error, request, reply) => {
    // Layer 4 — custom AppError subclasses (service layer + middleware throw these)
    if (error instanceof AppError) {
      // Every 401 carries the auth challenge header (ERROR_CONTRACT.md §401).
      if (error.status === 401) {
        reply.header('WWW-Authenticate', 'Bearer realm="url-shortener"');
      }
      if (error instanceof RateLimitError) {
        reply.header('Retry-After', String(error.retryAfter));
        return reply.status(error.status).send(rateLimitResponse(error.retryAfter));
      }
      return reply.status(error.status).send(errorResponse(error.message, error.context));
    }

    // Layer 5 — Prisma known request errors
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const code = error.code;

      if (code === 'P1001' || code === 'P1017') {
        reply.header('Retry-After', '30');
        return reply.status(503).send(errorResponse('Service temporarily unavailable'));
      }
      if (code === 'P1008') {
        reply.header('Retry-After', '5');
        return reply.status(504).send(errorResponse('Request timed out'));
      }
      if (code === 'P2002') {
        return reply.status(409).send(errorResponse('Resource already exists'));
      }
      if (['P2003', 'P2004', 'P2005', 'P2006', 'P2011', 'P2014'].includes(code)) {
        return reply.status(400).send(errorResponse('Invalid request data'));
      }
      if (code === 'P2015' || code === 'P2025') {
        return reply.status(404).send(errorResponse('Not found'));
      }
      if (code === 'P2034') {
        reply.header('Retry-After', '1');
        return reply.status(409).send(errorResponse('Write conflict, please retry'));
      }

      request.log.error({ err: error }, 'Unhandled Prisma error');
      return reply.status(500).send(errorResponse('Internal server error'));
    }

    // Fastify validation errors (JSON Schema / request parsing failures)
    const isErrorObj = error instanceof Error;
    const asRecord = error as Record<string, unknown>;
    if (isErrorObj && Array.isArray(asRecord['validation'])) {
      return reply.status(400).send(errorResponse(error.message));
    }

    // FastifyError with a non-5xx statusCode (404 route not found, 415 unsupported media, etc.)
    const statusCode =
      isErrorObj &&
      'statusCode' in error &&
      typeof asRecord['statusCode'] === 'number'
        ? (asRecord['statusCode'] as number)
        : 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled server error');
      return reply.status(500).send(errorResponse('Internal server error'));
    }

    if (statusCode === 401) {
      reply.header('WWW-Authenticate', 'Bearer realm="url-shortener"');
    }
    const message = isErrorObj ? error.message : 'Internal server error';
    return reply.status(statusCode).send(errorResponse(message));
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  app.register(healthCheckRoutes, { prefix: '/health' });
  app.register(urlRoutes, { prefix: '/api' });
  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(analyticsRoutes, { prefix: '/api/analytics' });

  return app;
}
