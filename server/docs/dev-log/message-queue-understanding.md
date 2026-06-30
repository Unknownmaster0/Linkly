# Message Queue Understanding — BullMQ Analytics Pipeline

## Overview

Every redirect fires an analytics event. That event travels through a BullMQ job queue
backed by Valkey (Redis-compatible) before landing in PostgreSQL. The pipeline has three
distinct processes: the **redirect server** (producer), **Valkey** (broker/store), and the
**worker** (consumer).

```
User clicks short link
       │
       ▼
redirect/:shortCode  ──(void, fire-and-forget)──▶  Valkey "click-events" queue
                                                          │
                                                          ▼
                                                    BullMQ Worker
                                                    (concurrency 10)
                                                          │
                                          ┌───────────────┼──────────────┐
                                          ▼               ▼              ▼
                                    Geo lookup       UA parse       IP hash
                                          │               │              │
                                          └───────────────┴──────────────┘
                                                          │
                                                   insertClick()
                                                          │
                                                   recordClick()  ──▶  pending Map
                                                                            │
                                                                  (size=100 OR 5s)
                                                                            │
                                                                  batchIncrementClickCount()
                                                                            │
                                                                    urls.click_count
```

---

## 1. Enqueue — Producer Side (redirect server)

**File:** `redirect/src/routes/redirect.ts`  
**File:** `redirect/src/plugins/queue.ts`

When the redirect server resolves a short code and issues the 302, it immediately fires a
job into the queue without waiting for it:

```ts
void app.queue.enqueueClick(buildClickJob(request, shortCode))
```

The `void` keyword is intentional — this is fire-and-forget by design. The response is
already sent; waiting for the queue would add latency to every redirect.

`buildClickJob()` extracts: `shortCode`, `ip` (raw), `userAgent`, `referrer`, and `ts`
(timestamp). This is the job payload — a plain `ClickJob` object defined in
`shared/src/queue.ts`.

**Queue plugin config (BullMQ `Queue`):**
- Queue name: `click-events` (constant from `shared/src/queue.ts`)
- Retry: 3 attempts, exponential backoff starting at 1 second
- On success: job removed immediately (`removeOnComplete: true`)
- On failure: job kept for 1000ms for visibility, then removed (`removeOnFail: 1000`)
- Fail-open: if Valkey is unreachable, the error is caught and logged — the redirect
  still succeeds (analytics loss is acceptable; redirect failure is not)

---

## 2. Where Jobs Live — Valkey (the broker)

BullMQ uses Valkey (Redis-compatible) as its job broker. A submitted job is not stored in
PostgreSQL or memory — it lives exclusively in Valkey until a worker picks it up.

BullMQ organises jobs into several sorted sets and lists in Valkey:

| Valkey key (logical) | Meaning |
|---|---|
| `bull:click-events:wait` | Jobs waiting to be picked up |
| `bull:click-events:active` | Jobs currently being processed by a worker |
| `bull:click-events:failed` | Jobs that exhausted all retry attempts |
| `bull:click-events:completed` | Completed jobs (cleared immediately here) |
| `bull:click-events:delayed` | Jobs waiting for backoff timer to expire |

When a worker picks up a job it moves from `wait` → `active`. If the processor throws, BullMQ
moves it to `delayed` (backoff wait) and eventually back to `wait` for the next attempt.
After 3 failed attempts it moves to `failed`.

**Persistence and process crash:**  
Because jobs live in Valkey (not in the worker's memory), a worker crash is safe. When the
worker restarts, BullMQ automatically moves any `active` jobs that were orphaned back to
`wait` after a stall detection timeout. This means no clicks are silently dropped due to a
process crash — they are retried.

---

## 3. Consume — Worker Side (the processor)

**File:** `worker/src/worker.ts`  
**File:** `worker/src/jobs/analytics.job.ts`

The BullMQ `Worker` class subscribes to the `click-events` queue with concurrency 10 — it
can process 10 jobs simultaneously.

For each job, `createClickProcessor` runs the following steps:

### Step 1 — Resolve URL id
```ts
const urlId = await repo.resolveUrlId(job.data.shortCode)
if (!urlId) return   // URL deleted or unknown → discard, no retry
```
If the URL does not exist (e.g. was soft-deleted after the click was enqueued), the job is
silently discarded. There is no point retrying a job for a URL that no longer exists.

### Step 2 — Geo lookup (best-effort)
```ts
const geo = GEO_ENABLED ? await geoLookup(ip, GEO_TIMEOUT_MS) : null
```
Calls ip-api.com with a configurable timeout (default 2s). If the lookup times out or
errors, `geo` is null and the click is still inserted — country is just unknown.

### Step 3 — Parse User-Agent
```ts
const ua = new UAParser(job.data.userAgent).getResult()
```
Extracts device type, browser name, and OS from the user-agent string.

### Step 4 — Hash the IP
```ts
const ipHash = sha256(ip + istDay + IP_HASH_SECRET)
```
The raw IP is never stored. It is one-way hashed using SHA256 with a daily rotating salt
(`IP_HASH_SECRET + IST calendar day`). The same visitor gets the same hash within a single
IST day, enabling unique-visitor counting in aggregations. The hash changes the next day,
making it non-reversible across days.

### Step 5 — Insert click event
```ts
await repo.insertClick({ urlId, ipHash, country, device, browser, referrer, clickedAt })
```
One row in `click_events` per click.

### Step 6 — Record the click for denormalization
```ts
recordClick(urlId)
```
This is where the `pending` map comes in — explained in the next section.

---

## 4. The `pending` Map and `recordClick`

**File:** `worker/src/worker.ts`

`urls.click_count` is a denormalized counter — a running total kept on the URL row itself
for fast `GET /api/urls` responses (no need to `COUNT(*)` click_events every time).

Updating `click_count` after every single job would cause a thundering-herd problem under
high traffic: 10 concurrent workers each doing `UPDATE urls SET click_count = click_count + 1`
would serialize on row-level locks.

The solution is a **batching accumulator** in worker memory:

```ts
let pending = new Map<bigint, number>()   // urlId → delta

function recordClick(urlId: bigint) {
  pending.set(urlId, (pending.get(urlId) ?? 0) + 1)
}
```

`recordClick` does no I/O — it just increments a counter in the map. The map accumulates
deltas across all concurrent job executions.

### Flush — when does the batch write happen?

A single `flush()` function drains the map and writes to Postgres:

```ts
async function flush() {
  if (pending.size === 0) return
  const snapshot = pending
  pending = new Map()           // swap to empty map immediately
  await repo.batchIncrementClickCount(snapshot)
}
```

`batchIncrementClickCount` runs all increments in a single Prisma transaction:
```sql
UPDATE urls SET click_count = click_count + <delta> WHERE id = <urlId>
```
N URLs → N updates inside one transaction, not N separate transactions.

**Flush is triggered by two conditions (whichever comes first):**

| Trigger | Config | Default |
|---|---|---|
| Map reaches size threshold | `CLICK_BATCH_SIZE` | 100 jobs |
| Interval timer fires | `CLICK_FLUSH_MS` | 5 000 ms (5 s) |

This means `click_count` on a URL row may lag up to 5 seconds behind the true count — an
acceptable tradeoff for eliminating write contention.

### Failure recovery in the flush

```ts
async function flush() {
  const snapshot = pending
  pending = new Map()
  try {
    await repo.batchIncrementClickCount(snapshot)
  } catch (err) {
    // Merge snapshot back in — don't lose the counts
    for (const [id, delta] of snapshot) {
      pending.set(id, (pending.get(id) ?? 0) + delta)
    }
    logger.error({ err }, 'flush failed — counts re-queued into pending')
  }
}
```

If the Postgres write fails, the snapshot is **merged back** into `pending`. Counts are not
lost — they wait for the next flush attempt. This is the only place in the worker that
catches errors intentionally.

---

## 5. Process Crash Recovery

### Worker crash (mid-job)

When the worker process dies while a job is `active`:

1. BullMQ uses a lock on each active job (a Valkey key with TTL).
2. When the lock expires (stall detection interval), BullMQ's stall checker moves the
   orphaned job back from `active` to `wait`.
3. The next worker instance picks it up and processes it again.

This means a job may be processed **more than once** in a crash scenario. The click
insertion is not idempotent by design (unique constraint only on `ip_hash + url_id +
clicked_at`, not a strict dedup). Rare duplicate clicks are acceptable — they are
negligible vs. the complexity of a fully idempotent write path.

### Worker crash (mid-flush)

If the worker crashes during `flush()` (after `pending = new Map()` but before the Prisma
write commits):

- Those deltas are lost from `click_count`.
- The raw `click_events` rows are already written (inserted in Step 5 before `recordClick`).
- `click_count` can be rebuilt at any time from `COUNT(click_events)` if needed.
- This is a known, accepted trade-off: `click_count` is a best-effort cache, not the
  source of truth.

### Graceful shutdown sequence

`shared/src/shutdown.ts` orchestrates shutdown in the correct order:

```
1. Stop cron tasks + clear flush interval timer
2. worker.close()  — stop accepting new jobs, let in-flight jobs finish
3. flush()         — final drain of pending map to Postgres
4. prisma.$disconnect()
5. Valkey quit
```

The graceful shutdown ensures that:
- No jobs are abandoned mid-flight
- The pending map is drained before the DB connection closes
- Valkey is released cleanly

---

## 6. Cron Jobs (also run in the worker)

Two cron jobs run in the same worker process alongside the click consumer:

### Aggregation — 00:15 IST daily
**File:** `worker/src/jobs/aggregation.job.ts`  
**File:** `worker/src/repositories/aggregate.repository.ts`

Rolls up the previous IST calendar day's `click_events` into
`daily_analytics_aggregates`. The raw SQL upsert groups by `url_id`, computes:
- Total clicks
- Distinct visitors (by `ip_hash`)
- Top countries, top referrers, device breakdown

Uses `AT TIME ZONE 'Asia/Kolkata'` to convert UTC-stored timestamps to IST day boundaries.
The upsert is idempotent — safe to re-run for the same day if the cron fires twice.

### Expiry — 01:00 IST daily
**File:** `worker/src/jobs/expiry.job.ts`  
**File:** `worker/src/repositories/url.repository.ts`

Soft-deletes all URLs where `expires_at < now AND is_deleted = false`.
The redirect server already handles expired URLs lazily (returns 410 on access), so this
cron is a hygiene pass to keep partial indexes lean. Hard `DELETE` is never used — the
`is_deleted` flag preserves analytics history.

---

## 7. Config Reference

| Env var | Default | Meaning |
|---|---|---|
| `CLICK_BATCH_SIZE` | 100 | Flush `pending` after this many jobs |
| `CLICK_FLUSH_MS` | 5000 | Flush `pending` every N ms (interval trigger) |
| `WORKER_CONCURRENCY` | 10 | Concurrent BullMQ job slots |
| `GEO_ENABLED` | true | Enable/disable ip-api.com lookups |
| `GEO_TIMEOUT_MS` | 2000 | Per-lookup timeout in ms |
| `IP_HASH_SECRET` | — | HMAC salt for IP hashing (rotate daily) |

---

## 8. End-to-End Summary

```
1. User hits redirect/:shortCode
2. Redirect server resolves short code → issues 302
3. void enqueueClick(...)  ← fire-and-forget, never awaited
4. Job lands in Valkey "click-events:wait" list
5. BullMQ Worker (concurrency 10) picks up job → moves to "click-events:active"
6. analytics.job.ts processor runs:
     a. resolveUrlId(shortCode)  → urlId (or discard)
     b. geoLookup(ip)            → country (or null)
     c. UAParser(userAgent)      → device/browser
     d. sha256(ip+day+secret)    → ipHash
     e. insertClick(...)         → click_events row written
     f. recordClick(urlId)       → pending.set(urlId, n+1)  [no I/O]
7. Job completes → removed from Valkey
8. When pending.size === 100 OR flush timer fires:
     flush() → batchIncrementClickCount(pending) → UPDATE urls SET click_count = click_count + delta
9. If worker crashes: Valkey stall detection re-queues orphaned jobs
10. On shutdown: final flush() drains pending before process exits
```
