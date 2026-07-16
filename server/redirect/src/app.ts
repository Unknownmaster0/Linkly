import Fastify from 'fastify';
import { config } from './config.js';
import { redirectRoutes } from './routes/redirect.js';
import PrismaPlugin from './db/index.js';
import CachePlugin from './plugins/cache.js';
import QueuePlugin from './plugins/queue.js';
import SecurityPlugin from './plugins/security.js';
import SwaggerPlugin from './plugins/swagger.js';
import { Prisma } from './generated/prisma/client.js';
import { AppError, RateLimitError } from './utils/errors.js';
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
    // otherwise mint a UUID. `requestIdLogLabel` surfaces it as `requestId` on
    // every per-request log line.
    genReqId,
    requestIdHeader: REQUEST_ID_HEADER,
    requestIdLogLabel: REQUEST_ID_LOG_LABEL,
    // Deployment topology: nginx reverse-proxies to this app on the same EC2
    // host. 'loopback' trusts only the 127.0.0.1/::1 socket peer (nginx) and
    // reads the real client IP from the X-Forwarded-For entry nginx itself
    // appended — anything an external caller injects further up the chain is
    // ignored. Must stay scoped to loopback, never `true`: that would trust
    // the whole X-Forwarded-For chain, letting a caller spoof request.ip to
    // bypass the per-IP redirect rate limit or poison click analytics
    // (unique-visitor hashing + geo lookup both key off request.ip).
    trustProxy: 'loopback',
  });

  // Echo the request id on every response (incl. 404/410/error envelopes) so a
  // failed redirect can be traced back to a single log line.
  app.addHook('onRequest', (request, reply, done) => {
    reply.header('X-Request-ID', request.id);
    done();
  });

  // Security first so helmet headers attach to every response (incl. error envelopes).
  await app.register(SecurityPlugin);
  await app.register(PrismaPlugin);
  await app.register(CachePlugin);
  await app.register(QueuePlugin);

  // Register before the redirect route (hooks `onRoute`) and neutralizes Fastify's
  // validator/serializer so the documentation `schema` doesn't alter the hot path.
  await app.register(SwaggerPlugin);

  // ── Global error handler ────────────────────────────────────────────────────
  // Maps thrown errors to { error: string } envelope per ERROR_CONTRACT.md.
  // Route handlers contain zero try-catch — all errors bubble here.
  app.setErrorHandler((error: unknown, request, reply) => {
    // RateLimitError must be checked before the generic AppError branch so the
    // Retry-After header and retryAfter body field are included in the 429 response.
    if (error instanceof RateLimitError) {
      reply.header('Retry-After', String(error.retryAfter));
      return reply.status(429).send({ error: error.message, retryAfter: error.retryAfter });
    }

    if (error instanceof AppError) {
      // 410 Gone is heuristically cacheable by default (RFC 7231 §6.1). Without an
      // explicit directive a browser/CDN could cache "this code is gone" and stop
      // revalidating — stale after a resurrect, and it blinds the server to traffic
      // on dead links. no-cache (store but revalidate first) matches ERROR_CONTRACT.md
      // §410 and mirrors the no-cache the 302 success path already sends.
      if (error.status === 410) {
        reply.header('Cache-Control', 'no-cache');
      }
      return reply.status(error.status).send({ error: error.message });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      const code = (error as Prisma.PrismaClientKnownRequestError).code;
      if (code === 'P1001' || code === 'P1017') {
        reply.header('Retry-After', '30');
        return reply.status(503).send({ error: 'Service temporarily unavailable' });
      }
      if (code === 'P1008') {
        reply.header('Retry-After', '5');
        return reply.status(504).send({ error: 'Request timed out' });
      }
      if (code === 'P2015' || code === 'P2025') {
        return reply.status(404).send({ error: 'Not found' });
      }
      request.log.error({ err: error }, 'Unhandled Prisma error');
      return reply.status(500).send({ error: 'Internal server error' });
    }

    // Only Fastify's own framework errors (all carry a `FST_ERR_*` code) get
    // their message and status passed through. A `.statusCode` alone is not
    // proof of trustworthy origin — any third-party error can bolt one on, and
    // passing its `.message` straight to the client would bypass the
    // "unexpected error → generic message" rule. Everything else falls back to
    // a generic 500.
    const asRecord = error as Record<string, unknown>;
    const isFastifyError =
      error instanceof Error && typeof asRecord['code'] === 'string' && asRecord['code'].startsWith('FST_ERR_');
    const statusCode =
      isFastifyError && typeof asRecord['statusCode'] === 'number'
        ? (asRecord['statusCode'] as number)
        : 500;

    if (!isFastifyError || statusCode >= 500) {
      request.log.error({ err: error }, 'Unhandled server error');
      return reply.status(500).send({ error: 'Internal server error' });
    }

    return reply.status(statusCode).send({ error: (error as Error).message });
  });

  // ── Routes ──────────────────────────────────────────────────────────────────
  app.register(redirectRoutes);

  return app;
}
