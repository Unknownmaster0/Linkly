# Design Decisions — URL Shortener

**Status:** Locked (Pre-Implementation)  
**Last Updated:** 2026-07-16 (added Decisions 15-16 — trust proxy scope, auth rate limiting)  
**Audience:** Development team, code reviewers

---

## Design Decision Table

| # | Decision | Choice | Why This | Rejected | Trade-off | Failure If Wrong |
|---|----------|--------|---------|----------|-----------|------------------|
| 1 | Redirect Status Code | 302 (Temporary) | Analytics visibility; allows future target updates | 301 (Permanent) | Server sees every redirect; higher load but acceptable with async | Can't measure engagement; browser cache permanent |
| 2 | Counter Strategy | PostgreSQL SEQUENCE | Atomic, lock-free, proven at scale | In-process counter OR Valkey INCR | Ties to PostgreSQL; more complex than simple increment | Race conditions → duplicate short codes (showstopper) |
| 3 | Cache Strategy | Write-through (create) + Cache-aside (first miss) | Immediate availability + memory efficiency | Write-through only OR Cache-aside only | Some URLs cached but never clicked; or first redirect slow | OOM on unchecked cache OR p99 latency > 100ms |
| 4 | Analytics Write | Async BullMQ worker | Redirect latency ≤ 2ms; enables geo enrichment | Sync DB insert in request | Adds queue, worker, retry complexity | Redirect latency 5-50ms; breaks at 100M URLs/day |
| 5 | Token Model | Access (15m) + Refresh (30d in DB) | Revocation possible; theft window limited | Single long-lived JWT | Slightly more complex; refresh endpoint needed | Can't logout users; stolen token valid 30 days |
| 6 | Rate Limiter | Valkey + Lua script (atomic) | Works across instances; no race conditions | In-process token bucket | Valkey dependency; slight latency | Abuse under concurrent load; duplicate requests allowed |
| 7 | Ownership Checks | Return 404 for all failures | Prevent enumeration attacks; no information leak | Return 403 for unauthorized | Slightly confusing error semantics | Attackers enumerate valid short codes |
| 8 | Soft Delete | is_deleted flag instead of hard delete | Preserves analytics history | Hard delete | One more row per URL; one extra WHERE clause | Analytics orphaned when URL deleted |
| 9 | Negative Cache | DELETED:<code> with 30s TTL | Prevents DB hammering on deleted URLs | No negative cache entry | Slight cache pollution | Every deleted URL hits DB every redirect |
| 10 | Worker Process | Same as HTTP server (initially) | Simpler deployment; one process to manage | Separate process | Shared failure domain | Worker crash could affect HTTP server |
| 11 | Redirect Server Prisma Schema | Minimal copy (Url fields only) | `redirect/` is an isolated package; can't share `api/`'s schema without `shared/` | Import api's generated client | Schema drift risk until `shared/` is created | Redirect silently queries stale/wrong columns if api renames a field |
| 12 | Analytics Day Bucketing | IST (`Asia/Kolkata`) via `AT TIME ZONE` in SQL; storage stays UTC | India-facing product — "a day" must mean the IST calendar day, not UTC (5.5h skew); Postgres resolves the boundary, no JS tz math, no stored local time | Bucket by UTC day OR store naive IST `TIMESTAMP` | Must remember `AT TIME ZONE` per tz-sensitive query; salt rotation coupled to the IST boundary | Daily numbers smeared 5.5h across the IST/UTC boundary; or (if storing local) `NOW()`/`expires_at < now` silently off by 5.5h |
| 13 | Account Deletion | Anonymize `users` row + soft-delete owned `urls`; never hard-delete a user | `urls` → `click_events` cascade off `users` (`onDelete: Cascade`); a hard delete would silently destroy analytics history for every URL the account owned | Hard `DELETE FROM users` | Anonymized row (placeholder email/name) stays in the table forever; `email` unique index holds a dead placeholder value | Hard delete cascades and erases click-event history for URLs the deleted user owned |
| 14 | Geo Enrichment Data Minimization | Request/store `countryCode` only from the geo-IP provider; never log the raw IP | Country-level is all the locked analytics contract (`GET /api/analytics/:shortCode`) exposes; `city` had no consumer and is materially more identifying per visitor | Also fetch/store `city` (previous behavior) | Slightly less granular geo data available for any future feature | City-level per-click location data sent to & retained from a third party with no product need for it; raw IP logged if debug logging is ever enabled in production |
| 15 | Trust Proxy Scope | `trustProxy: 'loopback'` on both `api` and `redirect` | Same-host nginx reverse proxy; must read the real client IP for rate limiting + analytics without trusting a spoofable header | `trustProxy: true` (trusts the whole X-Forwarded-For chain) OR unset (trusts nothing, always sees the proxy's own IP) | Coupled to the nginx-same-host topology; must be revisited if a different/multi-hop proxy is introduced | `true` → any caller spoofs `request.ip` via a forged header, bypassing per-IP rate limits and poisoning click analytics; unset → every request looks like it came from `127.0.0.1`, collapsing all per-IP limits into one shared bucket |
| 16 | Auth Rate Limiting | Per-IP (register + login) **and** per-account (login only) | Per-IP alone doesn't stop a distributed attacker (many source IPs) credential-stuffing one victim account | Account lockout (lets an attacker DoS a victim by deliberately failing their login) OR CAPTCHA (deferred — extra dependency + UX friction) | The per-account bucket is keyed off the request body before Zod validates it, so malformed/missing emails share one fallback bucket | Per-IP-only → distributed credential stuffing against a single account is unbounded; no rate limiting at all → registration/login are trivially abusable for mass signup or brute force |

---

## Decision Rationale (Detailed)

### Decision 1: Redirect Status Code (302 vs 301)

**Context:**
- 301 = browser caches redirect permanently (even after browser restart)
- 302 = browser asks server each time

**Why 302 Wins:**
At 100M URLs/day with analytics requirements, you must see every redirect. Browser caching (301) makes analytics incomplete.

**Trade-off Accepted:**
- ✅ Every redirect hits server (observable)
- ❌ More server load
- **Mitigation:** Async BullMQ means server doesn't block on analytics write, so load is acceptable

**Interview Question This Answers:**
"Why 302 instead of 301?"

---

### Decision 2: Counter Strategy (SEQUENCE vs Alternatives)

**Problem Solved:**
How to generate unique, compact, thread-safe short codes without race conditions?

**Why SEQUENCE Wins:**

| SEQUENCE | Valkey INCR | SELECT...FOR UPDATE |
|----------|---|---|
| Atomic (DB handles) | Race condition risk with GET/SET | Slower (lock overhead) |
| Proven at Bitly scale | Adds complexity | Degrades under load |
| No code logic | Must handle edge cases | More code to test |

**Race Condition It Prevents:**
```javascript
// WRONG (race condition):
const count = await db.url.count()  // Thread A: sees 1000
const count = await db.url.count()  // Thread B: sees 1000
// Both generate shortCode from 1000 → COLLISION

// RIGHT (atomic):
const nextId = await db.$queryRaw`SELECT nextval('url_short_code_seq')`
// PostgreSQL guarantees: Thread A gets 1001, Thread B gets 1002 (atomic)
```

**Why BigInt Matters:**
- `Number.MAX_SAFE_INTEGER` = 2^53 − 1 ≈ 9 quadrillion
- At 100M URLs/day: safe for ~90,000 years
- But production code handles all scales, not just today's scale

**When Counter Resets:**
Never (SEQUENCE is persistent). Even after server restart, `nextval()` continues from where it left off.

**Interview Question This Answers:**
"Walk me through a race condition if you used application-level counters instead."

---

### Decision 3: Cache Strategy (Write-Through + Cache-Aside)

**Problem:**
How to balance memory efficiency vs latency?

**Why Hybrid Approach Wins:**

| Write-Through | Cache-Aside |
|---|---|
| Cache URL immediately when created | Cache only on first redirect |
| ✅ First redirect is always fast (cache HIT) | ✅ Only hot URLs cached (memory efficient) |
| ❌ Cache URLs that never get clicked (waste) | ❌ First redirect is slow (DB hit) |

**Power-Law Assumption:**
Pareto distribution: ~80% of clicks come from ~20% of URLs. Most URLs created never get clicked.

**Strategy:**
1. **On CREATE:** Write-through (cache immediately)
   - Rationale: User expects their newly-created URL to work fast
2. **On FIRST REDIRECT (cache miss):** Cache-aside (populate cache on miss)
   - Rationale: Subsequent redirects are fast; if never clicked again, saved memory

**TTL Management:**
- If `url.expiresAt` is set: use it as TTL
- Else: default 7 days
- Valkey evicts oldest entries if memory full (LRU)

**Interview Question This Answers:**
"Why would write-through-only waste memory?"

---

### Decision 4: Analytics Write (Async vs Sync)

**Problem Solved:**
Click writes are slow (disk I/O). If synchronous, every redirect waits.

**Why Async Wins:**

Math at scale:
- 100M URLs/day = ~1,200 redirects/second
- If each redirect spends 10ms on DB write: 1,200 × 10ms = **12 seconds of latency per second**
- That's unacceptable

**Flow Comparison:**

| Sync | Async |
|---|---|
| GET /:shortCode → find URL → await db.insert() → 302 redirect (5-50ms total) | GET /:shortCode → find URL → fire-and-forget: queue.add() → 302 redirect (~1ms total) |

**What This Locks In:**
- You MUST have BullMQ (queue)
- You MUST have worker (same or separate process)
- You MUST have retry logic (what if worker crashes?)
- Click data arrives at analytics 1-5 seconds later (acceptable)

**Critical Implementation Detail:**
The `clickQueue.add()` must NOT be awaited. If you accidentally `await` it, you've defeated the entire architecture.

**Interview Question This Answers:**
"Walk me through why BullMQ matters for a URL shortener at scale."

---

### Decision 5: Token Model (Two-Token vs Single Long-Lived)

**Problem:**
How to balance security (short-lived tokens) with usability (user shouldn't re-login every 15 minutes)?

**Why Two-Token Wins:**

| Two-Token | Single Long-Lived |
|---|---|
| ✅ Theft window is 15 min (access token) | ❌ Theft window is 30 days (massive exposure) |
| ✅ Can revoke tokens (logout works) | ❌ Can't revoke (token valid until expiry) |
| ✅ Detect suspicious patterns (refresh attempts) | ❌ No pattern detection |
| ❌ More complex (refresh endpoint) | ✅ Simpler |

**Token Pair Semantics:**
- **Access Token:** 15 min expiry, stateless, signed with JWT_SECRET, used for API calls
- **Refresh Token:** 30 day expiry, stored as hashed value in DB, returned in httpOnly cookie, used to get new access token

**Revocation Flow:**
```javascript
// User logs out
POST /api/auth/logout
  → Mark refresh token as revoked in DB
  → Clear cookie
  → Future refresh attempts fail

// Stolen access token (15 min window)
  → Can use for 15 min max
  → Then expires, attacker needs refresh token
  → But refresh token is in secure httpOnly cookie (can't steal via XSS)
```

**Why httpOnly Cookie (Not localStorage):**
- httpOnly: browser never exposes cookie to JavaScript (prevents XSS theft)
- localStorage: JavaScript can read it (XSS = game over)

**Implication for Next.js:**
- Client components CANNOT read `httpOnly` cookies directly
- All authenticated requests must go through Server Actions or API routes (which have cookie access)

**Interview Question This Answers:**
"Why is a single long-lived JWT unacceptable for a user-facing product?"

---

### Decision 6: Rate Limiter (Valkey + Lua vs In-Process)

**Problem Solved:**
How to prevent abuse (e.g., user creates 1,000 URLs in 1 second) without race conditions?

**Why Valkey + Lua Wins:**

**The Race Condition (In-Memory):**
```javascript
// WRONG (race condition):
if (tokens > 0) {
  tokens -= 1  // Thread A and B both see tokens = 1, both decrement, race
}

// WRONG (Valkey, naive):
const tokens = await cache.get('tokens:userId')  // Thread A: reads 1
if (tokens > 0) {
  await cache.set('tokens:userId', tokens - 1)   // Thread B: also reads 1, then both set
  // RACE CONDITION: both think they have 1 token
}

// RIGHT (Valkey + Lua):
await cache.eval(`
  if redis.call('get', KEYS[1]) > 0 then
    redis.call('decr', KEYS[1])
    return 1
  else
    return 0
  end
`, 1, 'tokens:userId')
// Lua script is atomic: GET + compare + DECR happens as ONE operation
```

**Why Lua Script:**
Valkey is single-threaded. A Lua script runs to completion without interruption (atomic).

**Rate Limit Bucket:**
- Limit: 100 URLs per user per hour
- Resets every hour: `SETEX 'tokens:userId' 3600 100`
- Each request: decrement by 1

**Response Headers:**
- `X-RateLimit-Limit: 100`
- `X-RateLimit-Remaining: 42`
- `X-RateLimit-Reset: 1713470460` (Unix timestamp)

**Interview Question This Answers:**
"What's the race condition in naive rate limiting, and how does Lua script fix it?"

**Implementation note (2026-07-16):** the create-endpoint config (`RATE_LIMIT_CREATE_LIMIT` /
`RATE_LIMIT_WINDOW_SECS`) had drifted to `10` req / `60`s (= 600/hour) — six times looser than
the `100/hour` documented above. Corrected the defaults to `100` / `3600` so the running
config matches this decision. See Decision 16 for the auth-endpoint limits added the same day.

---

### Decision 7: Ownership Checks (404 vs 403)

**Problem Solved:**
User A tries to view analytics for User B's short URL. What should happen?

**Why 404 (Not 403) Wins:**

This is called **"Information Leakage Prevention"**.

```javascript
// WRONG (leaks information):
if (url.userId !== currentUser.id) {
  return 403 Forbidden  // "This URL exists, you just don't own it"
}
// Attacker learns: "xyz123 is a valid short code"

// RIGHT (leaks nothing):
if (url.userId !== currentUser.id) {
  return 404 Not Found  // "I don't know what you're talking about"
}
// Attacker learns: nothing
```

**Enumeration Attack Prevention:**
```javascript
for (let i = 0; i < 1000000; i++) {
  const shortCode = encode(i)  // abc, abd, abe, ...
  GET /api/analytics/shortCode
  
  // If 403: attacker marks as "valid, not mine"
  // If 404: attacker can't distinguish "doesn't exist" from "not mine"
}
```

**Rule:** Both "not found" and "unauthorized" return 404. Implementation is identical.

**Interview Question This Answers:**
"Why return 404 instead of 403 for unauthorized access?"

---

### Decision 8: Soft Delete (vs Hard Delete)

**Problem:**
If user deletes a URL, what happens to analytics history?

**Why Soft Delete Wins:**

| Soft Delete | Hard Delete |
|---|---|
| ✅ Analytics preserved (Click records remain) | ❌ Analytics orphaned (URL deleted, Clicks remain) |
| ✅ Can resurrect URL if needed | ❌ Permanent loss of data |
| ❌ One extra row per URL | ✅ No extra rows |

**Implementation:**
```javascript
// Soft delete:
UPDATE Url SET is_deleted = true WHERE id = ?
// URL is gone (invisible in list_urls, returns 404 on redirect)
// But Click records are still there, analytics still queryable

// Hard delete:
DELETE FROM Url WHERE id = ?
// If there are Click records with foreign key:
//   - Foreign key constraint fails (REJECTED)
//   - Or cascade deletes Click records (analytics lost)
```

**Interview Question This Answers:**
"Why preserve analytics when a URL is deleted?"

---

### Decision 9: Negative Cache (DELETED:<code> Entry)

**Problem:**
If a URL is deleted, the next redirect still hits the DB (cache miss). Then every subsequent redirect also hits the DB until the positive cache entry expires.

**Why Negative Cache Wins:**

**Without negative cache:**
```
1. User creates URL abc123
2. Cache: url:abc123 = {...}
3. User deletes abc123
4. Cache: url:abc123 (still there, expires in 7 days)
5. GET /abc123 (next second)
   → Cache MISS (key deleted)
   → DB query
   → is_deleted = true → return 410
6. GET /abc123 (every second for next 7 days)
   → Cache MISS → DB query every time
   → Result: DB hammering
```

**With negative cache:**
```
1-5. Same as above
6. GET /abc123 (every second for next 30s)
   → Cache HIT: DELETED:abc123 exists
   → Return 410 immediately (no DB query!)
7. After 30s: DELETED:abc123 expires
8. GET /abc123
   → Cache MISS → DB query (proves still deleted)
   → Set DELETED:abc123 again
```

**TTL Selection:**
- 30 seconds balances two concerns:
  - Long enough to prevent DB hammering
  - Short enough that mistakes (deleting wrong URL) resolve quickly

**Interview Question This Answers:**
"How does negative cache prevent DB hammering on deleted URLs?"

---

### Decision 10: Worker Process Location (Same vs Separate)

**Problem:**
Should the BullMQ worker run in the same Node process as the HTTP server, or separately?

**Why Same Process (Initially) Wins:**

| Same Process | Separate Process |
|---|---|
| ✅ Simpler deployment (one service) | ❌ Two services to manage |
| ✅ No inter-process communication | ✅ Better failure isolation |
| ❌ Shared failure domain | ❌ Network overhead |
| ✅ Faster iteration during development | ✅ Scales independently |

**Trade-off Accepted:**
If the worker crashes, it could affect the HTTP server. But:
1. Worker failures don't lose data (jobs stay in queue)
2. Can always separate later (Week 3+)
3. Same-process is good for MVP

**When to Separate:**
- If worker consistently crashes
- If worker CPU consistently high
- At scale (100M+ URLs/day)

**Interview Question This Answers:**
"What's the trade-off between same-process and separate-process workers?"

---

### Decision 11: Redirect Server Prisma Schema (Minimal Copy vs Shared)

**Context:**
`redirect/` is a separate npm package. It needs a Prisma client to query the `urls` table. Two options exist:

**Option A — Import from `api/`'s generated client:**
```typescript
// redirect/src/db/index.ts
import { PrismaClient } from '../../api/src/generated/prisma/client';
```
- ❌ Creates a hard cross-package dependency
- ❌ `api/` becomes a build-time requirement for `redirect/`
- ❌ Breaks the independent-deployment model

**Option B — Minimal copy schema (chosen):**
```prisma
// redirect/prisma/schema.prisma
model Url {
  id          BigInt    @id
  shortCode   String    @unique @map("short_code")
  originalUrl String    @map("original_url")
  isActive    Boolean   @map("is_active")
  isDeleted   Boolean   @map("is_deleted")
  isFlagged   Boolean   @map("is_flagged")
  expiresAt   DateTime? @map("expires_at")
  @@map("urls")
}
```
- ✅ `redirect/` is fully independent — runs, builds, deploys without `api/`
- ✅ Client only exposes fields the redirect server actually uses
- ⚠️ Schema drift risk (see below)

**Critical: `prisma generate` vs `prisma migrate`**

| Command | What it does | Run from |
|---|---|---|
| `prisma generate` | Generates TypeScript client code locally — **no DB changes** | Both `api/` and `redirect/` |
| `prisma migrate dev` | Creates and applies SQL to alter the real database | **Only `api/`** |

Running `prisma migrate` from `redirect/` would diff the DB against the minimal schema and attempt to **drop** all columns and tables it doesn't recognise (User, RefreshToken, ClickEvent, etc.). **Never run migrations from the redirect server.**

**Schema Drift Risk:**
If `api/` renames or removes a field that `redirect/` uses (e.g. `is_deleted` → `is_archived`), the redirect server's client becomes silently wrong — the TypeScript compiler won't catch it because the two packages are isolated.

**Mitigation rule (until `shared/` exists):**
> Any time you run `prisma migrate dev` in `api/` and change a field that appears in `redirect/prisma/schema.prisma`, also update the redirect schema and re-run `npx prisma generate` in `redirect/`.

Fields the redirect server uses: `shortCode`, `originalUrl`, `isActive`, `isDeleted`, `isFlagged`, `expiresAt`. These are core and stable.

**Permanent fix:**
Create `shared/` (planned in project structure doc) as a single shared schema package. Both `api/` and `redirect/` run `prisma generate` against the same schema file. Drift becomes impossible.

**Interview Question This Answers:**
"How do you share a database schema across multiple microservices in a Node monorepo?"

---

### Decision 12: Analytics Day Bucketing (IST vs UTC vs stored-local)

**Added:** Day 15 (Step 2). Supersedes the original UTC day-bucketing.

**Problem:**
The nightly aggregation rolls clicks up per **calendar day**. For an India-facing
product, "a day" means the IST (`Asia/Kolkata`, UTC+5:30) calendar day. Bucketing by
the UTC day files every click between 18:30 and 24:00 IST under the *previous* day —
every "daily" number is smeared 5.5h across the boundary.

**Why IST-in-SQL Wins:**

| Bucket by UTC day | Store naive IST `TIMESTAMP` | **IST via `AT TIME ZONE` (chosen)** |
|---|---|---|
| ✅ simple | ❌ ambiguous (no offset in the data) | ✅ storage stays correct (UTC instant) |
| ❌ 5.5h wrong for IST users | ❌ `NOW()` / `expires_at < now` silently off 5.5h | ✅ Postgres resolves the IST boundary |
| | ❌ every writer must pre-convert | ✅ no JS tz math, no per-writer risk |

**The principle:** *store the absolute instant (UTC `timestamptz`), reason in one fixed
zone (`Asia/Kolkata`) at the edges.* Storage and reasoning are separate concerns.

**Implementation:**
```sql
-- aggregate.repository.ts — resolve the IST calendar day to instants in SQL:
WITH bounds AS (
  SELECT (:date::date)::timestamp       AT TIME ZONE 'Asia/Kolkata' AS day_start,
         ((:date::date + 1)::timestamp)  AT TIME ZONE 'Asia/Kolkata' AS day_end
)
-- clicks counted where clicked_at >= day_start AND < day_end  (half-open)
```
IST midnight = 18:30 UTC of the previous day; the comparison stays against stored UTC
instants. The job passes just the IST date string (`istYesterday(now)`).

**What IST actually touches (and what it doesn't):**

| Layer | Affected? |
|---|---|
| Storage (`timestamptz`) | ❌ no change |
| **Expiry** (`expires_at < now`) | ❌ **no change** — instant comparison, correct in any zone |
| Analytics day-bucket | ✅ IST (`AT TIME ZONE`) |
| IP-hash salt rotation | ✅ IST — **load-bearing**: must rotate on the same boundary as the bucket, or a visitor straddling IST midnight is double-counted |
| Cron firing | ✅ `Asia/Kolkata` — aggregation 00:15 IST, expiry 01:00 IST |
| Display / API output | ✅ IST |

**Option chosen: A — explicit `AT TIME ZONE` in the worker query** (not setting the DB
connection timezone). Self-documenting; blast radius limited to the worker; raw `psql`
behaviour unchanged.

**Interview Question This Answers:**
"Your product is India-facing but you store UTC — how do you make 'daily analytics' mean the IST day without corrupting storage?"

---

### Decision 13: Account Deletion (Anonymize vs Hard Delete)

**Added:** 2026-07-15, as part of a pre-deployment personal-data audit.

**Problem:**
There was no way for a user to delete their account. The checklist requirement is
"remove or anonymize all personal data" — but `Url.user` and (transitively)
`ClickEvent.url` both cascade off `User` (`onDelete: Cascade`), so a naive
`prisma.user.delete()` would cascade-destroy every URL and all click-event history the
user ever generated.

**Why Anonymize Wins:**

| Anonymize (chosen) | Hard delete |
|---|---|
| ✅ Analytics history survives (same principle as Decision 8) | ❌ Cascades and destroys all owned URLs + click events |
| ✅ Login becomes permanently impossible (`isActive = false`, password overwritten) | ✅ Row is gone |
| ❌ A placeholder row (`deleted-<uuid>@deleted.invalid`) stays in `users` forever | ✅ No leftover row |

**Implementation (`auth.repository.ts` → `deleteAccount`, one transaction):**
1. `users`: `email` → `deleted-<userId>@deleted.invalid`, `name` → `''`, `passwordHash` →
   random unusable bytes, `isActive` → `false`. **No separate `is_deleted`/`deleted_at`
   column was added** — `isActive` has exactly one producer in this codebase
   (`deleteAccount` itself) and exactly one meaning (can this row authenticate?), so a
   parallel `is_deleted` flag would be pure redundant state. The pre-existing
   `trg_users_updated_at` DB trigger (schema_augmentation migration) stamps `updatedAt`
   with `clock_timestamp()` on every `UPDATE` to `users`, including this one, so
   `updatedAt` already doubles as the deletion timestamp with zero extra code.
2. `urls`: soft-delete (`is_deleted = true`) every row owned by the user — identical to
   the existing single-URL soft-delete path.
3. `refresh_tokens`: hard-delete every row for the user (no retention need — this also
   purges the account-linked raw User-Agent string, the one piece of account-tied PII
   that was previously stored unhashed).

**Auth requirement:** the endpoint (`DELETE /api/auth/account`) requires the current
password in the body, not just a valid access token — an access token alone (15-min,
stateless, can't be revoked) is not enough authorization for an irreversible action.

**Interview Question This Answers:**
"How do you let a user delete their account without destroying analytics history for
other data that references them?"

---

### Decision 14: Geo Enrichment Data Minimization (Country Only, Never Log Raw IP)

**Added:** 2026-07-15, as part of the same audit.

**Problem:**
The worker's geo-IP lookup (`ip-api.com`) requested and stored `city` alongside
`countryCode`, even though the entire locked analytics contract only ever surfaces
country-level data. A debug log line also logged the *raw* input IP next to the geo
response — directly contradicting this file's own documented guarantee ("the raw IP is
never stored or logged", `hashIp()` in `analytics.job.ts`).

**Why Country-Only (and No Raw-IP Logging) Wins:**

| Before | After |
|---|---|
| `fields=status,countryCode,city` sent to a third party | `fields=status,countryCode` only |
| `city` stored in `click_events` and returned by `GET /api/analytics/:shortCode/events` | `city` never requested; column stays unpopulated going forward |
| `logger.debug({ ip, body }, ...)` — raw IP in logs at debug level | `logger.debug({ body }, ...)` — no raw IP anywhere |

**Principle:** don't request, store, or transmit more precision than the product
actually uses. City-level per-click location is a materially higher privacy risk than
a country code, and it was being sent to (and stored from) a third party for a feature
that doesn't exist.

**Interview Question This Answers:**
"How do you audit a third-party integration for data minimization?"

---

### Decision 15: Trust Proxy Scope (Loopback, Not Wildcard)

**Added:** 2026-07-16, alongside a pass over the error handler, cookie flags, and CSP.

**Problem:**
`api` and `redirect` sit behind nginx on the same EC2 host ([[project_deployment_topology_ec2_same_host]]).
Fastify's `request.ip` has to reflect the real client IP — the per-IP login/register/redirect
rate limiters key off it, and so does the analytics pipeline's IP-hashing + geo lookup. Neither
Fastify instance had a `trustProxy` setting at all before this change, and naively trusting the
proxy chain is its own hazard.

**Why `'loopback'` Wins:**

| `trustProxy: true` | `trustProxy` unset | **`'loopback'` (chosen)** |
|---|---|---|
| ❌ Trusts the *entire* `X-Forwarded-For` chain — a caller can prepend a forged IP before it reaches nginx | ❌ Reads the raw socket peer — always `127.0.0.1` in this topology (nginx is the only thing that ever connects) | ✅ Trusts only the immediate socket peer (nginx) and reads the `X-Forwarded-For` entry *nginx itself* appended |
| ❌ Bypasses per-IP rate limits; poisons click analytics (unique-visitor hashing + geo lookup both key off `request.ip`) | ❌ Every request collapses into one shared IP — rate limits and per-visitor analytics become meaningless | ✅ Anything an external caller injected further up the chain is ignored |

**Implementation:** `Fastify({ trustProxy: 'loopback' })` in both `api/src/app.ts` and
`redirect/src/app.ts`.

**Trade-off Accepted:**
This is coupled to the current deployment topology (single EC2 host, nginx same-box). If a
different reverse proxy or an additional hop (e.g. a CDN in front of nginx) is introduced,
`'loopback'` must be revisited — likely to a list of trusted hop IPs — or client IPs will
silently resolve to the wrong hop again.

**Interview Question This Answers:**
"You're already behind a reverse proxy — why scope `trustProxy` to `'loopback'` instead of
just setting it to `true`?"

---

### Decision 16: Auth Endpoint Rate Limiting — Per-IP + Per-Account

**Added:** 2026-07-16. The per-IP guards landed first; a same-day security review (checking
IDOR, auth bypass, and abuse paths against the running code) found the per-IP-only version
insufficient and the per-account guard was added immediately after.

**Problem:**
`POST /api/auth/register` and `POST /api/auth/login` had **no rate limiting at all** — nothing
stopped mass account creation or unlimited login attempts against any account.

**Step 1 — Per-IP (closes the obvious gap):**
Two independent fixed-window buckets, keyed by `request.ip` (see Decision 15 for why that's
trustworthy here): `rl:register:<ip>` and `rl:login:<ip>`, 5 requests / 60s each by default
(`RATE_LIMIT_REGISTER_LIMIT`/`_WINDOW_SECS`, `RATE_LIMIT_LOGIN_LIMIT`/`_WINDOW_SECS`).

**Step 2 — Per-account (closes the gap Step 1 leaves open):**
Per-IP limiting alone doesn't stop a *distributed* attacker: a botnet or residential-proxy
pool gets a fresh 5-request allowance on every new source IP, so the **target account** is
never throttled even though each individual IP is. A second guard on `/login` — keyed by the
submitted email, not the caller's IP (`rl:login:acct:<email>`, default 10 requests / 900s) —
means every attempt against the *same account* shares one bucket regardless of how many IPs
the attacker rotates through.

```
Per-IP only:                              Per-IP + per-account:
  attacker rotates 1000 IPs        attacker rotates 1000 IPs
  → 1000 × 5 = 5000 guesses         → still capped at 10 guesses total
    against the victim account        against the victim account
```

**Why Not Account Lockout:**
Locking the account after N failures would let an attacker **deny a legitimate user access**
just by deliberately failing their login a few times — trading an availability problem for
users for a weaker attacker deterrent. A time-boxed rate limit (not a lockout) bounds the
attacker's guess rate without giving them a griefing lever.

**Why Not CAPTCHA:**
Effective against scripted abuse but adds a third-party dependency and login-flow friction;
deferred — the rate-limit combination above closes the practical gap without it.

**Implementation Detail:** the per-account key reads `request.body.email` in the `preHandler`,
*before* Zod validates it in the route handler (Fastify's body-parsing runs ahead of
`preHandler` in the request lifecycle, even though validation happens later in this codebase's
Zod-in-handler pattern). A missing/malformed email is normalized to one shared `unknown`
bucket — acceptable, since that request fails Zod validation immediately after anyway.

**Interview Question This Answers:**
"You rate-limit login by IP — an attacker still gets through with a botnet. What closes that
gap, and why not just lock the account after N failures?"

---

## What Must Be Locked Before Day 1

- [ ] All 10 decisions documented with rationale
- [ ] Each decision has an interview question answer
- [ ] Race conditions identified and mitigated
- [ ] Scale assumptions documented (100M URLs/day)
- [ ] Trade-offs explicitly called out (never hidden)
- [ ] All decisions reviewed and approved by team

---

## Future Decisions (Post-MVP)

| Decision | Current Approach | Future Option | When |
|----------|---|---|---|
| Pre-aggregation | None (raw Click table) | DailyAnalyticsAggregate table | >1M clicks |
| Worker location | Same process | Separate service | If worker crashes often |
| Caching layer | Valkey | Redis Cluster | Multi-region deployment |
| Database | PostgreSQL single | PostgreSQL read replicas | >10K concurrent |
| Rate limiter storage | Valkey | Dedicated instance | If Valkey becomes bottleneck |
