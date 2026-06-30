# Design Decisions — URL Shortener

**Status:** Locked (Pre-Implementation)  
**Last Updated:** 2026-06-16 (added Decision 12 — IST analytics bucketing)  
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
