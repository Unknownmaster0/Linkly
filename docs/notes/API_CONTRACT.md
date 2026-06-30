# API Contract — Routes & Specifications

**Status:** Locked (Pre-Implementation)  
**Last Updated:** 2026-04-18  
**Base URL:** `http://localhost:3000` (development) | `https://api.short.url` (production)

---

## Table of Contents

1. [Authentication Routes](#authentication-routes)
2. [URL Management Routes](#url-management-routes)
3. [Redirect Route](#redirect-route)
4. [Analytics Routes](#analytics-routes)
5. [Health & Documentation](#health--documentation)
6. [Global Headers](#global-headers)

---

## Authentication Routes

### POST /api/auth/register

**Purpose:** Create a new user account

**Auth Required:** No

**Rate Limited:** No

**Request Schema:**

```json
{
  "email": "string (email format, max 255 chars)",
  "password": "string (min 8 chars, max 128 chars, must contain uppercase + lowercase + number)",
  "confirmPassword": "string (must equal password)"
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePass123",
    "confirmPassword": "SecurePass123"
  }'
```

**Response 201 (Success):**

```json
{
  "success": true,
  "message": "Registration successful",
  "data": {
    "user": {
      "id": "cuid_user_id",
      "email": "user@example.com"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**Response Headers:**
```
Set-Cookie: refreshToken=eyJhbGciOiJIUzI1NiIs...; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
```

**Error Responses:**

| Status | Scenario | Example Response |
|--------|----------|---|
| 400 | Email format invalid | `{ "error": "Invalid email format", "details": { "field": "email" } }` |
| 400 | Password too short | `{ "error": "Password must be at least 8 characters", "details": { "field": "password", "minLength": 8 } }` |
| 400 | Passwords don't match | `{ "error": "Passwords do not match", "details": { "field": "confirmPassword" } }` |
| 409 | Email already registered | `{ "error": "Email already registered", "details": { "field": "email" } }` |
| 500 | Database error | `{ "error": "Internal server error" }` |

**Notes:**
- Password must contain at least one letter and one number
- `refreshToken` is set in `httpOnly` cookie (browser auto-sends on subsequent requests)
- `accessToken` is returned in JSON (client must store and send in Authorization header)

---

### POST /api/auth/login

**Purpose:** Authenticate user and get tokens

**Auth Required:** No

**Rate Limited:** No

**Request Schema:**

```json
{
  "email": "string",
  "password": "string"
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePass123"
  }'
```

**Response 200 (Success):**

```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": "cuid_user_id",
      "email": "user@example.com"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**Response Headers:**
```
Set-Cookie: refreshToken=eyJhbGciOiJIUzI1NiIs...; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
```

**Error Responses:**

| Status | Response |
|--------|----------|
| 401 | `{ "error": "Invalid email or password" }` (same for both) |

**Notes:**
- Don't distinguish between "email not found" and "password wrong" (security)
- `refreshToken` cookie is set with same properties as register

---

### POST /api/auth/refresh

**Purpose:** Get a new access token using refresh token cookie

**Auth Required:** No (uses httpOnly cookie)

**Rate Limited:** No

**Request Schema:**

```json
{}
```
(No body; uses `refreshToken` cookie automatically)

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Cookie: refreshToken=eyJhbGciOiJIUzI1NiIs..."
```

**Response 200 (Success):**

```json
{
  "success": true,
  "message": "Token refreshed",
  "data": {
    "user": {
      "id": "cuid_user_id",
      "email": "user@example.com"
    },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... (new, 15 min expiry)"
  }
}
```

**Response Headers:**
```
Set-Cookie: refreshToken=eyJhbGciOiJIUzI1NiIs... (new, 30 day expiry); HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
```

**Error Responses:**

| Status | Scenario | Response |
|--------|----------|----------|
| 401 | Refresh token invalid/missing | `{ "error": "Unauthorized" }` |
| 401 | Refresh token expired | `{ "error": "Unauthorized" }` |
| 401 | Refresh token revoked (user logged out elsewhere) | `{ "error": "Unauthorized" }` |

**Notes:**
- Browser automatically sends `refreshToken` cookie; no manual header needed
- New access token has 15-minute expiry
- New refresh token is issued (and set as httpOnly cookie)

---

### POST /api/auth/logout

**Purpose:** Revoke refresh token and log out user

**Auth Required:** Yes (Bearer token)

**Rate Limited:** No

**Request Schema:**

```json
{}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/logout \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

**Response 204 (Success):**

```
(no body)
```

**Response Headers:**
```
Set-Cookie: refreshToken=; HttpOnly; Secure; SameSite=Strict; Max-Age=0
```

**Side Effects:**
- Refresh token marked as revoked in DB
- Cookie cleared
- User must log in again

**Error Responses:**

| Status | Response |
|--------|----------|
| 401 | `{ "error": "Unauthorized" }` |

---

## URL Management Routes

### POST /api/urls

**Purpose:** Create a new short URL

**Auth Required:** Yes (Bearer token in Authorization header)

**Rate Limited:** Yes (100 URLs per user per hour)

**Request Schema:**

```json
{
  "url": "string (valid http/https URI, max 2048 chars) — REQUIRED",
  "customAlias": "string? (alphanumeric + hyphen, 3-50 chars, must not be reserved) — OPTIONAL",
  "ttlDays": "integer? (1-365 days, after which URL returns 410) — OPTIONAL"
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/urls \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/very/long/url?param=value",
    "customAlias": "my-project",
    "ttlDays": 30
  }'
```

**Response 201 (Success):**

```json
{
  "success": true,
  "message": "URL shortened successfully",
  "data": {
    "shortCode": "gY1k",
    "shortUrl": "https://short.url/gY1k",
    "originalUrl": "https://example.com/very/long/url?param=value",
    "customAlias": "my-project",
    "createdAt": "2026-04-18T12:34:56Z",
    "expiresAt": "2026-05-18T12:34:56Z"
  }
}
```

**Response Headers:**
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1713474060
```

**Error Responses:**

| Status | Scenario | Response |
|--------|----------|----------|
| 400 | URL format invalid | `{ "error": "Invalid URL format", "details": { "field": "url" } }` |
| 400 | URL not http/https | `{ "error": "URL must use http or https protocol", "details": { "field": "url" } }` |
| 400 | Alias format invalid | `{ "error": "Alias must be alphanumeric + hyphen (3-50 chars)", "details": { "field": "customAlias", "pattern": "^[a-zA-Z0-9-]{3,50}$" } }` |
| 400 | Alias is reserved | `{ "error": "Alias is reserved", "details": { "field": "customAlias", "reserved": ["api", "health", "docs", "admin", "static"] } }` |
| 400 | TTL out of range | `{ "error": "TTL must be 1-365 days", "details": { "field": "ttlDays", "min": 1, "max": 365 } }` |
| 401 | Not authenticated | `{ "error": "Unauthorized" }` |
| 409 | Custom alias already in use | `{ "error": "Custom alias already in use", "details": { "field": "customAlias" } }` |
| 429 | Rate limit exceeded | `{ "error": "Rate limit exceeded", "retryAfter": 3600 }` |
| 500 | Server error | `{ "error": "Internal server error" }` |

**Notes:**
- Reserved words: `api`, `health`, `docs`, `admin`, `static` (prevents routing conflicts)
- `customAlias` is optional; if not provided, auto-generated `shortCode` is used
- `expiresAt` is null if no `ttlDays` provided
- Rate limit is per-user, per-hour
- Short code is auto-generated if custom alias not provided

---

### GET /api/urls

**Purpose:** List all short URLs created by the authenticated user

**Auth Required:** Yes (Bearer token)

**Rate Limited:** No

**Query Parameters:** None (pagination deferred to v2)

**Example Request:**
```bash
curl -X GET http://localhost:3000/api/urls \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

**Response 200 (Success):**

```json
{
  "success": true,
  "message": "URLs retrieved",
  "data": {
    "urls": [
      {
        "shortCode": "gY1k",
        "shortUrl": "https://short.url/gY1k",
        "originalUrl": "https://example.com/very/long/url",
        "customAlias": "my-project",
        "createdAt": "2026-04-18T12:34:56Z",
        "expiresAt": "2026-05-18T12:34:56Z",
        "clickCount": 42,
        "isDeleted": false
      },
      {
        "shortCode": "x9kL",
        "shortUrl": "https://short.url/x9kL",
        "originalUrl": "https://google.com",
        "customAlias": null,
        "createdAt": "2026-04-17T10:20:00Z",
        "expiresAt": null,
        "clickCount": 0,
        "isDeleted": false
      }
    ],
    "total": 2
  }
}
```

**Error Responses:**

| Status | Response |
|--------|----------|
| 401 | `{ "error": "Unauthorized" }` |

**Notes:**
- Returns only URLs belonging to authenticated user
- `clickCount` is aggregated from Click table
- `isDeleted` is always false (deleted URLs excluded from list)
- Deleted URLs excluded from results

---

### DELETE /api/urls/:shortCode

**Purpose:** Delete (soft-delete) a short URL

**Auth Required:** Yes (Bearer token; ownership verified)

**Rate Limited:** No

**Request Schema:**

```
No body
```

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `:shortCode` | string | Short code or custom alias |

**Example Request:**
```bash
curl -X DELETE http://localhost:3000/api/urls/gY1k \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

**Response 204 (Success):**

```
(no body)
```

**Side Effects:**
- `Url.is_deleted` set to true (soft delete)
- Valkey cache key `url:gY1k` deleted
- Negative cache entry set: `DELETED:gY1k` with 30s TTL
- Analytics preserved (Click records remain in DB)

**Error Responses:**

| Status | Scenario | Response |
|--------|----------|----------|
| 401 | Not authenticated | `{ "error": "Unauthorized" }` |
| 404 | Short code not found OR doesn't belong to user | `{ "error": "Not found" }` |

**Notes:**
- Both "not found" and "doesn't belong to user" return 404 (information leakage prevention)
- Deleted URLs return 410 on redirect (not 404)
- Analytics history is preserved

---

## Redirect Route

### GET /:shortCode

**Purpose:** Redirect to original URL and record click analytics

**Auth Required:** No (public endpoint)

**Rate Limited:** No (intentional: redirects should never be rate-limited)

**Response:** HTTP 302 redirect with Location header

**Example Request:**
```bash
curl -X GET http://localhost:3000/gY1k -L
```

**Response 302 (Success):**

```
HTTP/1.1 302 Found
Location: https://example.com/very/long/url?param=value
Cache-Control: no-cache
```

**Side Effects:**
- Click event enqueued to BullMQ (fire-and-forget, NOT awaited)
- Background worker: inserts Click record, performs geo lookup, updates analytics
- URL cached in Valkey for subsequent redirects
- User redirected to original URL by browser

**Caching Strategy:**
1. Check Valkey cache key `url:shortCode`
   - HIT: use cached `{ originalUrl, urlId }`
   - MISS: query PostgreSQL
2. If not found, deleted, or expired:
   - Check negative cache key `DELETED:shortCode` (30s TTL)
   - If exists: return 410 (no DB query)
   - If not exists: set negative cache, return 410
3. If valid:
   - Populate Valkey cache with TTL
   - Enqueue click event (non-blocking)
   - Return 302 redirect

**Error Responses:**

| Status | Scenario | Response | Notes |
|--------|----------|----------|-------|
| 302 | Success | (redirect) | Most common path |
| 404 | Short code not found | `{ "error": "Not found" }` | Never cached before |
| 410 | URL expired or deleted | `{ "error": "Short URL expired or deleted" }` | From cache or DB |

**Performance SLA:**
- Cache HIT: p99 < 2ms
- Cache MISS: p99 < 20ms
- Max latency: <100ms

**Notes:**
- Redirects should NEVER be rate-limited (users can click normally)
- `Location` header is the target URL
- `Cache-Control: no-cache` prevents browser caching (we need every redirect for analytics)
- Click event enqueued asynchronously (doesn't block redirect response)

---

## Analytics Routes

### GET /api/analytics/:shortCode

**Purpose:** Get click analytics for a short URL

**Auth Required:** Yes (Bearer token; ownership verified)

**Rate Limited:** No

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `:shortCode` | string | Short code or custom alias |

**Example Request:**
```bash
curl -X GET http://localhost:3000/api/analytics/gY1k \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."
```

**Response 200 (Success):**

Wrapped in the standard envelope: `{ "success": true, "message": "Analytics retrieved", "data": { ... } }`. The object below is the `data` payload.

```json
{
  "shortCode": "gY1k",
  "originalUrl": "https://example.com/very/long/url",
  "createdAt": "2026-04-18T12:34:56Z",
  "expiresAt": "2026-05-18T12:34:56Z",
  "totalClicks": 10500,
  "last7Days": 234,
  "last30Days": 1200,
  "dailyBreakdown": [
    {
      "date": "2026-04-18",
      "clicks": 150
    },
    {
      "date": "2026-04-17",
      "clicks": 84
    }
  ],
  "topReferrers": [
    {
      "referrer": "direct",
      "clicks": 5000
    },
    {
      "referrer": "twitter.com",
      "clicks": 3200
    },
    {
      "referrer": "linkedin.com",
      "clicks": 2300
    }
  ],
  "countries": [
    {
      "countryCode": "US",
      "countryName": "United States",
      "clicks": 6000
    },
    {
      "countryCode": "IN",
      "countryName": "India",
      "clicks": 2500
    },
    {
      "countryCode": "GB",
      "countryName": "United Kingdom",
      "clicks": 1000
    }
  ]
}
```

**Field Descriptions:**

| Field | Type | Description |
|-------|------|-------------|
| `shortCode` | string | The short code or custom alias |
| `originalUrl` | string | The target URL |
| `createdAt` | ISO8601 | When the short URL was created |
| `expiresAt` | ISO8601 \| null | When the short URL expires (null if no TTL) |
| `totalClicks` | integer | Total clicks since creation |
| `last7Days` | integer | Clicks in last 7 calendar days |
| `last30Days` | integer | Clicks in last 30 calendar days |
| `dailyBreakdown` | array | Array of `{ date, clicks }` for last 30 days (sorted descending) |
| `topReferrers` | array | Array of `{ referrer, clicks }` (top 10, sorted descending) |
| `countries` | array | Array of `{ countryCode, countryName, clicks }` (top 20, sorted descending) |

**Error Responses:**

| Status | Scenario | Response |
|--------|----------|----------|
| 401 | Not authenticated | `{ "error": "Unauthorized" }` |
| 404 | Short code not found OR doesn't belong to user | `{ "error": "Not found" }` |

**Performance SLA:**
- p99 < 500ms (analytics queries allowed to be slower than redirect)

**Notes:**
- Returns 404 for both "doesn't exist" and "doesn't belong to user" (information leakage prevention)
- `referrer` is parsed from HTTP `Referer` header; `direct` for no referrer
- `countryCode` only populated if geo lookup succeeded; null if failed
- No pre-aggregation in MVP (queries run on raw Click table)

---

## Health & Documentation

### GET /health

**Purpose:** Health check (no auth needed)

> **Envelope exemption:** `/health` is a liveness/readiness probe and intentionally
> does NOT use the standard `{ success, message, data }` success envelope. It returns
> the flat `{ status, db, timestamp }` shape below so monitoring/orchestration probes
> can read it directly. This is the only success-response exception in the API.

**Auth Required:** No

**Example Request:**
```bash
curl http://localhost:3000/health
```

**Response 200 (Healthy):**

```json
{
  "status": "ok",
  "db": "connected",
  "cache": "connected",
  "timestamp": "2026-04-18T12:34:56Z"
}
```

**Response 503 (Degraded):**

```json
{
  "status": "degraded",
  "db": "disconnected",
  "cache": "connected",
  "timestamp": "2026-04-18T12:34:56Z"
}
```

**Error Responses:**

| Status | Scenario |
|--------|----------|
| 200 | At least one dependency connected |
| 503 | All dependencies disconnected |

---

### GET /docs

**Purpose:** Swagger UI (interactive API documentation)

**Auth Required:** No

**Response:** HTML page with interactive API explorer

**Features:**
- Try requests directly in browser
- View request/response schemas
- See all routes, headers, error codes
- Auto-generated from Fastify schemas

---

## Global Headers

### Request Headers (All Authenticated Routes)

```
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### Response Headers (All Routes)

```
Content-Type: application/json
X-RateLimit-Limit: 100  (if rate-limited route)
X-RateLimit-Remaining: 99  (if rate-limited route)
X-RateLimit-Reset: 1713474060  (if rate-limited route)
```

---

## Authentication Bearer Token Example

**Access Token (JWT):**
```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJjdWlkMTIzIiwiZXhwIjoxNzEzNDcwMDAwfQ.sig
```

**How to Use:**
```bash
curl -X GET http://localhost:3000/api/urls \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Token Expiry:**
- Access token: 15 minutes
- If expired: use POST /api/auth/refresh to get new one
- Refresh token: 30 days (in httpOnly cookie)
