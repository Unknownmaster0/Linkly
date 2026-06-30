# Day 13 — OpenAPI / Swagger API Documentation

## Goals

- Serve interactive **Swagger UI at `GET /docs`** on **both** long-running HTTP
  servers (`api` :3000 and `redirect` :3001), each with its **own** OpenAPI
  document — the route promised in `API_CONTRACT.md §Health & Documentation`.
- Generate the request schemas from the **existing Zod objects** so the docs are a
  single source of truth with the validator, not a hand-copied second spec that
  drifts.
- Do all of this with **zero change to runtime behaviour** — the locked
  `ERROR_CONTRACT` envelopes, the `{ success, message, data }` success envelope, and
  the 302/404/410 redirect semantics must be byte-for-byte identical before and
  after this day.

This is a "surface, don't change" day: a new read-only documentation endpoint is
exposed; nothing in the request/response path is altered.

---

## The core tension: docs want schemas, this project validates with Zod

`@fastify/swagger` builds an OpenAPI document by reading the `schema` attached to
each route. The idiomatic Fastify app puts a JSON Schema on every route and lets
Fastify's AJV validate the request and `fast-json-stringify` serialize the
response from that same schema.

**This project does not do that** — and for good reasons established on Days 2–8:

- Requests are validated with **Zod, inside the handler** (`safeParse` in
  `routes/*.ts`, rules in `schemas/*.ts`). Zod gives us SSRF guards, cross-field
  checks (`password === confirmPassword`), and transforms that JSON Schema can't
  express.
- The 4xx/5xx bodies are the **locked** `ERROR_CONTRACT` envelope
  `{ error, details?, retryAfter? }`, produced in exactly one place — the global
  error handler in `app.ts`.
- The 2xx bodies are the **locked** `{ success, message, data }` envelope built by
  `utils/api-response.ts`.

So naively "turning on schemas" would have two regressions:

| If we let AJV validate from a route `schema` | Consequence |
|---|---|
| AJV rejects a bad body **before** the handler runs | The 400 message becomes AJV's wording, not our `ValidationError` — **breaks ERROR_CONTRACT** |
| `fast-json-stringify` serializes from a `response` schema | Any field not in the schema is **silently stripped** from the envelope |

This is the same call made on Days 8 and 10: a generic best-practice is *adapted*
to the project's locked contracts rather than followed blindly.

---

## Decision 1 — neutralize Fastify's validator + serializer

We keep the route `schema` (so Swagger has something to read) but make Fastify's
two schema-driven subsystems **no-ops**, leaving Zod and the envelope helpers as the
sole authorities. This happens once per server, in `plugins/swagger.ts`, before any
route registers:

```ts
// Zod stays the only validator → ERROR_CONTRACT 400s are ours, never AJV's.
app.setValidatorCompiler(() => (data: unknown) => ({ value: data }));
// Plain JSON.stringify → fast-json-stringify never runs → no field is stripped.
app.setSerializerCompiler(() => (data: unknown) => JSON.stringify(data));
```

Both overrides replicate Fastify's behaviour for a route that has **no** schema
(accept-all validation, default JSON serialization), so attaching a documentation
schema changes nothing at runtime. After this, the route `schema` is **pure
documentation metadata** consumed only by `@fastify/swagger`.

Wrapped in `fastify-plugin` (like `security.ts`) so the compiler overrides and the
`/docs` route attach to the **root** scope, and registered in `app.ts` **before**
the routes — `@fastify/swagger` hooks `onRoute`, so it only sees routes registered
after it.

### Why this is safe, proven live

A throwaway `app.inject()` boot (no DB/Valkey needed — neither plugin connects
eagerly) confirmed the invariants:

```
POST /api/shorten        (no token)   → 401 {"error":"Unauthorized"}
POST /api/auth/login     (empty body) → 400 {"error":"Invalid input: expected string, received undefined","details":{"field":"email"}}
```

The 400 is the **Zod** `ValidationError` envelope (note the `details.field`), not an
AJV message — proof the validator neutralization holds and the locked contract is
intact.

---

## Decision 2 — derive request schemas from Zod, hand-author responses

The request schemas are generated from the **same Zod objects** that validate the
request, via Zod v4's native `z.toJSONSchema()` (we're on `zod@4.4.3`), wrapped in
`utils/openapi.ts`:

```ts
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    io: 'input',              // document what the CLIENT sends, pre-transform
    unrepresentable: 'any',   // drop non-JSON-Schema checks instead of throwing
    target: 'openApi3.0',
  });
}
```

Two subtleties that `io`/`unrepresentable` handle:

- **`io: 'input'`** — `shortenBodySchema` ends in `.transform()` that maps
  `{ url, customAlias, ttlDays }` → `{ originalUrl, customAlias, expiresAt }`. The
  client sends the *input* shape, so we document the input, not the transformed
  output.
- **`unrepresentable: 'any'`** — `.refine()` rules (the SSRF/loopback guard, the
  http/https-only check, the reserved-alias check, `password === confirmPassword`)
  have no JSON Schema representation. Rather than throw, they're omitted from the
  schema and instead described in each route's `description` text.

Verified that all four request schemas convert cleanly (types, `min`/`max`,
`pattern`, `optional`, `default` all survive; refinements/transform drop silently).

**Responses are hand-authored.** The response payloads are TypeScript `interface`s
(`ShortenResult`, `AnalyticsSummary`, …), not Zod, so there's nothing to convert.
`utils/openapi.ts` exposes small builders that mirror `api-response.ts` at the
schema level — `successEnvelope(data, desc)` and `errorEnvelope(desc, example)` —
so every documented response matches the locked envelope shape by construction.

---

## Decision 3 — one OpenAPI document per server

Per the scope decision, each server gets a **dedicated** spec rather than a single
merged one — they are independently deployable processes with disjoint surfaces.

| Server | `/docs` covers | Notes |
|---|---|---|
| `api` :3000 | Auth (register/login/refresh/logout), `POST /api/shorten`, Analytics (summary + events), `/health` | `bearerAuth` (JWT) + `cookieAuth` (refresh cookie) security schemes; tag groups Auth / URLs / Analytics / Health |
| `redirect` :3001 | `GET /:shortCode` → 302 / 404 / 410 / 429 | No auth; success documented via the `302` response + `Location`/`Cache-Control` headers (a redirect has no JSON body) |

`'docs'` is already a `RESERVED_ALIAS` (`url.schema.ts`), so no short code can ever
shadow the `/docs` path on either server — the documentation route and the
parametric `/:shortCode` route can't collide.

### Endpoints documented vs. the contract

`API_CONTRACT.md` lists `GET /api/urls` and `DELETE /api/urls/:shortCode`, but those
are **not implemented yet** (only `POST /api/shorten` exists in `routes/url.ts`).
The docs reflect **what is actually built** — they are generated from live routes,
so they can't over-promise. When those routes land, their docs appear automatically
from their own `schema` blocks.

---

## What was explicitly *not* changed

- **No Zod schema was touched.** Validation rules are identical.
- **No error-handling code was touched.** The global handlers in both `app.ts`
  files are unchanged; `ERROR_CONTRACT` envelopes are produced exactly as before.
- **No response envelope was touched.** `api-response.ts` is unchanged; the
  serializer override reproduces default JSON serialization.
- **No new business endpoint** was added — this day is documentation only.

No breaking changes were found or introduced.

---

## Files created / changed

### `api/src/plugins/swagger.ts` (new)
`fastify-plugin`-wrapped plugin: neutralizes the validator + serializer, registers
`@fastify/swagger` (OpenAPI 3.0.3 doc — title, servers from `config.BASE_URL`,
tags, `bearerAuth` + `cookieAuth` security schemes) and `@fastify/swagger-ui` at
`/docs`.

### `api/src/utils/openapi.ts` (new)
`zodToJsonSchema()` (Zod→JSON Schema, `io:'input'`), plus `successEnvelope()` /
`errorEnvelope()` / `noContentResponse` builders mirroring `api-response.ts`.

### `api/src/routes/{auth,url,analytics,health}.ts`
Added a documentation-only `schema` block to every route (tags, summary,
description, `security`, Zod-derived `body`/`querystring`, hand-authored
`response`). `/health` documents its flat non-envelope `{ status, db, timestamp }`
shape — the one success-response exception.

### `api/src/app.ts`
Register `SwaggerPlugin` after the data plugins and **before** the routes.

### `redirect/src/plugins/swagger.ts` (new)
Same neutralization + a redirect-specific OpenAPI doc; Swagger UI at `/docs`.

### `redirect/src/utils/openapi.ts` (new)
Minimal `errorEnvelope()` (redirect needs no Zod conversion — no request body).

### `redirect/src/routes/redirect.ts` + `redirect/src/app.ts`
Documentation `schema` for `GET /:shortCode` (302 + `Location`/`Cache-Control`
headers, 404/410/429); register `SwaggerPlugin` before `redirectRoutes`.

### `api/package.json` / `redirect/package.json`
Added `@fastify/swagger@^9` + `@fastify/swagger-ui@^5` (both Fastify-5 compatible).

---

## Verification summary

| Check | Result |
|---|---|
| `tsc --noEmit` on `api` | ✅ clean |
| `tsc --noEmit` on `redirect` | ✅ clean |
| `z.toJSONSchema` converts all 4 request schemas (transform/refine present) | ✅ no throw |
| `GET /docs/json` (api) lists all 8 live paths + both security schemes | ✅ |
| `GET /docs` (api) serves Swagger UI HTML (200) | ✅ |
| `GET /docs/json` (redirect) → `/{shortCode}` with codes 302/404/410/429 | ✅ |
| `GET /docs` (redirect) serves Swagger UI HTML (200) | ✅ |
| `POST /api/shorten` no token → `401 {"error":"Unauthorized"}` (AJV did not pre-empt) | ✅ |
| `POST /api/auth/login` empty body → Zod `400 {error, details:{field}}` (not AJV) | ✅ |
| Success / error envelopes unchanged | ✅ |

> Both servers now publish an accurate, interactive OpenAPI document whose request
> schemas come straight from the Zod validators — and they do so without moving a
> single byte in the request/response path the locked contracts govern.
