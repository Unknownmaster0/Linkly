import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Security plugin — HTTP security headers (helmet) + CORS allow-list.
//
// Wrapped in fastify-plugin so the helmet/cors registrations apply to the ROOT
// scope (every route), not just this plugin's encapsulation context.
//
// Registered FIRST in app.ts so headers are attached to every response,
// including 4xx/5xx envelopes produced by the global error handler.
// ─────────────────────────────────────────────────────────────────────────────

async function securityPlugin(app: FastifyInstance): Promise<void> {
  // ── helmet — security response headers ─────────────────────────────────────
  // Defaults give us X-Content-Type-Options: nosniff, Cross-Origin-*-Policy,
  // and strips X-Powered-By. We override two to match the design spec:
  //   - frameguard → DENY  (spec wants X-Frame-Options: DENY, not SAMEORIGIN)
  //   - hsts maxAge → 1 year (spec: Strict-Transport-Security max-age=31536000)
  await app.register(helmet, {
    // This is a JSON API; a strict default-src 'self' CSP is correct and cheap.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    hsts: {
      maxAge: 31_536_000, // 1 year, in seconds
      includeSubDomains: true,
    },
  });

  // ── CORS — credentialed allow-list (never '*') ─────────────────────────────
  // Credentials are required because the browser must send the httpOnly refresh
  // cookie on /auth/refresh and the Authorization header on protected routes.
  // The CORS spec forbids credentials with a wildcard origin, so we echo back
  // only origins on the configured allow-list.
  await app.register(cors, {
    origin: config.CLIENT_ORIGINS,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86_400, // cache preflight for 24h
  });

  app.log.info(
    { origins: config.CLIENT_ORIGINS },
    'Security headers (helmet) + CORS allow-list registered'
  );
}

export default fp(securityPlugin, { name: 'security' });
