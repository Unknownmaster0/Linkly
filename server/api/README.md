# API Server

Fastify-based REST API server for the URL shortener. Handles URL creation, authentication, and analytics. Redirect serving is intentionally kept in a separate process to allow independent scaling.

## Tech Stack

| | |
|---|---|
| Runtime | Node.js 20+ / TypeScript 5 |
| Framework | Fastify 5 |
| ORM | Prisma 7 (`@prisma/adapter-pg`) |
| Database | PostgreSQL 15 |
| Cache | Valkey 7 (Redis-compatible) |
| Auth | JWT (access token) + Argon2-hashed refresh tokens |
| Validation | Zod 4 |
| Logging | Pino / pino-pretty |

## Project Structure

```
api/
├── prisma/
│   ├── schema.prisma          # Data model
│   └── migrations/            # Migration history
├── src/
│   ├── server.ts              # Entry point — starts Fastify
│   ├── app.ts                 # App factory — registers plugins, routes, error handler
│   ├── config.ts              # Env var loading
│   ├── db/
│   │   └── index.ts           # Prisma plugin (decorates app.prisma)
│   ├── middleware/
│   │   └── auth.ts            # JWT Bearer authentication
│   ├── routes/
│   │   ├── health.ts          # GET /health
│   │   └── url.ts             # POST /api/urls
│   ├── utils/
│   │   ├── base62.ts          # Base62 encoder/decoder
│   │   └── api-response.ts    # Response envelope builders
│   ├── types/
│   │   └── fastify.d.ts       # Fastify type augmentations
│   └── generated/
│       └── prisma/            # Prisma-generated client types
├── package.json
├── tsconfig.json
└── prisma.config.ts
```

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
DATABASE_URL=postgresql://admin:secret@localhost:5432/urlshortener
VALKEY_URL=redis://localhost:6379
JWT_SECRET=<generate-a-long-random-secret>
JWT_REFRESH_SECRET=<generate-a-different-long-random-secret>
BASE_URL=http://localhost:3000
NODE_ENV=development
PORT=3000
DEFAULT_URL_TTL_DAYS=7
```

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `VALKEY_URL` | No | Valkey/Redis URL (defaults to `redis://localhost:6379`) |
| `JWT_SECRET` | Yes | Secret used to sign/verify JWT access tokens — no default, server refuses to start without it |
| `JWT_REFRESH_SECRET` | Yes | Secret used to sign/verify JWT refresh tokens — no default, server refuses to start without it |
| `BASE_URL` | Yes | Public base URL for constructing short links |
| `NODE_ENV` | No | `development` \| `production` \| `test` |
| `PORT` | No | Server port (default `3000`) |
| `DEFAULT_URL_TTL_DAYS` | No | Expiry applied when no `ttlDays` is given (default `7`) |

## Setup

### 1. Start infrastructure

From the repo root:

```bash
docker compose up -d
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run database migrations

```bash
npx prisma migrate dev
```

### 4. Start the dev server

```bash
npm run dev
```

The server starts on `http://localhost:3000` with hot-reload via `tsx`.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with `tsx` (hot-reload) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output (`dist/server.js`) |
| `npm run type-check` | Type-check without emitting |

## API Reference

All responses follow a consistent envelope:

```jsonc
// Success
{ "success": true, "message": "...", "data": { ... } }

// Error
{ "success": false, "error": "...", "details": { ... } }
```

---

### Health Check

```
GET /health
```

Returns server status. No auth required.

**Response `200`**
```json
{ "status": "ok" }
```

---

### Shorten a URL

```
POST /api/urls
Authorization: Bearer <access_token>
Content-Type: application/json
```

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | Yes | Target URL (`http` or `https`, max 2048 chars) |
| `customAlias` | `string` | No | 3–50 chars, alphanumeric + hyphen, not a reserved word |
| `ttlDays` | `number` | No | Expiry in days (1–365). Falls back to `DEFAULT_URL_TTL_DAYS` |

```json
{
  "url": "https://example.com/some/long/path",
  "customAlias": "my-link",
  "ttlDays": 30
}
```

**Response `201`**
```json
{
  "success": true,
  "message": "URL shortened successfully",
  "data": {
    "shortCode": "3f9K",
    "shortUrl": "http://localhost:3000/my-link",
    "originalUrl": "https://example.com/some/long/path",
    "customAlias": "my-link",
    "createdAt": "2026-06-10T10:00:00.000Z",
    "expiresAt": "2026-07-10T10:00:00.000Z"
  }
}
```

**Error responses**

| Status | Reason |
|---|---|
| `400` | Validation failure (invalid URL, alias format, TTL out of range) |
| `401` | Missing or invalid Bearer token |
| `409` | Custom alias already taken |

---

> Auth routes (`POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`,
> `POST /api/auth/logout`, `DELETE /api/auth/account`) and analytics routes
> (`GET /api/analytics/:shortCode`, `GET /api/analytics/:shortCode/events`) are implemented —
> see `../../docs/notes/API_CONTRACT.md` for full request/response shapes.

## Core Modules

### Base62 encoder (`src/utils/base62.ts`)

Short codes are generated by encoding a PostgreSQL sequence value to Base62. The alphabet is `0-9a-zA-Z` (62 characters), producing compact codes (e.g. sequence `1000000` → `4c92`).

```ts
encodeToBase62(1000000n)  // → "4c92"
decodeBase62ToDecimal("4c92")  // → 1000000n
```

The sequence-based approach avoids collisions without random retries. Codes are not padded, so early URLs are short and grow in length as the counter increases.

### Response envelope (`src/utils/api-response.ts`)

Every route uses one of three builders — never raw JSON objects:

```ts
successResponse("URL shortened successfully", data)
errorResponse("Custom alias already in use", { field: "customAlias" })
rateLimitResponse(60)  // includes retryAfter field
```

### Auth middleware (`src/middleware/auth.ts`)

A Fastify `preHandler` that verifies a `Bearer` JWT and attaches `request.userId`. Routes opt in by listing it in `preHandler`:

```ts
app.post('/urls', { preHandler: authenticate }, handler)
```

Returns `401` with a `WWW-Authenticate` header on any failure (missing token, expired, invalid).

### Error handler (`src/app.ts`)

A global `setErrorHandler` maps Prisma error codes to HTTP statuses before any response leaves the server:

| Prisma code | HTTP status |
|---|---|
| `P1001`, `P1017` | `503` + `Retry-After: 30` |
| `P1008` | `504` + `Retry-After: 5` |
| `P2002` | `409` (unique constraint) |
| `P2025` | `404` (record not found) |
| `P2034` | `409` + `Retry-After: 1` (write conflict) |
| `P2003`–`P2014` | `400` (invalid data) |

## Architecture Patterns

### Dependency Injection (factory function pattern)

Prisma is registered once as a Fastify decorator (`app.prisma`) and injected downward through factory functions — no DI container needed:

```
Route layer    →  createAuthService(app.prisma)
Service layer  →  createAuthRepository(prisma)
Repository     →  uses prisma directly
```

Each layer receives its dependency as a parameter, making units independently testable by swapping in a mock Prisma client without touching module imports.

---

## Database Schema (summary)

| Table | Purpose |
|---|---|
| `users` | Registered accounts (UUID PK, Argon2 password hash) |
| `refresh_tokens` | Stored refresh tokens (revocable, linked to user) |
| `urls` | Shortened URLs (Base62 short_code, soft-delete via `is_deleted`) |
| `click_events` | Per-redirect analytics (monthly partitioned, hashed IP) |
| `daily_analytics_aggregates` | Pre-computed daily rollups for fast dashboard queries |

See `prisma/schema.prisma` for the full schema and `docs/sections/section-4-database-design-hinglish.md` for design rationale.
