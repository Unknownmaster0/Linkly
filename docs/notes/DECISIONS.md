# Design Decisions — URL Shortener

**Status:** Locked (Pre-Implementation)  
**Last Updated:** 2026-08-04 (Decisions 18–26 added — system hardening: access-token
revocation via jti denylist, access-token TTL 15m→10m, refresh-token reuse detection,
click-event + duplicate-URL idempotency, 405-vs-404, tiered timeouts, keyset pagination,
deferred 304; Decision 5 amended to correct its revocation claim)  
**Audience:** Development team, code reviewers

---

## Design Decision Table

| # | Decision | Choice | Why This | Rejected | Trade-off | Failure If Wrong |
|---|----------|--------|---------|----------|-----------|------------------|
| 1 | Redirect Status Code | 302 (Temporary) | Analytics visibility; allows future target updates | 301 (Permanent) | Server sees every redirect; higher load but acceptable with async | Can't measure engagement; browser cache permanent |
| 2 | Counter Strategy | PostgreSQL SEQUENCE | Atomic, lock-free, proven at scale | In-process counter OR Valkey INCR | Ties to PostgreSQL; more complex than simple increment | Race conditions → duplicate short codes (showstopper) |
| 3 | Cache Strategy | Write-through (create) + Cache-aside (first miss) | Immediate availability + memory efficiency | Write-through only OR Cache-aside only | Some URLs cached but never clicked; or first redirect slow | OOM on unchecked cache OR p99 latency > 100ms |
| 4 | Analytics Write | Async BullMQ worker | Redirect latency ≤ 2ms; enables geo enrichment | Sync DB insert in request | Adds queue, worker, retry complexity | Redirect latency 5-50ms; breaks at 100M URLs/day |
| 5 | Token Model | Access (10m) + Refresh (30d in DB) | Revocation possible (refresh via DB; access via jti denylist, Decision 18); theft window limited | Single long-lived JWT | Slightly more complex; refresh endpoint needed | Can't logout users; stolen token valid 30 days |
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
| 17 | Client 401 Handling | Silent refresh + retry once; log out **only** if the refresh itself fails — a 401 that survives a *successful* refresh is surfaced as an error, not a logout | `DELETE /api/auth/account` returns 401 on a wrong password (Decision 13); a refresh that just succeeded proves the session is valid, so that 401 is a business error, not token expiry | Treat every 401 as session-expiry (log out after the retry) OR string-match the error body to detect "wrong password" | A wrong-password attempt still spends one silent-refresh round-trip before the error surfaces | Wrong password on account-deletion (or any future re-auth endpoint) silently logs the user out instead of showing "Invalid password" |
| 18 | Access-Token Revocation | Add a `jti` claim to the access JWT; logout/account-delete writes `revoked:jti:<jti>` in Valkey with TTL = the token's remaining life; `authenticate()` does a fail-open Valkey lookup | Closes the real logout/delete gap — a stateless access token can finally be killed before expiry (security audit SEC-002); stays stateless otherwise | Server-side sessions / token-version `sid` claim (authoritative even when Valkey is down, but every request becomes a session read) | Fail-open by design: during a Valkey outage a revoked token works for ≤ its remaining TTL (bounded, documented degradation); one extra cache read per authenticated request | Logout leaves the access token valid until expiry (a ≤10-min post-logout / post-delete access window) |
| 19 | Access-Token Lifetime | 10 minutes (was 15) | Smaller theft window; every denylist TTL shortens with it; the silent-refresh client (Decision 17) already masks the cost | 15 minutes (status quo) | One more refresh round-trip per actively-used session | 15-min window = longer post-logout / post-delete access-token validity |
| 20 | Refresh-Token Reuse Detection | Presenting a *known-but-revoked* refresh token at `/refresh` revokes **every** active refresh token for that user | A stolen rotated token's whole family is killed; the detection is one branch — Decision 5's "detect suspicious patterns" finally implemented | Ignore reuse (status quo) | A legitimate double-submit refresh also wipes sessions → user re-logs-in | One chain of a rotated/stolen token keeps issuing fresh access tokens for up to 30 days |
| 21 | Click-Event Idempotency | Mint `clickId` (uuid) once in the redirect handler → BullMQ `jobId = clickId` → unique `click_id` index + insert with `ON CONFLICT DO NOTHING` | Closes all three duplicate paths (browser/CDN retry of the 302, BullMQ re-delivery after crash/stall, backoff retry) with the DB as the final authority | Composite unique `(ip_hash, url_id, clicked_at)` (over-collapses legitimate same-IP same-second clicks) | One uuid mint + one unique-index insert per click; migration must backfill existing rows | Retried redirects inflate click counts → misleading analytics |
| 22 | Duplicate-URL Dedup | Partial unique index `(user_id, original_url) WHERE is_deleted = false`; P2002 → 409 | A double-click / network-retry "Create" yields one link deterministically; no header protocol needed | Idempotency-Key header preHandler (deferred — extra moving part) | After soft-delete the pair frees → the same URL can be re-shortened (intended) | A retried create produces two identical links |
| 23 | Wrong-Method Responses | `setNotFoundHandler({ methodNotAllowed: true })` on `api` + `redirect`: 405 + `Allow` header when a route exists at the path (Fastify sets `request.routerMethod`), else 404 — both through the contract envelope | RFC 9110-correct; REST clients depend on 405 + `Allow`; the route table is already public via Swagger, so hiding methods buys nothing | 404-everything (status quo — Fastify's default) | Two branches instead of one; must not blur into Decision 7's ownership-404 | Wrong-method requests return a non-contract `{message, error, statusCode}` 404 with no `Allow` header |
| 24 | Timeout Strategy | Tiered budget — nginx `proxy_*_timeout` (edge backstop) → Fastify `requestTimeout` + Node `keepAliveTimeout`/`requestTimeout` (app owns the 504 envelope) → outbound HTTP via `AbortSignal.timeout()` → Prisma `queryTimeout` + `transactionOptions.maxWait`/`timeout` → BullMQ job `timeout` + Worker `lockDuration` | Each layer handles its own failure domain; the app, not nginx's passive 60s default, is always the one producing 504 | A single global timeout | More knobs to tune and keep consistent | Slow DB queries hang until nginx 504s the client; stalled worker jobs never get killed/retried |
| 25 | URL List Pagination | Keyset/cursor on `(createdAt, id)` + `limit`/`hasMore`/`nextCursor`; filters `dateFrom`/`dateTo`/`q`/`sortBy`/`sortOrder` (whitelist) | O(1)-ish per page at any depth — no deep-scan cost at 100k+ rows | limit/offset (deep-scans late pages; `/analytics/events` keeps it — bounded window) | Breaking response-shape change → client updated in lockstep; composite index + `id` tiebreak | Every list call fetches the full table |
| 26 | Conditional Caching (304/ETag) | Deferred — keep `no-store` on authenticated requests; no ETag | Auth'd data must stay out of shared caches (private/no-store); revalidation saves bandwidth, not the DB work that pagination (Decision 25) fixes; no cheap source of truth yet | Implement an ETag on `GET /api/urls` now | None today (deferral) — revisit if polling frequency justifies a `MAX(updated_at)`-keyed ETag | Polling stays bandwidth-heavy (acceptable at current frequency) |

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

> **Amended 2026-08-04 (Decision 21):** the async write is now *dedup-safe*. Every click is
> minted a stable `clickId` in the redirect handler and that id is reused as the BullMQ `jobId`
> (queue-level dedup) and as the unique `click_id` key at insert (`ON CONFLICT DO NOTHING`,
> DB-level backstop). Retried redirects / re-delivered / backoff-retried jobs can no longer
> inflate analytics.

**Interview Question This Answers:**
"Walk me through why BullMQ matters for a URL shortener at scale."

---

### Decision 5: Token Model (Two-Token vs Single Long-Lived)

> **Amended 2026-08-04:** the access-token lifetime below changed 15 min → 10 min (Decision 19),
> and the "Can revoke tokens" claim in the table is now accurate: refresh tokens were always
> revocable (DB row), and access tokens became revocable via the jti denylist (Decision 18).
> Reuse detection for rotated refresh tokens is Decision 20.

**Problem:**
How to balance security (short-lived tokens) with usability (user shouldn't re-login every 10 minutes)?

**Why Two-Token Wins:**

| Two-Token | Single Long-Lived |
|---|---|
| ✅ Theft window is 10 min (access token) | ❌ Theft window is 30 days (massive exposure) |
| ✅ Can revoke tokens (logout works) | ❌ Can't revoke (token valid until expiry) |
| ✅ Detect suspicious patterns (refresh attempts) | ❌ No pattern detection |
| ❌ More complex (refresh endpoint) | ✅ Simpler |

**Token Pair Semantics:**
- **Access Token:** 10 min expiry, stateless, signed with JWT_SECRET, used for API calls.
  Revocation-capable via a `jti` denylist (Decision 18).
- **Refresh Token:** 30 day expiry, stored as hashed value in DB, returned in httpOnly cookie, used to get new access token. Rotated on every refresh (revoke old → issue new); a presented *revoked* token triggers full-session revocation (Decision 20).

**Revocation Flow:**
```javascript
// User logs out
POST /api/auth/logout
  → Mark refresh token as revoked in DB
  → Add the access token's jti to the denylist (TTL = remaining life) [Decision 18]
  → Clear cookie
  → Future refresh attempts fail
  → Future use of the same access token fails

// Stolen access token (10 min window)
  → Can use for 10 min max
  → Then expires, attacker needs refresh token
  → But refresh token is in secure httpOnly cookie (can't steal via XSS)
  → If the attacker stole the refresh token too and used it after logout,
    the reuse detection (Decision 20) revokes every session for that user
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

> **Amended 2026-08-04 (Decision 23):** this resource-level "404, never 403/404-leak" rule is
> unchanged. It is distinct from *method-level* 404s: a known path with an unsupported HTTP
> method now returns **405 + `Allow`** (a route exists at that path; Fastify's
> `setNotFoundHandler({ methodNotAllowed: true })` detects it via `request.routerMethod`). The
> two cases differ because the route table is already public (Swagger UI is served), so a 405
> reveals nothing an attacker can't read from `/docs`.

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
4. Redirect cache: evict every owned short code the same way the single-URL delete path
   does (Decision 9) — `url:<code>` deleted, `DELETED:<code>` negative-cache marker set
   (30s TTL). Added 2026-07-20 (**Addendum**, below) — the original 2026-07-15
   implementation omitted this step.

**Auth requirement:** the endpoint (`DELETE /api/auth/account`) requires the current
password in the body, not just a valid access token — an access token alone (10-min,
stateless) is not enough authorization for an irreversible action.

**Interview Question This Answers:**
"How do you let a user delete their account without destroying analytics history for
other data that references them?"

**Addendum (2026-07-20 — SEC-001):** the original transaction returned `void`, so no short
codes ever surfaced for the route handler to evict from Valkey — deleted accounts' previously-
cached links kept resolving for up to the cache TTL (24h). Fixed by having `deleteAccount`
`select` the affected `shortCode`s (as the first statement in the same `$transaction`, so it
captures the same rows under normal operation — a residual same-user race under the default
Read Committed isolation is harmless, see the security-audit doc) and return them; the route
handler evicts
all of them concurrently via `Promise.all`, mirroring Decision 9's single-URL cache eviction
per code. An async BullMQ-job alternative was considered and rejected — it doesn't avoid the
same repository read, and would have added a new queue, a new `api` queue producer, a new
Valkey client in `worker` (which has none today), and a new silent-failure mode, for an
endpoint that is rare and already not on the hot path. See `server/docs/dev-todos/security-
audit-2026-07-20.md` (SEC-001) for the full writeup.

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

### Decision 17: Client 401 Handling (Logout Only on Failed Refresh)

**Added:** 2026-07-17, when wiring the frontend delete-account UI to `DELETE /api/auth/account`.

**Problem:**
The client fetch wrapper (`client/src/lib/api-client.ts`) treats a `401` as "the 10-minute
access token expired": it runs a single-flight silent refresh, retries the request once, and —
if it is *still* 401 — clears the token and logs the user out. That assumption breaks for
`DELETE /api/auth/account`, which returns `401 { error: "Invalid password" }` when the
re-verification password is wrong (Decision 13 requires the password, not just a valid access
token). A mistyped password would therefore refresh → retry → still-401 → **force a logout**
instead of showing "Invalid password". `POST /api/auth/login` sidesteps this by being an
*unauthenticated* call (`auth: false`, which skips the whole refresh/logout block), but a
delete needs the Bearer token, so it can't use that escape hatch.

**Why "logout only on failed refresh" Wins:**

| Treat every 401 as session-expiry (old) | Match the error-body string | **Logout only if the refresh fails (chosen)** |
|---|---|---|
| ❌ Wrong password on delete → surprise logout | ✅ Precise | ✅ No surprise logout |
| ✅ Simple | ❌ Brittle — couples client to server copy; a reword silently reintroduces the bug | ✅ No string matching |
| | ❌ Must parse the envelope before deciding | ✅ Uses the refresh *outcome* — the one reliable signal |

**The insight:** a 401 that **survives a successful refresh** cannot be a token problem — the
successful refresh just proved the session is valid — so it must be a business 401. Only a
*failed* refresh means the session is genuinely dead.

**Implementation (`api-client.ts` → `apiFetch`):**
```ts
if (res.status === 401 && opts.auth !== false) {
  const refreshed = await performSilentRefresh();
  if (refreshed) {
    res = await rawFetch(path, opts);   // retry once; a lingering 401 falls through as ApiError
  } else {
    setAccessToken(null);               // refresh failed → session dead → log out
    callbacks.onUnauthorized?.();
  }
}
```
The delete-account dialog renders the surfaced `ApiError` ("Invalid password") inline and keeps
the user signed in. The rule generalizes to any future re-auth endpoint (change-password,
re-authentication before a sensitive action).

**Trade-off Accepted:**
A wrong-password attempt still spends one silent-refresh round-trip before the error surfaces
(harmless — wrong passwords are rare and the auth endpoints are rate limited, Decision 16). For
a *normal* endpoint, a 401 that survives a successful refresh (anomalous — clock skew, key
mismatch) now surfaces as an error rather than a logout; a genuinely dead session still logs out
on the next *failed* refresh.

**Interview Question This Answers:**
"Your client auto-refreshes on 401 and logs out if the retry still 401s. What breaks when an
authenticated endpoint returns 401 for a wrong password, and how do you fix it without
string-matching the error message?"

---

### Decision 18: Access-Token Revocation — jti Denylist (Valkey, TTL'd, Fail-Open)

**Added:** 2026-08-04. Closes security-audit finding **SEC-002**.

**Problem:**
Logout (and account deletion) revokes the refresh token, but the stateless access
token was verified by signature only — it survived logout until expiry. The security audit
called this out explicitly: a just-deleted/deactivated account keeps API access for the full
access-token lifetime because `authenticate()` never loads the user row.

**The motivating scenario:**
> An attacker steals the access token (the user copies both tokens, or XSS-era exfiltration).
> The user logs out. The refresh token dies instantly. The access token keeps authorizing
> `POST /api/urls` and reads of owned analytics for up to its full lifetime (10 min under
> Decision 19). During that window the attacker — or the just-deleted account — can still act.

**Why the jti denylist wins:**

| jti denylist (chosen) | Server-side session / token-version (`sid`) |
|---|---|
| ✅ One claim + one TTL'd cache write on logout; one `GET` per authed request | ✅ Authoritative even when Valkey is down |
| ✅ Access token stays stateless — no session read on the hot path | ❌ Every request becomes a session read (DB or cache) — statelessness is gone |
| ✅ Bounded degradation: Valkey down ⇒ revoked token usable ≤ its remaining TTL | ❌ Session state must be created, cached, and invalidated |

**The fail-open trade-off (locked, documented):**
Redis/Valkey is a cache, never the authority. If Valkey is unreachable, the denylist lookup
*fails open* (exactly like `rateLimitCheck` in `plugins/cache.ts`): a revoked access token
works for at most its remaining TTL. This is a deliberate availability-over-strictness choice,
bounded to ≤10 min by Decision 19.

**Future backstop (designed, not built):** a `revoked_tokens` table
(`jti` PK, `user_id`, `expires_at`, `created_at`) consulted **only when the Valkey lookup
errors**, so revocation stays authoritative during a Redis outage — correctness at the cost of
a DB read in the degraded path only. Rows purged by the existing nightly expiry cron. Add it
if strict revocation during Valkey outages becomes a hard requirement.

**Interview Question This Answers:**
"Your access token is a stateless JWT that survives logout. How do you revoke it, and what
happens to revocation when your cache is down?"

---

### Decision 19: Access-Token Lifetime (15m → 10m)

**Added:** 2026-08-04.

**Problem:**
Every un-revocable (or fail-open) access token has a theft window equal to its lifetime. The
denylist from Decision 18 only *shortens effective* exposure at logout time; the lifetime still
bounds how long a stolen token works before any revocation is even possible.

**Why 10 minutes wins:**
- Cuts the post-theft and post-logout window by a third (10 min vs 15 min).
- Every denylist TTL written at logout shrinks with it.
- The client already runs a silent refresh on 401 (Decision 17), so an actively-used session
  never notices the extra refresh — the refresh round-trip is hidden and the auth endpoints
  are rate-limited (Decision 16).

**Trade-off Accepted:** one more silent-refresh round-trip per actively-used session than at
15 min. Negligible against the security win.

**Doc sweep:** all references to a 15-minute access token were updated to 10 minutes across
`DECISIONS.md` (D5/D17), `API_CONTRACT.md`, `SYSTEM_FLOWS.md`, `url-shortener-expert-plan.md`,
`url-shortener-system-design.md`, `sections/section-2-*`, `sections/section-3-*`,
`server/docs/notes/exception-handling-strategy.md`, and the security-audit writeup.

**Interview Question This Answers:**
"Why 10 minutes instead of 15 — doesn't the user get logged out more often?"

---

### Decision 20: Refresh-Token Reuse Detection — Revoke All Sessions

**Added:** 2026-08-04. Closes security-audit finding **SEC-005** (rotation race) and extends
Decision 5's "detect suspicious patterns".

**The motivating scenario:**
> Attacker steals both tokens. User logs out: the refresh token is revoked in the DB, so the
> attacker's copy of it is now dead. But suppose the attacker *used* the refresh token once
> before the user noticed (rotation issued them a new pair), then the user logged out —
> revoking only the *current* row. The attacker's newly-minted refresh token chain is still
> alive and keeps issuing fresh access tokens for up to 30 days.

**Why "revoke everything on reuse" wins:**
`refresh()` already rotates (revoke old row → issue new pair). Today a presented token that is
*found but already revoked* is indistinguishable from "not found" — both throw the same
`AuthError`. Making the revoked case detectable (surface "token existed but was revoked") lets
the server treat it as a reuse signal and revoke **every** active refresh row for that user.
One old copy reused ⇒ the whole session family dies. This is the standard stolen-token-family
kill-switch.

**Related hardening (SEC-005):** gate rotation on the revoke's affected-row count — issue a new
pair only when `updateMany ... where revokedAt: null` returns `count === 1`. Closes the
check-then-revoke race where two concurrent refreshes with the same cookie both mint chains.

**Trade-off Accepted:** a legitimate double-submit refresh (two tabs racing on one cookie)
also triggers the sweep and forces a re-login. Rare, safe, and the client's silent-refresh
single-flight already makes it rarer.

**Interview Question This Answers:**
"Rotation revokes the old token. What stops a *rotated* stolen chain from living for 30 days,
and why does one dead token reuse kill everything?"

---

### Decision 21: Click-Event Idempotency (clickId + jobId + ON CONFLICT DO NOTHING)

**Added:** 2026-08-04.

**Problem:**
Analytics were being inflated by duplicate click events from three independent sources:
(1) browsers/CDNs retrying the 302 redirect, (2) BullMQ re-delivering a job after a worker
crash/stall, (3) the 3-attempt exponential-backoff retry. Every duplicate source used a fresh
random job id, and `click_events` had no unique constraint — the composite
`(ip_hash, url_id, clicked_at)` unique index the docs claimed was never applied (the schema
only has `@@index([urlId, clickedAt])`, which is a lookup index, not a uniqueness guarantee).

**The motivating scenario:**
> A flaky mobile network double-fires `GET /abc123`. Both requests 302 correctly and both
> enqueue a click. The worker also crashes mid-job once and BullMQ re-delivers it. Result:
> 3–4 rows for what was one human click. Every day's totals, referrer splits, and country
> charts are quietly wrong by the retry rate.

**Why "stable id, three layers" wins:**

| Layer | Mechanism | Kills |
|---|---|---|
| Redirect handler | mint one `clickId` (uuid) | sources a fresh id per *logical* click |
| BullMQ | `jobId = clickId` | duplicate enqueues dropped at the queue |
| DB | unique `click_id` index + `ON CONFLICT DO NOTHING` | any survivor, even across queue loss |

The DB is the single source of truth even if Valkey/BullMQ fully degrade — a duplicated job
that bypasses both earlier layers still can't double-insert. `clickId` is precise: it does not
over-collapse legitimate same-IP clicks in the same second (the flaw in the composite
`ip_hash+url_id+clicked_at` approach).

**Trade-off Accepted:** one uuid mint per redirect and one unique-index insert per click, plus
a migration that backfills existing rows (`click_id` nullable + backfill pass, or generate for
a snapshot window). Cheap relative to a corrected analytics pipeline.

**Interview Question This Answers:**
"A retried redirect can inflate click counts. Where do the duplicates come from, and how do you
make the analytics pipeline idempotent end-to-end?"

---

### Decision 22: Duplicate-URL Dedup (Partial Unique Index → 409)

**Added:** 2026-08-04.

**Problem:**
`POST /api/urls` without a custom alias has no `(userId, originalUrl)` constraint — a
double-click "Create" or a client retry after a lost response produced two identical links.
The custom-alias path was already safe (shared-namespace `@unique`), the auto-code path was not.

**The motivating scenario:**
> A user double-clicks "Shorten". Two links to the same destination appear in their dashboard,
> each with its own analytics that split the traffic. The user has to delete one — and the
> duplicate already consumed a short code from the shared namespace.

**Why a partial unique index wins:**

| Partial unique index (chosen) | Idempotency-Key header |
|---|---|
| ✅ Deterministic — the DB enforces it, no protocol, no client cooperation | ✅ Replays the original 201 exactly |
| ✅ Zero added failure modes on the create path | ❌ New Valkey state + fail-open semantics + cache-vs-DB consistency questions |
| ✅ Matches the email-`@unique` precedent (register) | ❌ Only helps clients that send the header |

`(user_id, original_url) WHERE is_deleted = false` means a soft-deleted link *frees* the pair,
so re-shortening the same URL after deletion works (consistent with soft-delete semantics,
Decision 8). P2002 → the existing 409 envelope.

**Trade-off Accepted:** DB constraint changes double-post behavior from "two links" to "409 —
Resource already exists". A client that retries after a lost 201 now learns the link already
exists. The Idempotency-Key header (which would return the *original* response) remains
documented as a deferred enhancement.

**Interview Question This Answers:**
"How do you stop a double-click on 'Create' from making two identical short links?"

---

### Decision 23: Wrong-Method Responses — 405 vs 404 (with Allow Header)

**Added:** 2026-08-04.

**Problem:**
A wrong HTTP method on a known path (e.g. `PATCH /api/auth/register`) fell through to
Fastify's built-in 404 `{message, error, statusCode}` — which also does not match the locked
error envelope `{error, details?, retryAfter?}`.

**Why 405 (not 404-everything) wins:**
RFC 9110 permits 404 for any unknown resource+method, and 404-everything is a legitimate
anti-enumeration stance. But that stance only pays off when the route table is secret — here
the full OpenAPI surface is served at `/docs`, so hiding methods reveals nothing. 405 is the
semantically correct signal for "route exists, method unsupported", REST clients depend on it,
and the `Allow` header tells the client exactly what it can send instead.

**Chosen approach:** `app.setNotFoundHandler({ methodNotAllowed: true }, handler)` on **both**
`api` and `redirect`:
- Fastify sets `request.routerMethod` when a route exists at the path with a different method
  → **405** + `Allow: GET, POST, ...` + `{ error: "Method Not Allowed" }`.
- Otherwise → **404** `{ error: "Not Found" }`.
Both routed through the contract envelope so the error shape is uniform. This is method-level,
and deliberately distinct from Decision 7's resource-level ownership-404 (never reveal a
resource exists).

**Interview Question This Answers:**
"`PATCH /api/auth/register` returns 404 today. Why switch to 405, and how do you detect the
distinction without re-implementing routing?"

---

### Decision 24: Tiered Timeout Budget (the App Always Produces the 504)

**Added:** 2026-08-04.

**Problem:**
There were no app-level timeouts at all. Only the geo lookup used an `AbortController` (2s).
Prisma had `connectionTimeoutMillis` but no query timeout, BullMQ had attempts/backoff but no
job timeout, and the nginx snippets had no `proxy_read_timeout` — so a slow upstream today
yields **nginx's passive 60s timeout**, a 504 with no contract envelope, produced by a layer
that can't explain what actually hung. The P1008→504 mapping in both error handlers could never
fire because Prisma never timed out.

**The motivating scenario:**
> A transient PostgreSQL stall (lock contention, a huge aggregation query) makes one request
> take 45 seconds. nginx sits idle for 60s then answers 504. The app logs nothing conclusive,
> the client sees a 504 it can't correlate, and the request that was actually about to finish
> was killed anyway. Meanwhile a stalled BullMQ job holds its lock forever because no
> `lockDuration` is set.

**Why a tiered budget (not one global timeout):**

| Layer | Primitive | Failure domain |
|---|---|---|
| nginx | `proxy_connect_timeout` / `proxy_read_timeout` / `proxy_send_timeout` | edge backstop — give up before/after the app, never first |
| Fastify + Node | `requestTimeout` (headers+body), `keepAliveTimeout`, `requestTimeout` | app fails a slow request with its own 504 envelope before nginx has to |
| Outbound HTTP | shared helper on `AbortSignal.timeout(ms)` (replaces the hand-rolled geo `AbortController`) | no external call hangs forever |
| Database | Prisma `queryTimeout` + `transactionOptions.maxWait`/`timeout` | the real 504 producer today — `AbortController` cannot cancel a Prisma query mid-flight |
| Queue jobs | BullMQ job `timeout` + explicit Worker `lockDuration` | stalled processors get killed and retried instead of holding the lock forever |

**Conclusion (locked):** `AbortController` is the right primitive for outbound HTTP only. DB
and queue timeouts need their own primitives. The chain is ordered so the app is always the one
answering 504 — nginx is a backstop, never the first responder.

**Interview Question This Answers:**
"Your Prisma query can hang forever and nginx 504s the client after 60s. Walk me through the
layered timeout budget that makes the app produce the 504 instead."

---

### Decision 25: URL List Pagination — Keyset/Cursor + Filters

**Added:** 2026-08-04. V2 of `GET /api/urls` (the v1 contract explicitly deferred pagination).

**Problem:**
`GET /api/urls` returned the user's entire URL table, hard-coded `createdAt desc`, with no
query parameters. At scale this is an unbounded full-table fetch per dashboard poll.

**The motivating scenario:**
> A power user has 100k links. Every dashboard poll ships all 100k rows. With limit/offset,
> the page for items 90,000–90,050 still forces the DB to scan and discard the first 90k rows
> — O(depth) per page, degrading as the table grows.

**Why keyset/cursor wins:**

| Keyset/cursor (chosen) | limit/offset |
|---|---|
| ✅ Cursor on `(createdAt, id)` → O(1)-ish per page at any depth | ❌ Deep pages scan `offset` rows first |
| ✅ Stable under concurrent inserts (no shifting window) | ⚠️ Inserted rows shift the window between pages |
| ⚠️ Slightly more complex query + an `id` tiebreak | ✅ Simple |

The partial index `(user_id, created_at DESC) WHERE is_deleted = false` (schema_augmentation)
already serves the keyset order. `/analytics/events` keeps offset pagination — a documented
inconsistency, acceptable because that endpoint is bounded to a time window.

**Chosen shape:** query params `limit`, `cursor`, `dateFrom`, `dateTo`, `q` (substring on
originalUrl/shortCode), `sortBy ∈ {createdAt, clickCount, expiresAt}`, `sortOrder ∈ {asc, desc}`
(all whitelisted — never a raw `orderBy` passthrough). Response
`{ urls, nextCursor, hasMore, total }`. Breaking shape change → contract v2 amended and the
client updated in lockstep.

**Interview Question This Answers:**
"At 100k rows, offset pagination degrades. What's the pagination scheme that stays fast on page
90,000, and where do you still accept offset?"

---

### Decision 26: Conditional Caching (304/ETag) — Deferred

**Added:** 2026-08-04.

**The scenario that makes 304 safe:**
Conditional caching (ETag / If-None-Match) is safe for authenticated data *because
revalidation always reaches the server* — a 304 saves bandwidth, never DB work; the server must
still compute the list to compare. `no-store`/`private` is the non-negotiable part: two users
behind a shared corporate proxy or Cloudflare must never be served each other's lists. The
302 redirect path already sends `Cache-Control: no-cache`, which is correct.

**Why it's deferred here:**
Dashboard polls are not high-frequency, and the real cost of `GET /api/urls` is the unbounded
full-table fetch — which Decision 25's pagination fixes far more effectively than a validator
ever would. A worthwhile ETag on the list also needs a cheap source of truth (a
`MAX(updated_at)` query) that doesn't exist yet. This is a "solve the right layer" decision:
304 optimizes bandwidth, pagination optimizes the actual bottleneck.

**Decision:** defer. Keep `no-store` on authenticated client requests. Add a
`MAX(updated_at)`-keyed ETag on the URL list only if polling frequency justifies it.

**Interview Question This Answers:**
"Your dashboard polls an authenticated list. Is ETag/304 worth building, and why is
'no-store' the part you must never give up?"

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
| Access-token revocation backstop | Valkey jti denylist only (D18) | `revoked_tokens` table consulted when Valkey is down | Strict revocation must survive cache outages |
| Idempotency-Key header | DB-constraint dedup (D21/D22) | Valkey replay preHandler for register/login/shorten | Multi-tab / retry-heavy create flows |
| Conditional caching (304/ETag) | `no-store`, no ETag (D26) | `MAX(updated_at)`-keyed ETag on `GET /api/urls` | Polling frequency justifies it |
