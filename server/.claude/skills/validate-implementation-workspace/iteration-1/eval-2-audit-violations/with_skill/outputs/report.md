# Implementation Compliance Report -- Violations Focus

## 1. API Contract Compliance

### Violations
- V1 `app.ts:53/57/61...` -- ALL error responses include `success: false` field (not in spec)
- V2 `routes/url.ts:154` + `utils/api-response.ts:6-10` -- 201 success response wrapped in { success, message, data }
- V3 `routes/url.ts:88-93` -- validation 400 error details is raw Zod issues array (wrong shape)
- V4 `routes/url.ts:48-55` -- expiresAt NEVER null; no-TTL case broken (CRITICAL data correctness)
- V5 `routes/health.ts:7-13` -- health route uses try-catch around DB query
- V6 `routes/health.ts:9,12` -- health response field values wrong (ok vs connected, error vs degraded)

### Not Yet Implemented
- GET /api/urls, DELETE /api/urls/:shortCode, GET /:shortCode, GET /api/analytics/:shortCode
- All four auth routes

## 2. Error Response Envelope

### Violations
- V7 `utils/api-response.ts:16` -- ApiError interface has `success: false` field (root cause)
- V8 `utils/api-response.ts:6-10` -- ApiSuccess wraps data in { success, message, data }
- V9 `app.ts` global handler -- every reply.send call includes `success: false` (9 places)

### Compliant
- `middleware/auth.ts` -- correctly uses bare { "error": "Unauthorized" } -- no success field

## 3. Exception Handling Architecture

### Violations
- V10 `routes/health.ts:7-13` -- try-catch wraps DB query in route handler
- V11 `routes/url.ts:85-93` -- Zod safeParse inside handler bypasses Layer 1 (Fastify schema gate)

## 4. Project Structure

### Violations
- V12 Missing `src/plugins/` directory
- V13 Missing `src/services/` directory
- V14 Missing `src/schemas/` directory

## 5. System Design Decisions

### Violations
- V15 `routes/url.ts:48-55` -- TTL=null when not provided is broken (same as V4)
- V16 `config.ts:7` -- hardcoded JWT_SECRET fallback (security risk)

## 6. Prisma Error Mapping

### Violations
- V17 ALL Prisma error responses include `success: false`
- V18 P2016 not explicitly handled with required ERROR-level log
- V19 No Fastify validation error.validation branch

## Priority Fix List (violations only)
1. [CRITICAL] Remove `success` field from ALL error responses -- api-response.ts + app.ts (9 places)
2. [CRITICAL] Remove { success, message, data } wrapper from ALL success responses
3. [CRITICAL] Fix expiresAt: null when no ttlDays -- routes/url.ts:48-55
4. [HIGH] Remove try-catch from routes/health.ts
5. [HIGH] Fix health response field values (connected/disconnected/degraded/cache)
6. [HIGH] Fix validation 400 details shape (field name, not raw Zod array)
7. [MEDIUM] Add P2016 explicit branch with ERROR log
8. [MEDIUM] Add error.validation branch to global error handler
9. [MEDIUM] Remove hardcoded JWT_SECRET fallback -- config.ts:7
