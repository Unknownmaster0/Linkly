/**
 * App-wide constants. The API base URL is the only environment-dependent value;
 * everything else mirrors locked backend rules (see docs/notes/*_CONTRACT.md) so
 * the client can give instant validation feedback before hitting the server.
 */

/** Fastify `api` server. The browser talks to it directly (CORS allow-lists :3002). */
export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000"
).replace(/\/$/, "");

export const APP_NAME = "Linkly";
export const APP_TAGLINE = "Shorten. Share. Measure.";
export const APP_DESCRIPTION =
  "A fast, modern URL shortener with first-class click analytics — built for engineers, students, educators, and teams.";

/** Reserved aliases — rejected by the backend (prevents routing conflicts). */
export const RESERVED_ALIASES = [
  "api",
  "health",
  "docs",
  "admin",
  "static",
] as const;

/** Validation limits, mirrored from server/api/src/schemas. */
export const LIMITS = {
  passwordMin: 8,
  passwordMax: 128,
  urlMax: 2048,
  aliasMin: 3,
  aliasMax: 50,
  ttlMinDays: 1,
  ttlMaxDays: 365,
  defaultTtlDays: 7,
} as const;
