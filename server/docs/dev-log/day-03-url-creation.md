# Dev Log — Day 3: URL Creation Endpoint

**Date:** 2026-06-09  
**Status:** Complete  
**Deliverable:** `POST /api/shorten` working end-to-end with Base62 encoding, JWT auth, Zod validation, and PostgreSQL persistence.

---

## What Was Built

### New Files

| File | Purpose |
|------|---------|
| `src/types/fastify.d.ts` | Augments `FastifyRequest` with `userId: string` |
| `src/middleware/auth.ts` | JWT verification `preHandler` |
| `src/utils/api-response.ts` | Production API response envelope types and builders |

### Modified Files

| File | Change |
|------|--------|
| `src/routes/url.ts` | Full `POST /api/shorten` implementation (was empty stub) |
| `src/app.ts` | Registered `urlRoutes` + global `setErrorHandler` |

### Installed

```
@types/jsonwebtoken (devDependency)
```

---

## Endpoint Specification

### `POST /api/shorten`

**Auth:** `Authorization: Bearer <JWT>` required

**Request Body:**
```json
{
  "url": "https://example.com/very/long/url",
  "customAlias": "my-link",
  "ttlDays": 30
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `url` | string | ✅ | Valid `http`/`https` URI, max 2048 chars |
| `customAlias` | string | ❌ | Alphanumeric + hyphen, 3–50 chars, not a reserved word |
| `ttlDays` | integer | ❌ | 1–365 |

Reserved alias words: `api`, `health`, `docs`, `admin`, `static`

**Success Response `201`:**
```json
{
  "success": true,
  "message": "URL shortened successfully",
  "data": {
    "shortCode": "gY1k",
    "shortUrl": "http://localhost:3000/my-link",
    "originalUrl": "https://example.com/very/long/url",
    "customAlias": "my-link",
    "createdAt": "2026-06-09T10:23:14.000Z",
    "expiresAt": "2026-07-09T10:23:14.000Z"
  }
}
```

**Error Responses:**

| Status | Scenario |
|--------|----------|
| 400 | Invalid URL, bad alias format, TTL out of range |
| 401 | Missing/invalid/expired JWT |
| 409 | Custom alias already taken |
| 500 | DB failure (handled by global error handler) |

---

## How It Works — Request Flow

```
POST /api/shorten
      │
      ▼
  authenticate (preHandler)
      │  reads Authorization header
      │  jwt.verify() → extracts userId
      │  attaches request.userId
      │
      ▼
  Route Handler
      │
      ├─ Zod safeParse(body)
      │    └─ fail → 400 with first issue message
      │
      ├─ customAlias uniqueness check (findUnique)
      │    └─ exists → 409
      │
      ├─ SELECT nextval('urls_id_seq')  ← atomic counter
      │    └─ encodeToBase62(nextId)   ← e.g. 1001 → "g7"
      │
      ├─ Calculate expiresAt (Date.now + ttlDays * ms)
      │
      ├─ prisma.url.create(...)
      │    └─ select excludes `id` (BigInt, not JSON-safe)
      │
      └─ reply 201 { success, message, data }
```

---

## Problems Solved

### 1. Missing `@types/jsonwebtoken`

**Problem:** `jsonwebtoken@9` does not ship TypeScript declarations. Under `noImplicitAny: true`, `import jwt from 'jsonwebtoken'` caused a compile error.

**Fix:** `npm install --save-dev @types/jsonwebtoken`

---

### 2. BigInt JSON Serialization Error

**Problem:** The Prisma `Url` model has `id: BigInt` (PostgreSQL `BIGSERIAL`). If included in a `reply.send()` payload, Node.js throws:
```
TypeError: Do not know how to serialize a BigInt
```

**Fix:** The `prisma.url.create()` call uses an explicit `select` that omits `id`. Only string/Date fields are returned:
```typescript
select: { shortCode, originalUrl, customAlias, expiresAt, createdAt }
```
`BigInt` never reaches the JSON serializer.

---

### 3. Fastify v5 Error Handler Types `error` as `unknown`

**Problem:** In Fastify v5, `setErrorHandler`'s `error` parameter is typed as `unknown`. Standard property access like `error.statusCode` or `error.message` fails the type-checker.

**Fix:** Explicit type narrowing before property access:
```typescript
const isErrorObj = error instanceof Error;
const statusCode = isErrorObj && 'statusCode' in error && ...
  ? (error as Record<string, unknown>)['statusCode'] as number
  : 500;
const message = isErrorObj ? error.message : 'Internal server error';
```

---

### 4. Zod v4 Removed `invalid_type_error`

**Problem:** Zod v4 (installed `zod@4.4.3`) removed the `{ invalid_type_error }` option from `z.number()`. Using it caused:
```
error TS2353: Object literal may only specify known properties,
and 'invalid_type_error' does not exist in type ...
```

**Fix:** Zod v4 uses `{ error: string }` as the unified message param:
```typescript
// Zod v3 (old)
z.number({ invalid_type_error: 'TTL must be a number' })

// Zod v4 (correct)
z.number({ error: 'TTL must be a number' })
```

---

### 5. `exactOptionalPropertyTypes` — Optional Field Construction

**Problem:** TypeScript's `exactOptionalPropertyTypes: true` distinguishes between `undefined` and a missing property. Writing `{ details: undefined }` is a type error when `details?: X` is optional.

**Fix:** Conditional construction in `errorResponse()`:
```typescript
export function errorResponse(message: string, details?: Record<string, unknown>): ApiError {
  if (details !== undefined) {
    return { success: false, error: message, details };
  }
  return { success: false, error: message };
}
```

---

### 6. Global Error Handler — Prisma Error Code Mapping

**Problem:** Before Day 3, there was no global error handler (`TODO-001`, `TODO-003`). Unhandled Prisma errors would crash with a 500 and expose internal stack traces.

**Fix:** `app.setErrorHandler(...)` in `app.ts` maps Prisma error codes to HTTP responses:

| Prisma Code | HTTP | Meaning |
|-------------|------|---------|
| P1001, P1017 | 503 | DB unreachable |
| P1008 | 504 | Query timeout |
| P2002 | 409 | Unique constraint violation |
| P2025 | 404 | Record not found |
| P2034 | 409 | Write conflict (retry) |
| Others | 500 | Internal error (logged, not exposed) |

This resolves `TODO-001` (health route error handling) and `TODO-003` (error shape enforcement) from `docs/dev-todos/todos.md`.

---

## Design Decisions Applied

### Sequence-Based Short Code (not UUID)

Short codes come from `SELECT nextval('urls_id_seq')` — a PostgreSQL atomic counter. The returned `bigint` is Base62-encoded into a short string (`1` → `"1"`, `62` → `"10"`, `1,000,000` → `"4c92"`).

**Why not UUID?** UUIDs are 36 chars — not suitable as short codes. Counter + Base62 produces 1–7 char codes for the first ~3.5 trillion URLs.

**Why not application-level counter?** Race conditions. Two concurrent requests could get the same counter value. PostgreSQL `SEQUENCE` is atomic at the database level — no locking needed.

### Custom Alias Pre-Check vs Relying on P2002

We do an explicit `findUnique` before insert for the custom alias check. This allows returning a specific, user-friendly 409 with `{ details: { field: "customAlias" } }`.

The global error handler still catches P2002 as a backstop (race condition window between check and insert), but returns a generic "Resource already exists" message in that case.

### `shortUrl` Resolves to `customAlias` if Present

The short link the user shares is built from `customAlias ?? shortCode`:
```
https://short.url/my-project   ← if customAlias provided
https://short.url/gY1k         ← otherwise
```
Both `shortCode` and `customAlias` are stored in the DB. The redirect server (Day 4) will look up by either.

---

## API Response Envelope

All routes now return one of two shapes (defined in `src/utils/api-response.ts`):

```typescript
// Success
{ success: true,  message: string, data: T }

// Error
{ success: false, error: string, details?: Record<string, unknown>, retryAfter?: number }
```

Builders to use in routes:
```typescript
successResponse('URL shortened successfully', result)  // → ApiSuccess<T>
errorResponse('Custom alias already in use', { field: 'customAlias' })  // → ApiError
rateLimitResponse(3600)  // → ApiError with retryAfter
```

---

## Testing Manually

Since auth routes (register/login) are Day 5 work, generate a test JWT from the Node REPL:

```js
// Run in: cd api && node
const jwt = await import('jsonwebtoken');
const token = jwt.default.sign(
  { userId: '00000000-0000-0000-0000-000000000001' },
  '40c8a290c871cc64bd61dfded963420fe2590a37eecf57d4768eac82ce5c4ce0',  // from .env
  { expiresIn: '1h' }
);
console.log(token);
```

> **Note:** `userId` must be a valid UUID — the `urls.user_id` column is `@db.Uuid`. Use any well-formed UUID v4 string.

**Test cases:**

```bash
BASE=http://localhost:3000
TOKEN="<paste token from above>"

# 1. Basic URL shortening
curl -s -X POST $BASE/api/shorten \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/a/very/long/path"}' | jq

# Expected: 201 { success: true, data: { shortCode, shortUrl, ... } }

# 2. With custom alias + TTL
curl -s -X POST $BASE/api/shorten \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://google.com","customAlias":"my-test","ttlDays":7}' | jq

# Expected: 201, shortUrl ends with /my-test, expiresAt is set

# 3. Duplicate alias (run test 2 again)
# Expected: 409 { success: false, error: "Custom alias already in use" }

# 4. Missing auth header
curl -s -X POST $BASE/api/shorten \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' | jq
# Expected: 401 { success: false, error: "Unauthorized" }

# 5. Invalid URL scheme
curl -s -X POST $BASE/api/shorten \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"javascript:alert(1)"}' | jq
# Expected: 400 { success: false, error: "URL must be a valid http or https URI" }

# 6. Reserved alias
curl -s -X POST $BASE/api/shorten \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","customAlias":"admin"}' | jq
# Expected: 400 { success: false, error: "Alias is reserved" }

# 7. Verify DB (psql or Prisma studio)
# SELECT short_code, original_url, custom_alias, expires_at FROM urls;
```

---

## TODOs Resolved

| ID | Description | Status |
|----|-------------|--------|
| TODO-001 | Replace try-catch in health.ts with global error handler | ✅ Resolved — `setErrorHandler` now handles all Prisma errors globally |
| TODO-003 | Error response shape not enforced | ✅ Resolved — `ApiError` / `ApiSuccess<T>` types enforced via `api-response.ts` builders |

---

## Outstanding (Next Days)

| Day | Work |
|-----|------|
| Day 4 | `GET /:shortCode` — redirect endpoint (reads from `urls` table, returns 302) |
| Day 5 | `POST /api/auth/register` + `POST /api/auth/login` — real user creation, real JWTs |
| Day 5 | `POST /api/auth/refresh`, `POST /api/auth/logout` |
| Day 6 | Rate limiting on `POST /api/shorten` (100/user/hour via Valkey) |
| TODO-002 | Config: throw at startup if `JWT_SECRET` is missing in production |
