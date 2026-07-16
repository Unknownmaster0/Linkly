import { randomUUID } from 'node:crypto';

type NodeEnv = 'development' | 'production' | 'test';

// ── Privacy & correlation primitives (Day 12) ───────────────────────────────
// The incoming/outgoing header used to correlate a single request across the
// api, redirect, and (eventually) worker logs. Fastify reads this header to
// adopt an upstream id when present, and we echo it back on the response.
export const REQUEST_ID_HEADER = 'x-request-id';

// Log key for the request id. The plan's sample output uses "requestId" rather
// than Fastify's default "reqId" — we match it so greps line up with the docs.
export const REQUEST_ID_LOG_LABEL = 'requestId';

// Fallback id generator, used only when the request carries no REQUEST_ID_HEADER.
// crypto.randomUUID keeps `shared` dependency-free (no `uuid` package) — the arg
// is the raw request, which we ignore; a fresh v4 UUID is always returned.
export function genReqId(): string {
  return randomUUID();
}

// ── Shared pino options ──────────────────────────────────────────────────────
// Applied to BOTH Fastify servers (passed to `Fastify({ logger })`) and the
// worker's standalone pino instance, so log shape never drifts between processes.
//
// `serializers.req` is the load-bearing privacy fix: Fastify's DEFAULT request
// serializer logs `remoteAddress` (the raw client IP) on every "incoming request"
// line. The project rule is "never log raw IPs", so we override it to emit only
// method/url/id and drop the address entirely. (Inert for the worker, which never
// logs a `req`.) `res`/`err` keep pino's/Fastify's default serializers.
//
// `redact` is defense-in-depth for the secret-bearing keys: even though the req
// serializer already strips all headers, we censor Authorization/Cookie and any
// `password` field in case a future log line includes a body or user object.
const sharedPinoOptions = {
  serializers: {
    req(req: { method: string; url: string; id: string }) {
      return { method: req.method, url: req.url, id: req.id };
    },
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
    ],
    censor: '[REDACTED]',
  },
};

const loggerConfigs: Record<NodeEnv, object> = {
  development: {
    ...sharedPinoOptions,
    level: 'debug',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss Z' },
    },
  },
  production: { ...sharedPinoOptions, level: 'info' },
  test:        { ...sharedPinoOptions, level: 'warn' },
};

export function getFastifyLoggerConfig(env: string): object {
  return loggerConfigs[env as NodeEnv] ?? { ...sharedPinoOptions, level: 'info' };
}

// Startup failures (DB/Valkey unreachable, bad config) are caught before the
// Fastify/pino logger exists, so they go to console.error — outside pino's
// `redact` above. Some driver errors interpolate the raw connection string
// (with credentials) into their message, so scrub that shape before it ever
// reaches stdout/process logs.
const CONNECTION_STRING_CREDENTIALS = /(:\/\/)[^\s/:@]+:[^\s/:@]+@/g;

export function redactConnectionStrings(err: unknown): string {
  const text = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  return text.replace(CONNECTION_STRING_CREDENTIALS, '$1[REDACTED]@');
}
