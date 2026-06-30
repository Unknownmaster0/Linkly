# Exception Handling Strategy — URL Shortener + Analytics

> **Stack:** Fastify · Prisma · PostgreSQL · Valkey · BullMQ · Next.js  
> **Audience:** Engineering reference — system design decisions, not implementation syntax.  
> **Purpose:** Define where, how, and why every failure in this system is handled — so that nothing disappears silently, and nothing is handled in the wrong layer.

---

## The Guiding Principle

Exception handling is a **categorization problem before it is a coding problem.**

The wrong question: *"Where do I put the try-catch?"*  
The right question: ***"Is this failure exceptional or expected?"***

Every design decision in this document flows from answering that question correctly for every failure mode in the system.

> **Wrapping everything in try-catch is not defensive programming. It is fear-based programming.**  
> It does not protect the system — it hides failures from the system.  
> The goal is for errors that should be loud to be loud, and errors that are expected to be handled quietly and correctly. Nothing disappears silently into an empty catch block.

---

## The Two Failure Categories

Before writing a single line of error handling code, every failure in the system must be classified into one of two buckets.

### Exceptional Failures
Things that **must not happen** under normal operation. When they occur, they signal that something outside the application's control has broken.

| Failure | Why It's Exceptional |
|---|---|
| PostgreSQL connection drops (P1001, P1017) | Infrastructure failure — not caused by request data |
| DB operation timeout (P1008) | Infrastructure or missing index — not a client error |
| Valkey unreachable | Rate limiter loses its shared state — system integrity at risk |
| BullMQ worker crash | Job processing pipeline down — data loss risk |
| Prisma query structurally malformed (P2016) | This is a code bug — must never reach production |
| Unclassified runtime crash | Unknown failure — must be logged loudly with full context |

**Response strategy:** 5xx status codes, `Retry-After` headers where applicable, `ERROR`-level logs, monitoring alerts.

### Expected Outcomes
Normal results of valid business logic. These are **not bugs** — they are predictable states the system will enter during routine operation.

| Outcome | Why It's Expected |
|---|---|
| Short code not found in DB | Any unregistered code will trigger this |
| URL has expired (`expiresAt` in the past) | TTL-based expiry is a designed feature |
| Custom alias already taken (P2002) | User collision — documented in product behaviour |
| User requests analytics for a URL they don't own | Normal access control boundary |
| Click job arrives for a soft-deleted URL (P2003) | Race condition between delete and async worker — by design |
| Login with wrong password | Normal auth flow — not a system error |
| Duplicate registration email | Normal user flow — not a system error |

**Response strategy:** 4xx status codes (or inline `null` checks), `WARN`-level logs at most, no alerts, no stack traces.

> The measure of whether this classification is correct: **exceptional failures wake someone up at 2am. Expected outcomes do not.**

---

## The Six-Layer Architecture

Errors are handled at the layer where they belong — not wherever it's most convenient.

```
Request
   │
   ▼
[Layer 1]  Validation Gate         — Fastify JSON Schema
   │
   ▼
[Layer 2]  Auth Pre-condition      — authenticate preHandler
   │
   ▼
[Layer 3]  Route Handler           — thin, zero try-catch for business logic
   │
   ▼
[Layer 4]  Service / Business Logic — throws typed custom errors only
   │
   ▼
[Layer 5]  Prisma / DB             — throws Prisma errors, bubbles up
   │
   ▼
[Layer 6]  Global Error Handler    — ONE place, maps everything to HTTP
```

Violations of this layering — catching errors in the wrong layer, duplicating catch logic across routes — are the source of the silent failure modes described in the introduction.

---

## Layer 1 — Validation Gate

### Design Decision

> *"If you're catching an exception caused by bad input, you have a validation problem — not an exception handling problem."*

Fastify's JSON Schema on every route body is the validation gate. It is the first and hardest wall. **Nothing structurally invalid ever reaches the service layer.**

### What This Gate Enforces

| Field | Constraint | Enforced By |
|---|---|---|
| `url` | Valid URI format | `format: 'uri'` in schema |
| `customAlias` | Alphanumeric + hyphens, 3–20 chars | `pattern` + `minLength` / `maxLength` |
| `ttlDays` | Integer, 1–365 | `type: integer`, `minimum`, `maximum` |
| `email` | Valid email format | `format: 'email'` |
| `password` | Minimum 6 characters | `minLength: 6` |
| Required fields | Must be present | `required: [...]` array |

### Strategic Consequence

**Prisma errors `P2005` and `P2006` (type mismatch, invalid value) must be impossible in production** if this layer is working correctly. If they appear in production logs, it means the schema validation has a gap. The fix is to close the schema gap — not to add a catch block for the Prisma error.

Seeing `P2011` (null constraint) on `userId` in production means the `authenticate` middleware was not applied to a route. This is a deployment configuration bug, caught here in principle, not a runtime error to handle with try-catch.

### What the Validation Error Response Looks Like

```
HTTP 400 Bad Request
{
  "error": "VALIDATION_FAILED",
  "details": "url: must be a valid URI, ttlDays: must be between 1 and 365"
}
```

No stack trace. No Prisma internals. No generic "something went wrong."

---

## Layer 2 — Auth Middleware as a Pre-condition

### Design Decision

The `authenticate` preHandler is **not error handling**. It is a pre-condition assertion — it verifies that the request is authorized to proceed before a single line of business logic runs.

This distinction matters architecturally. Error handling is reactive — something went wrong, handle it. Pre-condition checking is preventive — assert the world is in the right state before proceeding.

### What It Enforces

- JWT present in `Authorization: Bearer <token>` header
- JWT signature valid against `JWT_SECRET`
- JWT not expired (access token: 15-minute window)
- JWT payload contains `userId` and `email`

### Failure Behaviour

| Condition | Response | Layer |
|---|---|---|
| JWT missing | `401 Unauthorized` | Auth middleware — request rejected here |
| JWT expired | `401 Unauthorized` | Auth middleware — request rejected here |
| JWT invalid signature | `401 Unauthorized` | Auth middleware — request rejected here |
| Valid JWT, but resource owned by another user | `404 Not Found` | Service layer — `OwnershipError` |

The ownership case is `404` — not `401` and not `403`. See [OwnershipError](#ownershiperror--always-404-never-403) below.

---

## Layer 3 — Route Handlers Are Thin by Design

### Design Decision

**Route handlers must contain zero try-catch blocks for business logic or database operations.**

A route handler has exactly two responsibilities:

1. Extract validated input from the request
2. Call the service and return the result

That is the complete contract. When a route handler contains try-catch for business or database logic, it is doing the global error handler's job — badly, inconsistently, and in a way that is invisible to the rest of the system.

### What a Correct Route Handler Looks Like Conceptually

**Redirect route** (the hot path — must stay under 10ms p99):

```
1. Extract shortCode from URL params
2. Look up in cache (Valkey) → if hit, proceed to step 5
3. Look up in DB (Prisma findUnique) → if null, return 404 inline
4. Check expiresAt → if expired, return 410 inline
5. Queue click event — fire and forget, never awaited
6. Return 302 redirect
```

No catch blocks. No try-catch around the Prisma call. Exceptional infrastructure failures (Valkey down, DB connection lost) propagate upward to the global handler — where they belong.

**Shorten route:**

```
1. Extract url, customAlias?, ttlDays? from validated body
2. Extract userId from request.user (set by auth middleware)
3. Call shortenService.create(...)
4. Return 201 with shortUrl
```

The service layer throws if the alias is taken. The global handler catches it. The route handler is unaware.

### The Rule

> If you are writing the same catch block in more than one route handler, you need a global error handler — not more catch blocks.

---

## Layer 4 — Custom Error Hierarchy

### Design Decision

Rather than catching generic errors and inferring what happened, the service layer throws **self-describing errors** that carry their HTTP status, error code, and context with them.

When a `BusinessRuleError` is thrown, you already know what failed, why it failed, and what HTTP status to return. Zero guesswork. Zero log archaeology.

### The Error Hierarchy

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

Every custom error carries:
- **HTTP status** — so the global handler doesn't have to guess
- **Error code** — machine-readable, for client-side logic and log filtering
- **Message** — human-readable, safe to expose in the response body
- **Context** (optional) — structured metadata for log enrichment, never sent to the client

### Error Usage by Route

| Route | Error Thrown | Trigger |
|---|---|---|
| `POST /api/urls` | `BusinessRuleError` | Custom alias already exists |
| `POST /api/urls` | `RateLimitError` | Token bucket exhausted |
| `POST /api/auth/register` | `ConflictError` | Email already registered |
| `GET /api/analytics/:code` | `OwnershipError` | URL exists but belongs to another user |
| `DELETE /api/urls/:code` | `OwnershipError` | URL exists but belongs to another user |
| `GET /api/urls` | — | No errors expected (returns empty array if none) |

### OwnershipError — Always 404, Never 403

This is the most security-critical decision in the error hierarchy.

**The wrong pattern:** Check if the URL exists, then check if the user owns it, return `403 Forbidden` if they don't.

**The problem:** `403` tells the requester "this resource exists but you can't access it." This is an information leak. An attacker can enumerate valid short codes by probing for `403` vs `404` responses.

**The correct pattern:** Scope the DB query by both `shortCode` AND `userId`. If no record matches — whether because the code doesn't exist or because it belongs to someone else — the query returns `null`. Throw `OwnershipError`. Return `404`. The requester learns nothing about whether the resource exists.

This is IDOR (Insecure Direct Object Reference) prevention. It is a deliberate architectural decision, not a mistake.

---

## Layer 5 — Result Objects for Expected Non-Error Outcomes

### Design Decision

> *"Not every failure is exceptional. Using exceptions for normal outcomes is like calling an ambulance to get to work."*

Some outcomes in this system are **not failures at all** — they are normal business results that happen to be negative. These do not belong in the exception hierarchy. They belong in explicit control flow.

### Where Result Objects Apply in This System

**The redirect route** is the primary case. This is the hot path — every millisecond matters. Throwing and catching exceptions has measurable overhead (stack unwinding). More importantly, "short code not found" is not an exception — it is a routine outcome that will happen thousands of times per day for mistyped or expired links.

The correct pattern:

```
urlRecord = findUnique(shortCode)   // returns null — no exception thrown

if urlRecord is null → return 404 inline
if urlRecord.expiresAt is past → return 410 inline
```

This is explicit, readable, zero-overhead, and honest about what is actually happening.

### Where Exceptions ARE Correct

`NotFoundError` is thrown (rather than returning a Result) in cases where the calling code has reasonable expectation that the record should exist — such as `findUniqueOrThrow()` in a context where the record was just validated. The distinction:

| Context | Pattern | Reason |
|---|---|---|
| Redirect route lookup | `findUnique()` + null check | Hot path, expected miss, inline response |
| Analytics route ownership check | Scoped query + null → `OwnershipError` | Security-critical, always 404 |
| Internal service expecting record to exist | `findUniqueOrThrow()` → `P2025` → global handler | Defensive — record should exist; if not, it's noteworthy |

---

## Layer 6 — Global Error Handler

### Design Decision

**Every exception that escapes a route handler is caught here, and only here.**

This is the direct equivalent of `@ControllerAdvice` + `@ExceptionHandler` in Spring. It is registered once in `app.js`. Route handlers are completely unaware of it — they throw or propagate, and the handler takes care of the rest.

### The Handler's Four Jobs

1. **Classify the error** — custom `AppError`? Prisma error code? Fastify validation error? Unclassified crash?
2. **Map to HTTP status** — deterministically, from error type or Prisma error code
3. **Log appropriately** — at the right level, with the right context
4. **Return a sanitized response** — never expose Prisma messages, stack traces, or internal codes

### Classification Map

| Error Source | Condition | HTTP Status | Log Level |
|---|---|---|---|
| Custom `AppError` subclass | `error instanceof AppError` | `error.status` (from hierarchy) | `WARN` |
| Prisma `P1001`, `P1017` | DB unreachable / connection dropped | `503` + `Retry-After: 30` | `ERROR` |
| Prisma `P1008` | Operation timeout | `504` + `Retry-After: 5` | `ERROR` |
| Prisma `P2002` | Unique constraint violated | `409` | `WARN` |
| Prisma `P2003` | Foreign key violated | `400` | `WARN` |
| Prisma `P2004`, `P2005`, `P2006` | Constraint / type error | `400` | `WARN` |
| Prisma `P2011`, `P2014` | Null / relation constraint | `400` | `WARN` |
| Prisma `P2015`, `P2025` | Record not found | `404` | `INFO` |
| Prisma `P2016` | Query interpretation bug | `500` | `ERROR` — code bug |
| Prisma `P2034` | Write conflict / deadlock | `409` + `Retry-After: 1` | `WARN` |
| Fastify validation | `error.validation` present | `400` | `INFO` |
| Unclassified | Everything else | `500` | `ERROR` + full stack |

### What the Response Body Contains

**For 4xx errors (safe to describe):**
```json
{
  "error": "CONFLICT",
  "message": "A URL with this alias already exists."
}
```

**For 5xx errors (never describe internals):**
```json
{
  "error": "INTERNAL_ERROR",
  "message": "Something went wrong. Please try again."
}
```

The Prisma error message, the stack trace, the DB query, the environment variable name — none of this ever reaches the API consumer. It belongs in the logs.

### What the Logs Contain (That the Response Does Not)

For every error that passes through the global handler, the log entry includes:

- `error.code` — Prisma code or custom error code
- `error.message` — full internal message
- `error.meta` — Prisma metadata (which field, which constraint)
- `request.method` + `request.url` — which route triggered it
- `request.user.userId` — if authenticated (for audit trail)
- Stack trace — for `ERROR`-level events only

This is what makes the error handler useful for operations: the response tells the client what to do next, and the log tells the engineer exactly what broke.

---

## The BullMQ Worker — A Separate Error Domain

### Design Decision

The click worker is not an HTTP context. There is no request, no reply, no global HTTP error handler. **It is its own error handling domain and must be treated as such.**

The same classification principle applies — but the response strategies are different because the "response" is either retrying the job or discarding it.

### Worker Error Classification

| Failure | Classification | Strategy | Log Level |
|---|---|---|---|
| `P2003` — URL was deleted between enqueue and processing | Expected | Discard job. Do not retry. | `WARN` |
| Geo lookup failure (ip-api.com unreachable) | Expected | Fall back to `country: null`. Save the click record without enrichment. | `DEBUG` |
| Prisma connection failure during write (P1001, P1017) | Exceptional | Let BullMQ retry with exponential backoff. Job is preserved. | `ERROR` |
| Worker process uncaught exception | Exceptional | Log full error. Exit cleanly. PM2 restarts. | `ERROR` |
| Job exhausts all retry attempts | Exceptional | Job moves to BullMQ failed set. Alert. Manual investigation required. | `ERROR` |

### The P2003 Case in Detail

This is the most nuanced worker decision. When the click worker processes a job, it's possible the URL was deleted between the time the job was enqueued (at redirect time) and the time the worker processes it. This is not a bug — it is an expected race condition in an eventually-consistent async pipeline.

**The wrong response:** Retry the job. Retrying will always produce P2003 again — the URL is gone. BullMQ will exhaust all retry attempts, move the job to the failed set, and trigger an alert. You've created noise for a non-problem.

**The correct response:** Catch P2003 specifically in the worker's failure handler. Log at `WARN` (it's noteworthy but not alarming). Discard the job by not re-throwing — let BullMQ mark it as complete. No retry, no alert, no failed queue entry.

### The Geo Lookup Case in Detail

IP geolocation enrichment is a best-effort operation. The click record must be saved regardless of whether the country code can be resolved.

**The wrong response:** Let the geo lookup failure throw and fail the job. Now the click is lost entirely — which is worse than saving it without enrichment.

**The correct response:** Wrap only the geo API call in a try-catch (the one legitimate use in the worker). On any failure, fall back to `country: null`. Save the click record. Log at `DEBUG` — this is expected transient behaviour, not an alert-worthy event.

This is the precise scenario where try-catch is the right tool: **a single, bounded operation with a well-understood fallback, inside an async worker where the failure is truly recoverable.**

---

## The Retry Boundaries

Not all failures are worth retrying. Retrying the wrong errors creates noise, exhausts rate limits, and obscures real problems.

| Error | Retry? | Strategy |
|---|---|---|
| `P1001`, `P1008`, `P1017` (infrastructure) | Yes | Exponential backoff via BullMQ. HTTP clients: `Retry-After` header. |
| `P2034` (write conflict / deadlock) | Yes | Brief delay (1s), max 3 attempts. Conflicts under normal load resolve quickly. |
| `P2002` (unique constraint) | No | The alias is taken. Retrying without changing the input will always fail. |
| `P2003` (FK violation in worker) | No | The parent record is gone. Retrying is pointless. |
| `P2025` (record not found) | No | The record does not exist. Retrying will not create it. |
| `P2016` (query bug) | No | This is a code bug. Retrying the same malformed query will always fail. |
| Geo lookup failure | No (for the job) | Fallback to `null`, save record, move on. |

---

## What "Working Correctly" Looks Like

The strategy is working when:

- **Production incidents are discovered through monitoring — not customer complaints.** Exceptional failures generate `ERROR` logs that trigger alerts. Nothing disappears silently.
- **The BullMQ failed queue is empty under normal operation.** P2003 jobs are discarded cleanly. The only entries are genuine, unexpected failures that need investigation.
- **Prisma errors P2005 and P2006 never appear in production logs.** If they do, there is a schema validation gap to close.
- **`P2016` never appears in production logs.** If it does, there is a code bug that slipped through testing.
- **Route handlers contain no try-catch blocks for business or database logic.** If a pull request adds one, it is a signal that error handling is being done in the wrong layer.
- **`403` is never returned by any route that handles ownership checks.** Ownership failures return `404`. Always.
- **5xx responses never contain Prisma messages, stack traces, or internal details.** If they do, there is a gap in the global error handler's sanitization.

---

## Anti-Patterns to Actively Avoid

These are the patterns that caused the silent production failures described in the introduction. Each one violates a specific principle in this strategy.

### 1. The Silent Swallow
```
catch (error) {
  // do nothing
}
```
**Why it's catastrophic:** The error disappears. No log. No alert. No way to know it happened until a customer notices.

### 2. The Catch-and-Log-But-Continue
```
catch (error) {
  console.log(error.message)
  // execution continues as if nothing happened
}
```
**Why it's dangerous:** The error is visible in logs but the system continues in a potentially corrupt state. The next operation may produce a different, confusing error — or silently corrupt data.

### 3. The Everywhere try-catch
Try-catch in every controller, every service, every repository — all doing roughly the same thing.
**Why it's a maintenance disaster:** When error handling logic needs to change, it must change in dozens of places. Inconsistencies accumulate. Some catch blocks get updated, others don't.

### 4. The Generic catch (Exception)
```
catch (Exception e) {
  return 500;
}
```
**Why it's useless:** A P2002 (unique constraint) and a P1001 (DB down) both return 500. The client gets no actionable information. The logs have no structure. Every failure looks identical.

### 5. Exceptions for Expected Outcomes
Throwing `NotFoundException` every time a short code lookup misses — in the hot redirect path.
**Why it's a design error:** Not found is an expected outcome, not an exception. Stack unwinding has overhead. More importantly, it categorizes routine behaviour as exceptional — muddying the signal-to-noise ratio in error monitoring.

### 6. Exposing Internals in Error Responses
```
return reply.code(500).send({ error: error.message })
```
Where `error.message` is a Prisma connection string error containing the database host and credentials.
**Why it's a security vulnerability:** Internal error messages, stack traces, and database details are reconnaissance for attackers. 5xx responses must always return a generic, safe message.

---

## Decision Log

Every significant exception handling decision in this strategy, and the reasoning behind it.

| Decision | Chosen Approach | Rejected Alternative | Reason |
|---|---|---|---|
| Ownership check response code | `404` always | `403 Forbidden` | IDOR prevention — 403 confirms resource existence |
| Redirect route error strategy | `null` check + inline response | `findUniqueOrThrow` + global handler | Hot path — no exception overhead, expected outcome |
| P2003 in click worker | Discard job | Retry with backoff | Parent record is gone — retrying always fails |
| Geo lookup failure | Fallback to `null`, save click | Fail the job | Click record is more valuable than enrichment |
| P2005 / P2006 in production | Schema gap — fix validation | Add catch block | Symptoms of upstream validation failure, not runtime errors |
| Global error handler location | `app.js` — registered once | Per-route try-catch | Single responsibility, zero duplication, consistent behaviour |
| 5xx response body | Generic safe message | `error.message` passthrough | Security — never expose internals to API consumers |
| Custom error hierarchy | Typed errors with status + code | Generic `Error` with message | Self-describing — no guesswork in handler or logs |
