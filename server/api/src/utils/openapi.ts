// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI / Swagger helpers (api server)
//
// This project validates with Zod *inside* handlers (see routes/*.ts) and builds
// responses through the locked envelope helpers in api-response.ts. Fastify's own
// AJV validator and fast-json-stringify serializer are therefore NEUTRALIZED in
// plugins/swagger.ts so that attaching a `schema` to a route does NOT change any
// runtime behaviour — the `schema` is consumed *only* by @fastify/swagger to build
// the OpenAPI document.
//
// Two consequences this file exists to serve:
//   1. Request schemas are DERIVED from the same Zod objects that validate the
//      request (`zodToJsonSchema`) — single source of truth, no drift.
//   2. Response schemas are hand-authored (responses are TS interfaces, not Zod)
//      via the small `successEnvelope` / `errorEnvelope` builders below, so every
//      documented response matches the locked API_CONTRACT / ERROR_CONTRACT shape.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/** A plain JSON Schema object as understood by @fastify/swagger. */
export type JsonSchema = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Zod → JSON Schema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a Zod schema to an OpenAPI-3 JSON Schema for documentation.
 *
 * - `io: 'input'` is required because several request schemas end in `.transform()`
 *   (e.g. shortenBodySchema maps `{ url, ttlDays }` → `{ originalUrl, expiresAt }`);
 *   we document the shape the CLIENT sends, not the transformed output.
 * - `unrepresentable: 'any'` keeps non-representable Zod checks (`.refine()` SSRF /
 *   http-https guards, cross-field password match) out of the schema instead of
 *   throwing. Those rules are described in each route's `description` instead.
 */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    target: 'openApi3.0',
  }) as JsonSchema;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response envelope builders — mirror utils/api-response.ts at the schema level
// ─────────────────────────────────────────────────────────────────────────────

/** Success envelope: `{ success: true, message: string, data: <data> }`. */
export function successEnvelope(data: JsonSchema, description: string): JsonSchema {
  return {
    description,
    type: 'object',
    properties: {
      success: { type: 'boolean', const: true },
      message: { type: 'string' },
      data,
    },
    required: ['success', 'message', 'data'],
  };
}

/** Error envelope per ERROR_CONTRACT.md: `{ error, details?, retryAfter? }`. */
export function errorEnvelope(description: string, example?: Record<string, unknown>): JsonSchema {
  return {
    description,
    type: 'object',
    properties: {
      error: { type: 'string' },
      details: { type: 'object', additionalProperties: true },
      retryAfter: { type: 'integer' },
    },
    required: ['error'],
    ...(example ? { examples: [example] } : {}),
  };
}

/** A 204 No Content response (logout, delete). */
export const noContentResponse: JsonSchema = {
  description: 'No Content',
  type: 'null',
};
