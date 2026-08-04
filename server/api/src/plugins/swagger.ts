import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Swagger / OpenAPI plugin (api server)
//
// Serves interactive API documentation at GET /docs (API_CONTRACT.md §Docs).
//
// IMPORTANT — runtime behaviour is unchanged. This project validates with Zod
// inside handlers and builds responses through the locked envelope helpers. So we
// NEUTRALIZE Fastify's two schema-driven subsystems before any route registers:
//
//   • validatorCompiler  → no-op that accepts everything. Zod (route handler
//     `safeParse`) stays the ONLY validator, so the locked ERROR_CONTRACT 400
//     messages are produced by our global handler, never by AJV.
//   • serializerCompiler  → plain JSON.stringify. fast-json-stringify never runs,
//     so NO response field is ever stripped — the `{ success, message, data }`
//     envelope (and /health's flat shape) serialize byte-for-byte as before.
//
// After neutralization, the `schema` we attach to each route is read ONLY by
// @fastify/swagger to build the OpenAPI document. Wrapped in fastify-plugin so the
// compiler overrides + the /docs route apply at the ROOT scope, and registered in
// app.ts BEFORE the routes it documents.
// ─────────────────────────────────────────────────────────────────────────────

async function swaggerPlugin(app: FastifyInstance): Promise<void> {
  // 1 — Neutralize Fastify's validator and serializer (see header comment).
  app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
  app.setSerializerCompiler(() => (data: unknown) => JSON.stringify(data));

  // 2 — OpenAPI document definition.
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'URL Shortener — API Server',
        description:
          'URL management, authentication, and analytics API.\n\n' +
          'All success responses use the envelope `{ success, message, data }` ' +
          '(except `/health`, a flat liveness probe). All 4xx/5xx responses use ' +
          '`{ error, details?, retryAfter? }` per ERROR_CONTRACT.md. Ownership ' +
          'mismatches return **404, never 403** (IDOR protection).',
        version: '1.0.0',
      },
      servers: [{ url: config.BASE_URL, description: config.NODE_ENV }],
      tags: [
        { name: 'Auth', description: 'Registration, login, token refresh, logout' },
        { name: 'URLs', description: 'Short-URL creation' },
        { name: 'Analytics', description: 'Per-URL click analytics (owner only)' },
        { name: 'Health', description: 'Liveness / readiness probe' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: '10-minute access token. Send as `Authorization: Bearer <token>`.',
          },
          cookieAuth: {
            type: 'apiKey',
            in: 'cookie',
            name: 'refreshToken',
            description: '30-day httpOnly refresh cookie (used by POST /api/auth/refresh).',
          },
        },
      },
    },
  });

  // 3 — Swagger UI at /docs ('docs' is a RESERVED_ALIAS, so no short code can shadow it).
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: true },
  });

  app.log.info('Swagger UI registered at /docs');
}

export default fp(swaggerPlugin, { name: 'swagger' });
