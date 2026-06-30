# Dev Todos — Standards Compliance

Items tracked here are **not bugs** — they are working implementations that deviate from the documented standards. Each item must be resolved before the project is considered production-ready.

---

## Day 4 — Fastify App Skeleton

### [TODO-001] [FIXED — Day 14] Replace try-catch in health.ts with global error handler

**File:** `api/src/routes/health.ts`  
**Current:** DB failure caught with local `try-catch`, returns a manually constructed 503 response.  
**Required:** Per `docs/notes/exception-handling-strategy.md` — route handlers must be zero try-catch. Errors bubble up to the global error handler (Layer 6). DB connectivity failure is an exceptional failure — it belongs in the global handler.  
**Resolution (Day 14):** The Day-13 blocker is cleared — the global error handler now lives in [app.ts](../../api/src/app.ts#L49) and maps Prisma `P1001`/`P1017` → `503` with the ERROR_CONTRACT `{ error }` envelope. The `try-catch` was removed from `healthCheckRoutes`; the handler now just `await`s `app.prisma.$queryRaw\`SELECT 1\`` and returns `200 { status, timestamp, db }`. A connectivity failure throws and bubbles to Layer 6, so the route is now zero try-catch per the strategy.

---

### [TODO-002] Config fallback defaults for secrets in production

**File:** `api/src/config.ts`  
**Current:** `JWT_SECRET` and `DATABASE_URL` fall back to hardcoded defaults if env vars are missing.  
**Required:** In `production` env, missing required secrets must throw at startup — not silently use a known default. Silent fallback is a security vulnerability (OWASP A02: Cryptographic Failures).  
**Fix:** Add startup validation — if `NODE_ENV === 'production'` and required vars are unset, throw with a descriptive message before the server starts.

---

### [TODO-003] [FIXED — Day 14] Error response shape not enforced in health route

**File:** `api/src/routes/health.ts`  
**Current:** Error response is `{ status: "error", timestamp: ..., db: "error" }`.  
**Required:** Per `../docs/notes/ERROR_CONTRACT.md` — all error responses must follow `{ error: string, details?: object }` shape.  
**Resolution (Day 14):** Resolved together with TODO-001. The hand-built `{ status: "error", ... }` body is gone — the route no longer produces an error response at all. On DB failure the Prisma error bubbles to the global handler, which emits the contract-compliant `{ error }` envelope via `errorResponse(...)` ([app.ts:69](../../api/src/app.ts#L69)). The only response the route builds itself is the `200` success body.

---

## Day 14 — Custom Alias Namespace Collision (POST /api/shorten)

> Context: `customAlias` and auto-generated `shortCode` share ONE namespace — once
> persisted, a custom alias is written into the unique `short_code` column too
> ([schema.prisma](../../api/prisma/schema.prisma) `short_code @unique`,
> `custom_alias @unique`). The Day-14 fix made the pre-insert availability check
> (`findByShortCodeOrAlias` in `url.repository.ts`) probe BOTH columns so a
> user-supplied alias colliding with an existing short code returns the proper
> `409 { error, field: "customAlias" }` envelope. The two items below were
> identified during the security review of that fix as still-open gaps.

### [TODO-004] [FIXED — Day 14] Reverse collision: auto-generated short code can hit an existing custom alias

**File:** `api/src/routes/url.ts` (Step 3, no-alias branch)
**Current:** When no alias is supplied, `shortCode = base62(nextSequenceValue())` is inserted with **no pre-check** against the `custom_alias` column. If a user previously reserved `customAlias = "Z"` and the BIGSERIAL sequence later base62-encodes to `"Z"`, the auto-insert throws `P2002` → the global handler returns a generic `409 "Resource already exists"` ([app.ts:76](../../api/src/app.ts#L76)) to a user who never chose an alias.
**Impact:** Correctness/UX, not a security hole — the DB unique constraint + P2002→409 mapping prevent any duplicate or 500/leak. But the 409 is confusing and carries no field context.
**Required:** Either (a) check the auto-generated code against the shared namespace before insert and re-roll on collision, or (b) catch `P2002` in this path, inspect `meta.target`, and on a `short_code`-only collision transparently retry with the next sequence value. Reference `docs/notes/prisma-errors.md` (`meta.target` inspection) and `../docs/notes/ERROR_CONTRACT.md`.
**Resolution (Day 14):** Adopted option (b) in the new `api/src/services/url.service.ts` (`createShortUrl`, auto-gen branch). The no-alias path runs a bounded re-roll loop (`MAX_CODE_GEN_ATTEMPTS = 5`): each `P2002` pulls the next `nextSequenceValue()` and re-encodes. Because the no-alias insert writes `customAlias: null`, a `P2002` there can only be a `short_code` collision, so behaviour is driven by request intent rather than fragile `meta.target` string-matching. Collisions now resolve transparently into a `201` instead of a confusing generic `409`.

---

### [TODO-005] [FIXED — Day 14] TOCTOU race between alias pre-check and insert loses field-scoped 409

**File:** `api/src/routes/url.ts` (Step 2 check → Step 4 create)
**Current:** The `findByShortCodeOrAlias` pre-check and the `repo.create()` insert are not atomic. Two concurrent requests for the same alias can both pass Step 2; the DB unique constraint catches the loser, which surfaces as the generic `409 "Resource already exists"` instead of the intended `409 { error: "Custom alias already in use", field: "customAlias" }`.
**Impact:** Correctness/UX only — the constraint is the real guarantee and the DB never lets a duplicate through. The pre-check is best-effort UX, as documented in `docs/dev-log/day-03-url-creation.md` (§ "Custom Alias Pre-Check vs Relying on P2002").
**Required:** Catch `P2002` from `create()` in the route/service, inspect `meta.target` to distinguish `custom_alias` vs `short_code`, and return the matching field-scoped 409 envelope so the race path and the pre-check path produce identical responses. Reference `docs/notes/exception-handling-strategy.md`.
**Resolution (Day 14):** The create flow moved into `api/src/services/url.service.ts` (`createShortUrl`, alias branch), keeping the route a thin, try-catch-free handler. The pre-check is retained as best-effort UX; the `repo.create()` call is now wrapped so a `P2002` race loser throws the **same** `ConflictError('Custom alias already in use', { field: 'customAlias' })` the pre-check raises — both paths emit an identical `409 { error, details: { field: "customAlias" } }`. Behaviour is keyed off request intent (alias supplied ⇒ any conflict is the user's alias) rather than `meta.target` string-matching. A deliberate decision NOT to wrap pre-check→insert in a transaction is recorded in the implementation plan: at READ COMMITTED the insert-insert race is not closed by a transaction, so catching `P2002` remains mandatory and is the lock-free, spec-aligned guarantee.

---

## Day 15 — Async Job Testing + IST Timezone

> Context: the two nightly worker crons (analytics aggregation, expiry sweep) had
> zero automated tests, and the aggregation bucketed clicks by the **UTC** calendar
> day — 5.5h out of step with the IST day an India-facing product means by "a day".
> Full coverage was added (Step 1, UTC baseline) then the bucketing was switched to
> IST (Steps 2–3). See `docs/dev-log/day-15-async-job-testing.md` and DECISIONS.md #12.

### [TODO-006] [FIXED — Day 15] Analytics aggregation buckets by UTC day, not IST

**File:** `worker/src/jobs/aggregation.job.ts`, `worker/src/repositories/aggregate.repository.ts`
**Current:** `utcDayWindow` computed UTC `[start, end)` instants; clicks between 18:30–24:00 IST were filed under the previous day. Wrong for an India-facing product.
**Required:** Bucket by the IST (`Asia/Kolkata`) calendar day while keeping storage in UTC. Reference DECISIONS.md #12.
**Resolution (Day 15):** `utcDayWindow` replaced by `istYesterday(now)` (returns the IST date string); `aggregateDay(date)` resolves the IST day to instants in SQL via `(${date}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'` (half-open window). Storage stays `timestamptz` — no migration. Crons moved to `timezone: 'Asia/Kolkata'` (aggregation 00:15 IST, expiry 01:00 IST). Decision recorded as DECISIONS.md #12. 24/24 tests green incl. a new IST-vs-UTC bucketing integration test.

---

### [TODO-007] [FIXED — Day 15] IP-hash salt rotated on the UTC boundary, not the IST bucket boundary

**File:** `worker/src/jobs/analytics.job.ts`
**Current:** `hashIp` rotated its daily salt on the **UTC** date. Once the aggregation bucket became the IST day (TODO-006), a salt rotating on a different (UTC) boundary would give a visitor straddling IST midnight two different `ip_hash` values within one IST day → double-counted as unique.
**Required:** Rotate the salt on the **same IST boundary** as the bucket so `COUNT(DISTINCT ip_hash)` is correct. Load-bearing for unique-visitor accuracy.
**Resolution (Day 15):** Salt now derives its date from `new Date(Date.now() + IST_OFFSET_MS)` (IST date), matching `aggregateDay`'s IST bucket boundary. One-line date-source swap; the click pipeline (`analytics.job.ts`) remains out of automated-test scope per the Day-15 coverage note, so verified by inspection.

---

## How to use this file

- When a TODO is resolved, mark it with the day it was fixed: `[FIXED — Day N]`
- When adding new todos, use the next number in sequence: `[TODO-NNN]`
- Each entry must reference the violated doc standard and the file to fix
- Do NOT add entries for things intentionally deferred with a "Blocked by" note already in the plan
