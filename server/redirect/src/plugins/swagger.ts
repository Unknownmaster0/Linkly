import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Swagger / OpenAPI plugin (redirect server)
//
// Serves interactive documentation at GET /docs for the single hot-path endpoint
// GET /:shortCode. As on the api server, Fastify's validator + serializer are
// NEUTRALIZED so the route `schema` is documentation-only and the 302/404/410
// behaviour (and the `{ error }` envelope from the global handler) is unchanged.
//
// Wrapped in fastify-plugin so the compiler overrides + /docs route apply at the
// ROOT scope, and registered in app.ts BEFORE redirectRoutes. Because '/docs' is a
// reserved alias on the api side, no real short code collides with this path.
// ─────────────────────────────────────────────────────────────────────────────

async function swaggerPlugin(app: FastifyInstance): Promise<void> {
  app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
  app.setSerializerCompiler(() => (data: unknown) => JSON.stringify(data));

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'URL Shortener — Redirect Server',
        description:
          'Public, unauthenticated hot path. Resolves a short code and issues a ' +
          '**302** redirect to the original URL (302, never 301, so every click is ' +
          'counted). Click analytics are enqueued fire-and-forget and never block ' +
          'the response. Errors use the `{ error, retryAfter? }` envelope.',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${config.PORT}`, description: config.NODE_ENV }],
      tags: [{ name: 'Redirect', description: 'Short-code resolution' }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  app.log.info('Swagger UI registered at /docs');
}

export default fp(swaggerPlugin, { name: 'swagger' });
