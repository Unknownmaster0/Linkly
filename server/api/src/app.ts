import Fastify from 'fastify';
import { config } from './config.js';
import { healthCheckRoutes } from './routes/health.js';
import { urlRoutes } from './routes/url.js';
import { authRoutes } from './routes/auth.js';
import { analyticsRoutes } from './routes/analytics.js';
import PrismaPlugin from './db/index.js';
import CachePlugin from './plugins/cache.js';
import SecurityPlugin from './plugins/security.js';
import SwaggerPlugin from './plugins/swagger.js';
import { Prisma } from './generated/prisma/client.js';
import { AppError, RateLimitError } from './utils/errors.js';
import { errorResponse, rateLimitResponse } from './utils/api-response.js';
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
    // Deployment topology: nginx reverse-proxies to this app on the same EC2
    // host. 'loopback' trusts only the 127.0.0.1/::1 socket peer (nginx) and
    // reads the real client IP from the X-Forwarded-For entry nginx itself
    // appended — anything an external caller injects further up the chain is
    // ignored. Must stay scoped to loopback, never `true`: that would trust
    // the whole X-Forwarded-For chain, letting a caller spoof request.ip
    // (and bypass the per-IP login/register rate limits) with a forged header.
    trustProxy: 'loopback',
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
  app.setErrorHandler((error: unknown, request, reply) => {
    // Layer 4 — custom AppError subclasses (service layer + middleware throw these)
    if (error instanceof AppError) {
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
      const code = (error as Prisma.PrismaClientKnownRequestError).code;

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

    // Only Fastify's own framework errors (415 unsupported media, malformed JSON
    // body, etc. — all carry a `FST_ERR_*` code) get their message and status
    // passed through. A `.statusCode` alone is not proof of trustworthy origin:
    // any third-party error object can bolt one on, and passing its `.message`
    // straight to the client would bypass the "unexpected error → generic
    // message" rule. Everything else — regardless of what it claims its status
    // is — falls back to a generic 500.
    const isFastifyError =
      isErrorObj && typeof asRecord['code'] === 'string' && asRecord['code'].startsWith('FST_ERR_');
    const statusCode =
      isFastifyError && typeof asRecord['statusCode'] === 'number'
        ? (asRecord['statusCode'] as number)
        : 500;

    if (!isFastifyError || statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled server error');
      return reply.status(500).send(errorResponse('Internal server error'));
    }

    if (statusCode === 401) {
      reply.header('WWW-Authenticate', 'Bearer realm="url-shortener"');
    }
    return reply.status(statusCode).send(errorResponse(error.message));
  });

  // ── Routes ─────────────────────────────────────────────────────────────────
  app.register(healthCheckRoutes, { prefix: '/health' });
  app.register(urlRoutes, { prefix: '/api' });
  app.register(authRoutes, { prefix: '/api/auth' });
  app.register(analyticsRoutes, { prefix: '/api/analytics' });

  return app;
}
