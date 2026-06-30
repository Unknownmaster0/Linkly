# Day 8 — Input Validation + Security Hardening

## Goals

- Put a **security-header layer** (`helmet`) in front of *every* response on both the `api` and `redirect` servers — clickjacking, MIME-sniffing, and transport hardening that was previously absent.
- Add a **credentialed CORS allow-list** on the `api` server so the future browser dashboard can call it without opening the API to arbitrary origins.
- Confirm and harden the **input-validation surface**: every request body/query is Zod-parsed before it reaches business logic, dangerous URL schemes and SSRF targets are rejected, and the password policy is tightened.
- Re-assert the two security invariants this project is graded on — **IDOR → 404 (never 403)** and **no raw-IP / secret leakage** — and document where they live.

This is the first "production hardening" day: nothing new is *exposed*, everything is *defended*.

---

## What was already in place (and stays)

Day 8 is partly an audit. A good chunk of the validation surface was built incrementally on Days 2–7, so the work here is *completing* it, not starting it. For the record, already-present and verified sound:

| Area | Where | Status |
|---|---|---|
| Register / login body validation (Zod) | `api/schemas/auth.schema.ts` | ✅ (password rule tightened today) |
| Shorten body validation (URL, alias, ttl) | `api/schemas/url.schema.ts` | ✅ |
| `http`/`https`-only scheme check (blocks `javascript:`, `data:`, `ftp:`) | `url.schema.ts` | ✅ |
| SSRF guard (loopback, link-local, RFC-1918, IPv6 ULA) | `url.schema.ts:isPrivateOrLocal` | ✅ |
| Reserved-alias rejection (`api`, `health`, `docs`, `admin`, `static`) | `url.schema.ts:RESERVED_ALIASES` | ✅ |
| Analytics query validation (`?limit`/`?offset`) | `api/schemas/analytics.schema.ts` | ✅ |
| IDOR → 404, never 403 | `api/services/analytics.service.ts:requireOwnedUrl` | ✅ |
| Generic auth errors (no user enumeration) | `api/services/auth.service.ts` | ✅ |

The net-new work today is: **helmet on both servers, CORS on the api server, and a stricter password regex.**

---

## Decision 1 — helmet, not hand-rolled headers

The plan says "use helmet." Two ways to get there:

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Hand-rolled `onSend` hook setting headers | Zero new dependency, fully explicit | Re-implements (and will drift from) a maintained baseline; easy to forget a header | No |
| `@fastify/helmet` plugin | Maintained, sane defaults, one line per override, used by the wider Fastify ecosystem | One new dependency per server | ✅ Yes |

`@fastify/helmet@13` (Fastify 5-compatible) is registered through a thin local plugin in each server's `plugins/` directory, wrapped in `fastify-plugin` so the registration escapes the plugin's encapsulation scope and applies to the **root** instance (every route).

### Why it is registered *first*

```ts
// app.ts — security before everything else
await app.register(SecurityPlugin);   // helmet (+ cors on api)
await app.register(PrismaPlugin);
await app.register(CachePlugin);
```

Registering it ahead of the routes means the headers are attached by an `onRequest`/`onSend` hook that fires for **every** response — including the `4xx`/`5xx` envelopes produced by the global error handler. A 404 from the redirect server still carries `X-Frame-Options: DENY`. Verified:

```
GET http://localhost:3001/zzzdoesnotexist  →  404
  Content-Security-Policy: default-src 'self';frame-ancestors 'none';base-uri 'self';...
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

### The two overrides

helmet's defaults are mostly right out of the box; we override exactly two to match the design spec:

| Header | helmet default | Our value | Why |
|---|---|---|---|
| `X-Frame-Options` | `SAMEORIGIN` | `DENY` | This API/redirect is never meant to be framed; spec calls for `DENY`. |
| `Strict-Transport-Security` | `max-age=15552000` (180 d) | `max-age=31536000; includeSubDomains` (1 y) | Spec value; standard 1-year HSTS. |

Everything else (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-*-Policy`, `Origin-Agent-Cluster`, and the strip of `X-Powered-By`) is helmet's default and left untouched. We also pin a strict `Content-Security-Policy` (`default-src 'self'`, `frame-ancestors 'none'`) — cheap and correct for a JSON API even though a CSP matters far more for HTML responses.

---

## Decision 2 — CORS is a credentialed allow-list, never `*`

The browser dashboard (separate origin) must send **two** credentials to the api server:

1. the `httpOnly` refresh cookie on `POST /api/auth/refresh`, and
2. the `Authorization: Bearer` header on every protected route.

Sending credentials cross-origin requires `Access-Control-Allow-Credentials: true`. The CORS spec **forbids** combining that with a wildcard `Access-Control-Allow-Origin: *` — the browser will refuse the response. So the origin must be an explicit allow-list that the server echoes back per request.

```ts
await app.register(cors, {
  origin: config.CLIENT_ORIGINS,          // exact-match allow-list from env, e.g. ['http://localhost:3002']
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86_400,                          // cache preflight 24h
});
```

`CLIENT_ORIGINS` is a new, comma-separated env var (default `http://localhost:3002`, the dashboard's dev port) parsed in `api/config.ts`. Behaviour, verified live:

```
OPTIONS /api/shorten  Origin: http://localhost:3002   → 204  Access-Control-Allow-Origin: http://localhost:3002
                                                              Access-Control-Allow-Credentials: true
OPTIONS /api/shorten  Origin: http://evil.com          → 204  (no Access-Control-Allow-Origin — not echoed)
```

Requests with **no** `Origin` header (curl, Postman, server-to-server) are not blocked — CORS is a browser-enforced policy, and `@fastify/cors` simply omits the headers for them. This is why the Postman suite still works without an origin.

### Why the redirect server gets helmet but **not** CORS

The redirect server is a public, unauthenticated surface whose only job is `GET /:shortCode → 302`. A redirect is a **top-level browser navigation**, not a cross-origin `fetch()`, so CORS never enters the picture — adding an allow-list there would protect nothing and could wrongly reject legitimate clicks from any referring site. Redirect gets the hardening headers (helmet) and stops there.

---

## Decision 3 — stricter password policy

The register schema previously required *a letter + a number*. The plan's `RegisterSchema` requires an explicit uppercase letter. Tightened to require **all three** character classes:

```ts
// api/schemas/auth.schema.ts
password: z.string().min(8).max(128)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number'),
```

This is a deliberate behaviour change: a previously-accepted password like `alllower123` now returns `400`. Verified live (`alllower123` → `400`). The full-suite Postman collection asserts this new case explicitly and uses `Password123` (upper + lower + digit) as its valid fixture, so it satisfies the new rule.

---

## A note on `400` vs `422`

The section-7 plan writes "return 422" for validation failures. This project's **locked** `ERROR_CONTRACT.md` standardises on **`400`** for all request-shape/validation errors, with the envelope `{ error, details? }`. We follow the locked contract: validation failures are `400`, and `details` carries field-level context on body validation. This is intentional and consistent across every route; the plan's `422` is treated as illustrative, not binding.

---

## Security invariants re-asserted

### IDOR → 404, never 403

`analytics.service.ts` resolves and ownership-checks in a single place, and a miss on *either* condition throws the same `OwnershipError` (404):

```ts
async function requireOwnedUrl(shortCode, userId) {
  const url = await repo.findUrlMetaByShortCode(shortCode);
  if (url === null || url.userId !== userId) throw new OwnershipError(); // 404, not 403
  return url;
}
```

Returning `403` would tell an attacker "this code exists, you just don't own it" — an existence oracle. `404` for both branches reveals nothing. The full-suite collection proves this with a second user hitting the first user's `shortCode` and asserting `404` (not `403`) on both the summary and events endpoints.

### No raw-IP / secret leakage

Unchanged from Day 7 but worth restating as part of the Day 8 audit: the analytics read models return `countryCode`/`city`/`deviceType`/`referrerDomain` and **never** `ipHash` or a raw IP. The Postman suite asserts `ipHash`/`ip`/`ip_hash` are absent from both the summary and the event rows.

---

## Known follow-up (not a Day 8 defect)

The refresh cookie is set `HttpOnly; SameSite=Strict` (`+ Secure` in production). `SameSite=Strict` means the cookie is **not** sent on cross-site requests. That is correct for the current single-origin/local setup, but when the dashboard is deployed to a *different site* than the api server (e.g. Vercel frontend → EC2 API), the refresh flow will need `SameSite=None; Secure` to let the cookie travel cross-site. Flagged here so it is handled on the frontend-integration day rather than discovered as a "refresh silently fails in prod" bug.

---

## Files created / changed

### `api/src/plugins/security.ts` (new)
helmet + CORS as a single `fastify-plugin`-wrapped plugin. helmet with `frameguard: deny`, 1-year HSTS, strict CSP; CORS as a credentialed allow-list from `config.CLIENT_ORIGINS`.

### `redirect/src/plugins/security.ts` (new)
helmet only (same header config as the api), no CORS — the redirect surface doesn't need it.

### `api/src/app.ts` / `redirect/src/app.ts`
Register `SecurityPlugin` **first**, before the data plugins and routes, so headers attach to every response including error envelopes.

### `api/src/config.ts`
Added `CLIENT_ORIGINS` — comma-separated browser-origin allow-list (default `http://localhost:3002`), parsed into a string array.

### `api/src/schemas/auth.schema.ts`
Password regex now requires uppercase **and** lowercase **and** a digit (was letter + number).

### `api/package.json` / `redirect/package.json`
Added `@fastify/helmet@^13`; api also adds `@fastify/cors@^11`.

### `docs/postman/url-shortener-collection-full.json` (new)
A single cumulative collection exercising Days 1–9 end-to-end, including a dedicated **Security Headers & CORS** folder that asserts the helmet headers, the credentialed-allow-list preflight, the disallowed-origin case, and the redirect server's headers.

---

## Verification summary

| Check | Result |
|---|---|
| `tsc --noEmit` on api + redirect | clean |
| `GET /health` carries CSP, HSTS (1y), `X-Frame-Options: DENY`, nosniff, `Referrer-Policy` | ✅ |
| Redirect `404` carries the same helmet headers | ✅ |
| CORS preflight from `http://localhost:3002` → origin echoed + credentials | ✅ |
| CORS preflight from `http://evil.com` → origin **not** echoed | ✅ |
| `alllower123` password → `400` (uppercase rule) | ✅ |
| Cross-user analytics access → `404` (IDOR, not 403) | ✅ (collection) |
| `javascript:` / `data:` / private-IP / localhost URLs → `400` | ✅ (collection) |
