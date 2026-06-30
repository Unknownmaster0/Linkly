# Error Handling Skill for URL Shortener

## Quick Rules (read first — full spec in docs/notes/exception-handling-strategy.md)

- **Six layers**: Validation (Fastify schema) → Auth preHandler → Route (thin) → Service (throws) → Prisma (bubbles) → Global handler (one place)
- **Route handlers**: ZERO try-catch for business or DB logic — if you're adding a catch block in a route, stop and reconsider
- **Error hierarchy**: `AppError` → `ValidationError(400)` | `AuthError(401)` | `OwnershipError(404)` | `NotFoundError(404)` | `BusinessRuleError(409)` | `ConflictError(409)` | `RateLimitError(429)`
- **OwnershipError → 404 always, never 403** — 403 reveals the resource exists (IDOR attack surface)
- **Prisma P1xxx** (P1001, P1017, P1008) → 5xx + `Retry-After` header (infrastructure failure)
- **Prisma P2002** → 409 Conflict | **P2025, P2015** → 404 | **P2016** → 500 + ERROR log (code bug, fix immediately)
- **Prisma P2003, P2004, P2005, P2006, P2011, P2014** → 400 Bad Request
- **BullMQ worker P2003** → discard job silently (URL deleted — retrying always fails, don't alert)
- **Geo lookup failure** → `country: null` fallback, save click record, log DEBUG (never fail the job)
- **5xx responses**: generic message only — Prisma errors, stack traces, DB details NEVER in response body
- **Redirect route** (`/:shortCode`): use `findUnique()` + null check inline — no exceptions in hot path

---

This skill implements the comprehensive error handling strategy documented in the URL shortener project. It ensures consistent error classification, proper HTTP status mapping, security-conscious responses, and appropriate logging levels according to the exception handling strategy.

## When to Use This Skill

Use this skill when implementing or modifying error handling in the URL shortener project, particularly:
- Setting up global error handlers in Fastify applications
- Implementing custom error classes following the documented hierarchy
- Handling Prisma errors according to their specific codes and recommended responses
- Ensuring security practices like information leakage prevention (always returning 404 for ownership mismatches)
- Implementing appropriate retry logic with Retry-After headers
- Setting up proper logging levels (ERROR, WARN, INFO, DEBUG) for different error types
- Handling BullMQ worker errors according to their specific classifications

## Error Handling Guidelines

### 1. Failure Classification Principle
Every failure must be classified as either:
- **Exceptional Failures**: Infrastructure issues that must not happen under normal operation (P1xxx Prisma errors, connection drops, etc.)
- **Expected Outcomes**: Normal business logic results (4xx errors like not found, validation errors, etc.)

> The measure of correctness: exceptional failures wake someone up at 2am. Expected outcomes do not.

### 2. Six-Layer Architecture
Errors must be handled at the appropriate layer:

1. **Layer 1 - Validation Gate**: Fastify JSON Schema validation (no try-catch here)
2. **Layer 2 - Auth Pre-condition**: authenticate middleware (401/404 responses)
3. **Layer 3 - Route Handlers**: Thin handlers with ZERO try-catch for business logic
4. **Layer 4 - Service/Business Logic**: Throw typed custom errors only
5. **Layer 5 - Prisma/DB**: Let Prisma errors bubble up (don't catch in service layer)
6. **Layer 6 - Global Error Handler**: ONE place that maps everything to HTTP responses

### 3. Custom Error Hierarchy
Implement this error class structure:
```
AppError (base)
├── ValidationError       → HTTP 400   code: VALIDATION_FAILED
├── AuthError             → HTTP 401   code: UNAUTHORIZED
├── OwnershipError        → HTTP 404   code: NOT_FOUND          ← always 404, never 403
├── NotFoundError         → HTTP 404   code: NOT_FOUND
├── BusinessRuleError     → HTTP 409   code: BUSINESS_RULE_VIOLATED
├── ConflictError         → HTTP 409   code: CONFLICT
└── RateLimitError        → HTTP 429   code: RATE_LIMIT_EXCEEDED
```

Each custom error must carry:
- HTTP status (so handler doesn't guess)
- Error code (machine-readable for clients/logs)
- Human-readable message (safe to expose)
- Optional context (for logs, never sent to client)

### 4. Critical Security Rules
- **OwnershipError always returns 404, never 403** - prevents IDOR attacks
- **Never distinguish between "not found" and "access denied"** - both return 404
- **5xx responses NEVER expose Prisma messages, stack traces, or internal details**
- **Always return generic safe messages for 5xx errors**

### 5. Prisma Error Mapping (Global Handler)
Follow this exact mapping in your global error handler:

**Connection Errors (P1xxx) → 5xx with Retry-After:**
- P1001, P1017: 503 + Retry-After: 30
- P1008: 504 + Retry-After: 5

**Data/Constraint Errors (P2xxx) → 4xx:**
- P2002: 409 Conflict (inspect meta.target for field)
- P2003, P2004, P2005, P2006, P2011, P2014: 400 Bad Request
- P2015, P2025: 404 Not Found
- P2016: 500 Internal Server Error (code bug - log immediately)
- P2034: 409 Conflict + Retry-After: 1

**Fastify Validation Errors:**
- If error.validation present: 400 with validation details

### 6. Route Handler Requirements
Route handlers MUST:
- Contain ZERO try-catch blocks for business logic or database operations
- Have exactly two responsibilities:
  1. Extract validated input from request
  2. Call service and return result
- Let all errors propagate to global handler
- For expected outcomes like "not found" in hot paths, use explicit null checks instead of exceptions

### 7. BullMQ Worker Error Handling
In click workers, handle errors specifically:
- **P2003 (FK violation)**: Discard job, log WARN, do NOT retry (URL gone)
- **Geo lookup failure**: Fallback to country=null, log DEBUG, save click
- **Prisma connection failures (P1001, P1008, P1017)**: Let BullMQ retry with backoff
- **Uncaught exceptions**: Log full ERROR, exit cleanly (PM2 restarts)
- **Exhausted retries**: Job to failed set, alert, manual investigation

### 8. Retry Boundaries
Only retry these errors:
- **P1001, P1008, P1017, P1008**: Yes (infrastructure) - exponential backoff
- **P2034 (write conflict/deadlock)**: Yes - brief delay, max 3 attempts

Never retry:
- **P2002** (unique constraint) - input won't change
- **P2003** (FK in worker) - parent record gone
- **P2025** (record not found) - record doesn't exist
- **P2016** (query bug) - code bug
- Geo lookup failures - fallback to null instead

### 9. Logging Strategy
Match log levels to error classifications:
- **ERROR level**: Exceptional failures (P1xxx, P2016, worker crashes) + full stack trace
- **WARN level**: Expected outcomes that are noteworthy (P2002, P2003 in worker, etc.)
- **INFO level**: Expected normal outcomes (P2025 in some contexts)
- **DEBUG level**: Transient expected behaviors (geo lookup failures)

Every error log must include:
- error.code (Prisma code or custom error code)
- error.message (full internal message)
- error.meta (Prisma metadata)
- request.method + request.url
- request.user.userId (if authenticated)
- Stack trace (for ERROR level only)

### 10. Response Body Standards
**For 4xx errors (safe to describe):**
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable message"
}
```

**For 5xx errors (never describe internals):**
```json
{
  "error": "INTERNAL_ERROR",
  "message": "Something went wrong. Please try again."
}
```

Never expose: Prisma messages, stack traces, DB queries, environment variables, internal paths.

### 11. Anti-Patterns to Avoid
- **Silent Swallow**: catch (error) { /* do nothing */ }
- **Catch-and-Log-But-Continue**: Logging then continuing in potentially corrupt state
- **Everywhere try-catch**: Duplicating catch logic across layers
- **Generic catch (Exception)**: Returning 500 for everything loses actionable info
- **Exceptions for Expected Outcomes**: Using exceptions for routine behavior like "not found"
- **Exposing Internals**: return reply.code(500).send({ error: error.message })

### 12. Validation Gate Implementation (Layer 1)
Use Fastify JSON Schema on every route body to enforce:
- `url`: format: 'uri' (valid URI format)
- `customAlias`: pattern + minLength/maxLength (alphanumeric + hyphens, 3-20 chars)
- `ttlDays`: type: integer with minimum/maximum (1-365)
- `email`: format: 'email'
- `password`: minLength: 6
- Required fields: required: [...] array

This layer prevents Prisma errors P2005/P2006 from reaching production - if they appear, fix the validation gap.

### 13. Auth Middleware as Pre-condition (Layer 2)
The authenticate middleware verifies:
- JWT present in Authorization header
- JWT signature valid against JWT_SECRET
- JWT not expired (15-minute window)
- JWT payload contains userId and email

Failure behaviors:
- JWT missing/expired/invalid: 401 Unauthorized (auth middleware)
- Valid JWT but wrong ownership: 404 Not Found (service layer - OwnershipError)

### 14. Route Handler Patterns (Layer 3)
**Redirect route (hot path - must stay under 10ms p99):**
```javascript
1. Extract shortCode from URL params
2. Check Valkey cache → if hit, proceed to step 5
3. Check DB (Prisma findUnique) → if null, return 404 inline
4. Check expiresAt → if expired, return 410 inline
5. Queue click event (fire and forget, never awaited)
6. Return 302 redirect
```
**NO try-catch blocks**

**Shorten route:**
```javascript
1. Extract url, customAlias?, ttlDays? from validated body
2. Extract userId from request.user (set by auth middleware)
3. Call shortenService.create(...)
4. Return 201 with shortUrl
```
Service layer throws if alias taken - global handler catches it.

### 15. Result Objects for Expected Outcomes (Layer 5)
Use explicit null checks instead of exceptions for expected outcomes:
- **Redirect route**: findUnique() returns null → check explicitly → 404/410 inline
- **Avoid**: findUniqueOrThrow() in hot paths (exception overhead for expected misses)

Use exceptions only when caller reasonably expects record to exist:
- Analytics/Delete routes: scoped query (shortCode + userId) → null → OwnershipError → 404
- Internal services expecting records: findUniqueOrThrow() → P2025 → global handler

## Implementation Checklist

Before considering error handling complete:
- [ ] Global error handler registered once in app.js (not per-route)
- [ ] Route handlers contain ZERO try-catch for business/database logic
- [ ] Custom error hierarchy implemented with proper status codes
- [ ] OwnershipError always returns 404, never 403
- [ ] 5xx responses never expose internal details
- [ ] Prisma errors mapped correctly per error code table
- [ ] Fastify validation errors handled properly (400 with details)
- [ ] Rate limit headers included on ALL 2xx responses
- [ ] BullMQ worker handles P2003 by discarding job (no retry)
- [ ] Logging levels match error classifications (ERROR/WARN/INFO/DEBUG)
- [ ] No sensitive information in error responses (security)
- [ ] Retry-After headers present where appropriate (5xx, 429, 409 conflicts)
- [ ] Response bodies follow standard format for 4xx vs 5xx errors

## Files to Modify

When implementing error handling, you'll typically work with:
- `src/app.js` - Global error handler registration
- `src/shared/errors/` - Custom error classes (AppError subclasses)
- `src/api/middleware/` - Auth middleware, validation middleware
- `src/api/controllers/` - Route handlers (thin, no try-catch)
- `src/shared/services/` - Business logic (throws custom errors only)
- `src/jobs/` - BullMQ processors with worker-specific error handling
- `src/config/` - Error handler configuration (retry times, etc.)
- `src/shared/utils/logger.js` - Centralized logging if used

## Validation Rules from API Contract

Implement these validations in your JSON schemas:
- Email: Valid email format, max 255 chars
- Password: Min 8 chars, max 128 chars, at least one letter + one number
- URL: Valid http/https URI, max 2048 chars
- customAlias: Alphanumeric + hyphen, 3-50 chars, not reserved (api, health, docs, admin, static)
- ttlDays: Integer 1-365
- Required fields: Properly marked in schemas

This skill ensures error handling consistency with the documented strategies and prevents common pitfalls that lead to silent failures or security vulnerabilities.