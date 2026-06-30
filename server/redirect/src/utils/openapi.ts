// ─────────────────────────────────────────────────────────────────────────────
// OpenAPI / Swagger helpers (redirect server)
//
// The redirect server's only documented endpoint is GET /:shortCode → 302. It has
// no request body and no success envelope (it issues a redirect, not JSON), so the
// only shape we need is the ERROR_CONTRACT error envelope for the 404 / 410 / 429
// cases. As on the api server, Fastify's validator/serializer are neutralized in
// plugins/swagger.ts, so this `schema` is documentation-only.
// ─────────────────────────────────────────────────────────────────────────────

export type JsonSchema = Record<string, unknown>;

/** Error envelope per ERROR_CONTRACT.md: `{ error, retryAfter? }`. */
export function errorEnvelope(description: string, example?: Record<string, unknown>): JsonSchema {
  return {
    description,
    type: 'object',
    properties: {
      error: { type: 'string' },
      retryAfter: { type: 'integer' },
    },
    required: ['error'],
    ...(example ? { examples: [example] } : {}),
  };
}
