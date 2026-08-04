# Error Response Contract

**Status:** Locked (Pre-Implementation)  
**Last Updated:** 2026-08-04 (added 405 Method Not Allowed, 503 Service Unavailable, and 504
Gateway Timeout; added the duplicate-URL 409 scenario; added the 404-vs-405 note)

---

## Standard Error Response Shape

Every error response follows this JSON structure:

```json
{
  "error": "Human-readable error message",
  "details": { "field": "optional context object" },
  "retryAfter": 60
}
```

### Field Definitions

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `error` | string | ✅ Yes | Human-readable message; safe to show to end users |
| `details` | object | ❌ No | Structured data providing context (field name, allowed values, etc.) |
| `retryAfter` | integer | ❌ No | Only for 429 responses; seconds to wait before retry |

---

## HTTP Status Codes & Responses

### 400 Bad Request

**When:** Input validation fails, request is malformed

| Scenario | Response Body |
|----------|---|
| Invalid URL format | `{ "error": "Invalid URL format", "details": { "field": "url", "expected": "valid http/https URI" } }` |
| Password too short | `{ "error": "Password must be at least 8 characters", "details": { "field": "password", "minLength": 8 } }` |
| Passwords don't match | `{ "error": "Passwords do not match", "details": { "field": "confirmPassword" } }` |
| Alias format invalid | `{ "error": "Alias must be alphanumeric + hyphen only", "details": { "field": "customAlias", "pattern": "^[a-zA-Z0-9-]{3,50}$" } }` |
| Alias is reserved word | `{ "error": "Alias is reserved", "details": { "field": "customAlias", "reserved_words": ["api", "admin", "health", "docs", "static"] } }` |
| Missing required field | `{ "error": "Missing required field: url", "details": { "field": "url" } }` |

**HTTP Headers:**
```
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

---

### 401 Unauthorized

**When:** User is not authenticated or authentication failed

| Scenario | Response Body |
|----------|---|
| No auth header | `{ "error": "Unauthorized" }` |
| Invalid JWT token | `{ "error": "Unauthorized" }` |
| Access token expired | `{ "error": "Access token expired" }` |
| Refresh token invalid | `{ "error": "Refresh token invalid or expired" }` |
| Invalid credentials | `{ "error": "Invalid email or password" }` |

**HTTP Headers:**
```
HTTP/1.1 401 Unauthorized
Content-Type: application/json
WWW-Authenticate: Bearer realm="url-shortener"
```

**Notes:**
- Don't distinguish between "user not found" and "password wrong" (security)
- If using Bearer token, include `WWW-Authenticate` header

---

### 404 Not Found

**When:** Resource doesn't exist OR user doesn't have access (security)

| Scenario | Response Body | Why 404 |
|----------|---|---|
| Short code doesn't exist | `{ "error": "Not found" }` | Standard not found |
| User doesn't own short code | `{ "error": "Not found" }` | Information leakage prevention |
| Trying to access deleted URL | `{ "error": "Not found" }` | User shouldn't know it was deleted |
| Trying to view analytics for URL they don't own | `{ "error": "Not found" }` | Same URL might not exist OR might exist but not owned |

**HTTP Headers:**
```
HTTP/1.1 404 Not Found
Content-Type: application/json
```

**Critical Rule:**
Both "resource doesn't exist" and "resource exists but you can't access" return 404 with identical response body. This prevents enumeration attacks.

**404 vs 405 (added 2026-08-04, DECISIONS.md #23):** this resource-level 404 rule is distinct
from *method-level* responses. A known path called with an unsupported HTTP method (e.g.
`PATCH /api/auth/register`) now returns **405 + `Allow`** — the route exists, the method
doesn't. See the 405 section below. The route table is already public (Swagger `/docs`), so a
405 reveals nothing an attacker can't already read.

---

### 405 Method Not Allowed

**When:** A route exists at the requested path, but the HTTP method is unsupported (via
`setNotFoundHandler({ methodNotAllowed: true })` — Fastify sets `request.routerMethod`)

**Response:**

| Scenario | Response Body | Headers |
|----------|---|---|
| Route exists, method unsupported | `{ "error": "Method Not Allowed" }` | `Allow: GET, POST, ...` |

**HTTP Headers:**
```
HTTP/1.1 405 Method Not Allowed
Content-Type: application/json
Allow: POST, GET, DELETE
```

**Notes:**
- Always paired with the `Allow` header listing the methods the route actually supports.
- Added 2026-08-04 (DECISIONS.md #23). Applied to both `api` and `redirect` services.
- Distinct from 404 (resource-level "never reveal existence", DECISIONS.md #7).

---

### 410 Gone

**When:** Resource existed but is no longer available (URL expired or deleted)

| Scenario | Response Body |
|----------|---|
| URL expired (TTL) | `{ "error": "Short URL expired or deleted" }` |
| URL soft-deleted | `{ "error": "Short URL expired or deleted" }` |

**HTTP Headers:**
```
HTTP/1.1 410 Gone
Content-Type: application/json
Cache-Control: no-cache
```

**Difference from 404:**
- 404 = "resource never existed (or you can't access it)"
- 410 = "resource existed but is gone (client can update bookmarks)"

**Browser Behavior:**
- 404: browser might try again later
- 410: browser will remove bookmark (hint to stop trying)

---

### 409 Conflict

**When:** Request conflicts with current resource state (duplicate)

| Scenario | Response Body |
|----------|---|
| Email already registered | `{ "error": "Email already registered", "details": { "field": "email" } }` |
| Custom alias already in use | `{ "error": "Custom alias already in use", "details": { "field": "customAlias", "suggestedAlias": "my-project-2" } }` |
| Same URL already shortened by this user (auto-code path) | `{ "error": "Resource already exists" }` (added 2026-08-04, DECISIONS.md #22) |
| Unique constraint violation (any) | `{ "error": "Resource already exists", "details": { "constraint": "unique_alias" } }` |

**HTTP Headers:**
```
HTTP/1.1 409 Conflict
Content-Type: application/json
```

---

### 429 Too Many Requests

**When:** Rate limit exceeded

| Scenario | Response Body |
|----------|---|
| Rate limit exceeded | `{ "error": "Rate limit exceeded", "retryAfter": 3600 }` |

**HTTP Headers:**
```
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 3600
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1713470460
```

**Field Definitions:**

| Header | Meaning |
|--------|---------|
| `Retry-After` | Seconds to wait before next request |
| `X-RateLimit-Limit` | Total requests allowed in period (e.g., 100) |
| `X-RateLimit-Remaining` | Requests remaining in current period |
| `X-RateLimit-Reset` | Unix timestamp when limit resets |

**Client Behavior:**
Client should:
1. Read `Retry-After` or `X-RateLimit-Reset`
2. Wait that duration
3. Retry request

---

### 500 Internal Server Error

**When:** Unexpected server error

| Scenario | Response Body |
|----------|---|
| Database connection failure | `{ "error": "Internal server error" }` |
| Unexpected exception | `{ "error": "Internal server error" }` |
| Third-party API error (geo lookup) | `{ "error": "Internal server error" }` |

**HTTP Headers:**
```
HTTP/1.1 500 Internal Server Error
Content-Type: application/json
```

**Critical Rule:**
- **Development:** Include full stack trace in response body for debugging
- **Production:** NEVER include stack trace in response (only in logs via Pino)

**Example (Development):**
```json
{
  "error": "Internal server error",
  "stack": "Error: connection timeout\n    at pool.connect (/app/src/db/pool.js:45:23)\n    at..."
}
```

**Example (Production):**
```json
{
  "error": "Internal server error"
}
```

---

### 503 Service Unavailable

**When:** The service cannot serve requests temporarily — database connection failure
(Prisma P1001/P1017)

**Response:**

| Scenario | Response Body |
|----------|---|
| Database unreachable | `{ "error": "Service temporarily unavailable" }` |

**HTTP Headers:**
```
HTTP/1.1 503 Service Unavailable
Content-Type: application/json
Retry-After: 30
```

**Notes:**
- Added 2026-08-04 — the code already emitted this (both global error handlers map
  P1001/P1017), the contract simply never documented it.
- `Retry-After` gives clients a polite backoff instead of an immediate retry storm.

---

### 504 Gateway Timeout

**When:** The request exceeded the server's time budget — Prisma query timeout (P1008), or the
Fastify request-level timeout firing first

**Response:**

| Scenario | Response Body |
|----------|---|
| Database query exceeded its timeout | `{ "error": "Request timed out" }` |

**HTTP Headers:**
```
HTTP/1.1 504 Gateway Timeout
Content-Type: application/json
Retry-After: 5
```

**Notes:**
- Added 2026-08-04 (DECISIONS.md #24 — tiered timeout budget). The **app** produces the 504
  envelope with its own `Retry-After`; nginx's `proxy_read_timeout` is a backstop, not the
  first responder.
- P1008 is Prisma's "query timed out" error; the tiered budget adds a real Prisma
  `queryTimeout` so this mapping can actually fire.

---

## Rate Limit Headers (All Responses)

The following headers should be present in **every** successful response (200, 201, 204):

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1713470460
```

This allows clients to check rate limit status without making an extra request.

---

## Error Response Examples

### Example 1: Validation Error (400)

**Request:**
```http
POST /api/urls HTTP/1.1
Authorization: Bearer eyJhbGc...
Content-Type: application/json

{
  "url": "not a url",
  "customAlias": "my-project"
}
```

**Response:**
```http
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": "Invalid URL format",
  "details": {
    "field": "url",
    "expected": "valid http/https URI",
    "provided": "not a url"
  }
}
```

---

### Example 2: Rate Limited (429)

**Request:**
```http
POST /api/urls HTTP/1.1
Authorization: Bearer eyJhbGc...

{ "url": "https://example.com" }
```

**Response (101st request in the hour):**
```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 3600
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1713474060

{
  "error": "Rate limit exceeded",
  "retryAfter": 3600
}
```

---

### Example 3: Ownership Check (404)

**Request:**
```http
GET /api/analytics/xyz123 HTTP/1.1
Authorization: Bearer eyJhbGc...
```

**Response (short code doesn't exist OR belongs to different user):**
```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "Not found"
}
```

**Note:** Response is identical whether short code doesn't exist or user doesn't own it (information leakage prevention).

---

### Example 4: URL Expired (410)

**Request:**
```http
GET /xyz123 HTTP/1.1
```

**Response (URL expired or deleted):**
```http
HTTP/1.1 410 Gone
Content-Type: application/json
Cache-Control: no-cache

{
  "error": "Short URL expired or deleted"
}
```

---

### Example 5: Duplicate Email (409)

**Request:**
```http
POST /api/auth/register HTTP/1.1
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securePass123",
  "confirmPassword": "securePass123"
}
```

**Response (email already registered):**
```http
HTTP/1.1 409 Conflict
Content-Type: application/json

{
  "error": "Email already registered",
  "details": {
    "field": "email"
  }
}
```

---

## Implementation Checklist

Before calling an endpoint working:

- [ ] All error responses have `error` field (required)
- [ ] 400 errors include `details` with structured data (when applicable)
- [ ] 404 returns same response for "not found" and "unauthorized"
- [ ] 429 includes `Retry-After` and `X-RateLimit-*` headers
- [ ] 500 errors never include stack trace in production
- [ ] Rate limit headers on all 2xx responses
- [ ] Error messages are user-friendly (not cryptic)
- [ ] No sensitive information in error messages (DB details, internal paths)
