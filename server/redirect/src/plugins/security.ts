import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

// ─────────────────────────────────────────────────────────────────────────────
// Security plugin (redirect server) — HTTP security headers only.
//
// The redirect server is a public, unauthenticated surface that issues 302s.
// It needs hardening headers (clickjacking / MIME-sniff / HSTS) but NOT CORS:
// redirects are top-level browser navigations, not cross-origin fetches, so a
// CORS allow-list would add nothing and could wrongly block legitimate clicks.
//
// Wrapped in fastify-plugin so helmet applies to the ROOT scope (the redirect
// route), and registered first in app.ts so headers ride on every response.
// ─────────────────────────────────────────────────────────────────────────────

async function securityPlugin(app: FastifyInstance): Promise<void> {
  await app.register(helmet, {
    // 302 responses carry no HTML body, so CSP has nothing to constrain — but
    // keeping a strict default-src 'self' is harmless and consistent with the API.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    hsts: {
      maxAge: 31_536_000, // 1 year, in seconds
      includeSubDomains: true,
    },
  });

  app.log.info('Security headers (helmet) registered');
}

export default fp(securityPlugin, { name: 'security' });
