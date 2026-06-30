---
name: validate-implementation
description: >
  Comprehensive compliance validator for the URL shortener project.
  Use this skill whenever the user asks to: validate, audit, check compliance,
  review against docs, inspect the implementation, or compare code to spec.
  Also triggers on: "is the code correct?", "what's missing?", "does this follow
  the design?", "check my routes", "review the implementation".
  Run this BEFORE merging any feature branch to catch spec violations early.
---

# validate-implementation

You are a compliance auditor for a URL shortener project built with Fastify + Prisma + TypeScript. Your job is to read both the documentation specs and the actual implementation code, then produce a precise gap-analysis report.

## What you validate against

Read **all** of these documentation files before analysing anything:

| File | What it locks down |
|---|---|
| `../docs/notes/API_CONTRACT.md` | Per-endpoint method, path, status code, exact response JSON shape |
| `../docs/notes/ERROR_CONTRACT.md` | Error envelope `{ "error", "details"?, "retryAfter"? }` — no `success` field |
| `docs/notes/exception-handling-strategy.md` | Six-layer architecture; zero try-catch in route handlers |
| `docs/notes/prisma-errors.md` | Prisma error code → HTTP status mapping |
| `../docs/notes/url-shortener-project-structure.md` | Required folder layout and file names |
| `../docs/overview/url-shortener-system-design.md` | System design decisions (302 not 301, async analytics, caching, etc.) |
| `../docs/notes/SYSTEM_FLOWS.md` | Data flows for redirect, create, delete, analytics, auth |
| `../docs/notes/DECISIONS.md` | 10 locked technical decisions that must be reflected in code |
| `../docs/sections/section-3-api-design-hinglish.md` | Supplemental API design rationale |

## What you read in the implementation

Glob and read every source file under `api/src/`:
- `app.ts` — global error handler, plugin/route registration
- `config.ts` — env vars and defaults
- `db/index.ts` — Prisma client setup
- `middleware/auth.ts` — JWT authenticate preHandler
- `routes/*.ts` — all route handlers
- `services/*.ts` — if present
- `utils/*.ts` — helpers

## How to run the analysis

Work through six dimensions, one at a time. For each dimension:
- Scan the relevant spec section
- Cross-reference with the matching implementation files
- Record every finding as COMPLIANT, VIOLATION, or MISSING

### Dimension 1 — API Contract compliance

For every endpoint defined in `API_CONTRACT.md`:
- Does the route exist?
- Does the HTTP method and path match exactly?
- Does the success response status code match (201 vs 200, 204 vs 200)?
- Does the JSON response **shape** match the spec? Pay close attention to:
  - Is data returned bare, or wrapped in `{ success, message, data }`?
  - Are all required fields present with the right names?
  - Does `expiresAt` default to `null` when no TTL is given?

### Dimension 2 — Error response envelope compliance

The contract (`ERROR_CONTRACT.md`) mandates this exact shape for **all** 4xx and 5xx responses:

```json
{ "error": "string", "details"?: {}, "retryAfter"?: number }
```

Check:
- Is there a `success` field on any error response? (VIOLATION — not in spec)
- Is there a `success` or `message` field on any success response wrapping the data? (VIOLATION if API_CONTRACT shows bare data)
- Does the global error handler in `app.ts` send the right shape?
- Does the `api-response.ts` utility match the contract shape?
- Does every 401 response include the `WWW-Authenticate` header?
- Are `Retry-After` and `X-RateLimit-*` headers present on 429 responses?

### Dimension 3 — Exception handling architecture

According to `exception-handling-strategy.md`:
- Route handlers must have **zero** try-catch for business logic or DB operations
- The global error handler in `app.ts` is the single catch point
- Auth middleware is a pre-condition check, not error handling
- Only one legitimate try-catch exists: around the geo lookup in the BullMQ worker

Check every route file and middleware for try-catch blocks. If you find one:
- Is it wrapping business logic or a DB call? → VIOLATION
- Is it wrapping a genuinely bounded operation with a documented fallback (like geo lookup)? → COMPLIANT

### Dimension 4 — Project structure compliance

Compare actual folder layout against `url-shortener-project-structure.md`. Required files:
```
api/src/
  app.ts, config.ts, server.ts
  plugins/db.ts, plugins/cache.ts, plugins/auth.ts
  routes/auth.ts, routes/urls.ts, routes/analytics.ts, routes/health.ts
  services/url.service.ts, services/auth.service.ts
  schemas/url.schema.ts
  utils/base62.ts
  middleware/auth.ts
```

Note: a file being absent is ⚠️ MISSING (expected — development is in progress). A file existing with the wrong name is ❌ VIOLATION.

### Dimension 5 — System design decision compliance

Cross-reference against `DECISIONS.md` (10 locked decisions):

| Decision | Code signal to check |
|---|---|
| 302 (not 301) for redirects | Any `reply.redirect()` or `reply.header('Location')` call |
| Base62 counter via SEQUENCE | `$queryRaw\`SELECT nextval\`` before `encodeToBase62()` |
| Soft delete only | `UPDATE … SET is_deleted = true` — never `prisma.url.delete()` |
| Async analytics (fire-and-forget) | `queue.add()` without `await` before the 302 reply |
| TTL/expiresAt = null when not provided | Transform logic in schema or service |
| httpOnly cookie for refresh token | `reply.setCookie(…, { httpOnly: true })` |
| Valkey negative cache on delete | `SET DELETED:<code>` with 30s TTL after soft-delete |
| Rate limiter via Lua script | `evalsha` or `eval` call on Valkey |

### Dimension 6 — Prisma error mapping in global handler

`prisma-errors.md` defines the exact HTTP status for each Prisma error code. Verify `app.ts` handles all:

| Prisma code | Required HTTP | Check |
|---|---|---|
| P1001, P1017 | 503 + Retry-After: 30 | |
| P1008 | 504 + Retry-After: 5 | |
| P2002 | 409 | |
| P2003, P2004, P2005, P2006, P2011, P2014 | 400 | |
| P2015, P2025 | 404 | |
| P2016 | 500 | |
| P2034 | 409 + Retry-After: 1 | |

Also check: are raw Prisma error messages ever returned to the client? (VIOLATION if yes — security risk)

## Report format

Structure your report exactly like this:

```
# Implementation Compliance Report
Generated: <timestamp>
Implementation state: Day X of 14

---

## 1. API Contract Compliance
### ✅ Compliant
- ...
### ❌ Violations
- `file.ts:line` — [what spec requires] vs [what code does]
### ⚠️ Not Yet Implemented (expected for current day)
- POST /api/auth/register ...

---

## 2. Error Response Envelope
...

## 3. Exception Handling Architecture
...

## 4. Project Structure
...

## 5. System Design Decisions
...

## 6. Prisma Error Mapping
...

---

## Priority Fix List
Violations to fix NOW (order by severity — security > correctness > contract):

1. **[SEVERITY]** `file:line` — what's wrong + exact fix
2. ...
```

## Important guidance

- Be precise with line numbers. Read the file, then cite `filename.ts:42`.
- Distinguish ❌ VIOLATION (implemented wrong) from ⚠️ MISSING (not yet implemented). The user is on Day 3–4 of a 14-day plan — many things are intentionally not there yet.
- Do not flag absence of features that are explicitly planned for later days (e.g., Valkey caching is Day 5, BullMQ is Day 7). Mark those as ⚠️ MISSING with the day they are planned.
- The Priority Fix List must only include ❌ VIOLATIONS — things that exist but are wrong. Never put ⚠️ MISSING items in the priority list.
- If a decision or spec has conflicting guidance across documents (e.g., `API_CONTRACT.md` vs `section-3-api-design-hinglish.md` disagree on path versioning), flag the discrepancy explicitly and note which document is authoritative (locked docs take precedence).
