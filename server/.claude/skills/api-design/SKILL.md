# API Design Skill for URL Shortener

## Quick Rules (read first — full spec in ../docs/notes/API_CONTRACT.md)

- **Auth routes** return `{ user: { id, email }, accessToken }` + `Set-Cookie: refreshToken` (httpOnly, 30-day)
- **POST /api/urls** → 201 with `{ shortCode, shortUrl, originalUrl, customAlias, createdAt, expiresAt }`
- **GET /api/urls** → 200 with `{ urls: [...], total }` — clickCount aggregated, `isDeleted:false` always, deleted excluded
- **DELETE /api/urls/:shortCode** → 204 no body — soft delete only (`is_deleted = true`), clear Valkey cache
- **GET /:shortCode** → 302 with `Location` + `Cache-Control: no-cache` — click enqueued async, never awaited
- **GET /api/analytics/:shortCode** → 200 with exact shape from API_CONTRACT.md §Analytics (dailyBreakdown, topReferrers, countries)
- **Error envelope**: `{ "error": "string", "details"?: {}, "retryAfter"?: number }` — no other keys
- **Rate limit headers** on ALL 2xx responses from `POST /api/urls`: `X-RateLimit-Limit / Remaining / Reset`
- **Ownership check** → scope DB query by `shortCode + userId` — return 404 if null (never 403)
- **Reserved aliases** → `api`, `health`, `docs`, `admin`, `static` — reject 400 before DB write
- **customAlias** pattern: `^[a-zA-Z0-9-]{3,50}$`; **ttlDays**: integer 1–365; **URL**: http/https only, max 2048 chars

---

This skill helps implement API endpoints according to the URL shortener system's API contract. It ensures consistency with the documented API specifications, error handling patterns, and authentication requirements.

## When to Use This Skill

Use this skill when implementing or modifying API routes in the URL shortener project, particularly:
- Creating new endpoints that follow the API contract
- Implementing authentication flows (register, login, refresh, logout)
- Building URL management endpoints (shorten, list URLs, delete URLs)
- Adding analytics endpoints
- Implementing error responses according to the ERROR_CONTRACT.md
- Adding proper rate limiting headers and response formats
- Ensuring security practices like information leakage prevention

## API Implementation Guidelines

### 1. Follow the API Contract
All endpoints must match the specifications in `../docs/notes/API_CONTRACT.md`:
- Use correct HTTP methods and paths
- Match request/response schemas exactly
- Include proper status codes (200, 201, 204, 400, 401, 404, 409, 410, 429, 500)
- Return appropriate headers (X-RateLimit-*, Set-Cookie for auth)

### 2. Authentication Implementation
- Use JWT for access tokens (15-minute expiry)
- Use HTTP-only cookies for refresh tokens (30-day expiry)
- Protect routes with Bearer token validation
- Don't distinguish between "user not found" and "wrong password" for security
- Implement proper logout that revokes refresh tokens

### 3. Error Handling
Follow `../docs/notes/ERROR_CONTRACT.md` strictly:
- All errors: `{ "error": "message", "details": {...} }` structure
- 400 errors include field-specific details
- 404 returns identical response for "not found" vs "access denied" 
- 410 for expired/deleted URLs (different from 404)
- 429 includes retryAfter and rate limit headers
- 500 errors never include stack traces in production
- Rate limit headers on ALL 2xx responses

### 4. Route-Specific Requirements

#### Auth Routes
- POST /api/auth/register: Validate email format, password strength, matching confirmPassword
- POST /api/auth/login: Validate credentials, set httpOnly refreshToken cookie
- POST /api/auth/refresh: Validate refreshToken cookie, issue new access/refresh tokens
- POST /api/auth/logout: Require auth, revoke refreshToken, clear cookie

#### URL Management
- POST /api/urls: Require auth, validate URL, optional customAlias/ttlDays, rate limit 100/hr
- GET /api/urls: Require auth, return user's URLs with click counts
- DELETE /api/urls/:shortCode: Require auth, verify ownership, soft-delete, clear cache

#### Redirect Route
- GET /:shortCode: No auth, 302 redirect, async click tracking, caching strategy

#### Analytics Route
- GET /api/analytics/:shortCode: Require auth, ownership verification, return analytics data

### 5. Security Practices
- Prevent information leakage: Use 404 for both "not found" and "access denied"
- Validate all inputs: URL format, alias patterns, TTL ranges
- Use parameterized queries to prevent SQL injection
- Implement proper CORS headers
- Sanitize user data before storing/returning

### 6. Performance Considerations
- Implement caching strategy for redirect route (Valkey first, then DB)
- Enqueue analytics events asynchronously (don't block redirect response)
- Set appropriate Cache-Control headers
- Implement rate limiting where specified
- Use efficient database queries with proper indexing

## Implementation Steps

1. Review the specific endpoint contract in API_CONTRACT.md
2. Create route handler with proper authentication middleware
3. Implement input validation according to schema
4. Add business logic (database operations, cache interactions)
5. Implement error handling per ERROR_CONTRACT.md
6. Add required response headers (especially rate limit headers)
7. Write unit tests covering success and error cases
8. Verify implementation matches documentation exactly

## Files to Modify

When implementing API endpoints, you'll typically work with:
- `src/api/routes/` - Route definitions
- `src/api/controllers/` - Business logic handlers
- `src/api/middleware/` - Auth, validation, rate limiting middleware
- `src/shared/utils/` - Helper functions (validation, token handling)
- `src/config/` - Configuration (rate limits, JWT secrets)
- `src/jobs/` - BullMQ processors for async tasks (click tracking)

## Validation Rules to Implement

- Email: Valid email format, max 255 chars
- Password: Min 8 chars, max 128 chars, at least one letter + one number
- URL: Valid http/https URI, max 2048 chars
- customAlias: Alphanumeric + hyphen, 3-50 chars, not reserved
- ttlDays: Integer 1-365
- Reserved words: api, health, docs, admin, static

## Testing Guidelines

Test both positive and negative cases:
- Valid requests return correct 2xx responses with proper data
- Invalid requests return appropriate 4xx errors with details
- Auth-protected routes return 401 without valid token
- Ownership-protected routes return 404 for non-owned resources
- Rate limiting returns 429 with proper headers
- Edge cases are handled gracefully

This skill ensures API implementation consistency with the documented contracts and best practices.