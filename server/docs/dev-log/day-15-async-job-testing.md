# Day 15 — Testing the Async Jobs (Aggregation, Expiry) + IST Timezone

> **Status: COMPLETE.** Step 1 (UTC baseline suite) → Step 2 (UTC→IST switch) →
> Step 3 (IST test updates) all done. Suite is **24/24 green** (one IST-bucketing
> integration test added). Locked decision recorded as **DECISIONS.md #12**.
> TODO-006/007 resolved (see `docs/dev-todos/todos.md`).

## Goals

The two nightly cron jobs in the worker — the **00:05 UTC analytics aggregation**
([aggregation.job.ts](../../worker/src/jobs/aggregation.job.ts)) and the
**01:00 UTC expiry sweep** ([expiry.job.ts](../../worker/src/jobs/expiry.job.ts))
— had **zero automated tests**. This day adds full coverage and resolves a
correctness concern about UTC vs IST for an India-facing product.

Two distinct deliverables:

1. **Prove the jobs work and actually change the database** — not just that the
   logic is right, but that the SQL inserts/soft-deletes the rows it should.
2. **Decide and implement IST** — the aggregation bucketed clicks by the **UTC**
   calendar day, 5.5h out of step with what an Indian user means by "a day." Now
   buckets by the IST day via `AT TIME ZONE` (DECISIONS.md #12). Was TODO-006/007,
   now resolved (see `docs/dev-todos/todos.md`).

---

## The core insight: "does the cron work?" is THREE separate claims

Conflating these is what makes cron testing feel fuzzy. Each is proven a
different way:

| Claim | How it's proven | Automated? | Needs DB? |
|---|---|---|---|
| **1. Job logic is correct** (right window, right args, errors swallowed) | Unit test with a fake repo | ✅ fast | No |
| **2. Job changes the database** (rows inserted / soft-deleted) | Integration: run the real job via real Prisma, then `SELECT` and assert | ✅ | **Yes** |
| **3a. Schedule maps to the right time** (00:05 / 01:00, right tz) | `cron-parser` next-fire assertion | ✅ | No |
| **3b. node-cron actually fires on the box** | Manual trigger CLI + start/complete logs (+ optional heartbeat) | ⚠️ operational | — |

**3b cannot be proven by a fast unit test** — it's observed in production via
logs / a dead-man's-switch, and exercised on demand via the manual-trigger CLIs.

---

## Test layers (UTC baseline — Step 1)

| Layer | File | Proves | DB |
|---|---|---|---|
| 1 | `tests/unit/aggregation-window.test.ts` | UTC day-window math: boundary inclusivity (`>= start AND < end`), month/year edges, TZ-determinism | No |
| 2 | `tests/unit/aggregation-job.test.ts` | Job passes exact `(start,end,date)` to repo; repo throw is swallowed (cron must not crash) | No |
| 2 | `tests/unit/expiry-job.test.ts` | Job passes `referenceDate` to `softDeleteExpired`; repo throw swallowed | No |
| 5 | `tests/unit/schedule.test.ts` | `'5 0 * * *'`/`'0 1 * * *'` next-fire = 00:05 / 01:00 UTC (= 05:35 / 06:30 IST) | No |
| 3 | `tests/integration/aggregate.repository.integration.test.ts` | Real SQL: total/unique/jsonb correct, `'direct'` referrer, idempotent `ON CONFLICT`, boundary | **Yes** |
| 3 | `tests/integration/url.repository.integration.test.ts` | Real SQL: only past+undeleted soft-deleted, click_events survive, idempotent | **Yes** |

---

## Tooling decisions

- **Runner: Vitest** (project standard; ESM-native, matches `"type":"module"` + tsx).
- **One command:** `npm run test` → `vitest run --coverage` runs *all* tests +
  HTML coverage. `test:unit` / `test:integration` are subset escape hatches.
- **Integration DB:** reuse the real `PrismaPg` client mechanism from
  [db.ts](../../worker/src/db.ts), but pointed at a **separate
  `urlshortener_test` database** (env `DATABASE_URL_TEST`) on the same
  docker-compose Postgres — so tests exercise the *real engine* without mutating
  dev data. Schema applied by running the existing
  [api migration SQL](../../api/prisma/migrations/) in order.
- **DB down → fail loud:** integration `beforeAll` throws an explicit
  "Postgres + DATABASE_URL_TEST required" error rather than silently skipping.
- **Coverage scope:** `src/jobs/**` + `src/repositories/**` only (generated Prisma
  client, `worker.ts` wiring, config/logger excluded). Report-only HTML at
  `tests/coverage/` (gitignored), no failing threshold.

### How real-world systems do this (for reference)
- Test DB provisioned in CI via a **Postgres service container** or
  **Testcontainers** (ephemeral Postgres per run). Our separate-DB approach maps
  directly onto the service-container pattern when CI is added.
- Cron jobs are **always also runnable on demand** (CLI / admin endpoint) for
  backfills — that's what `job:aggregate` / `job:expire` provide.
- Schedule firing is **observed**, not unit-tested: structured logs + a
  dead-man's-switch (Healthchecks.io / Cronitor) or `last_run_at` heartbeat.

---

## Sequencing

1. **UTC baseline** — build everything above against current behaviour, get green
   (regression safety net). ✅ *done*
2. **UTC→IST switch** — `istYesterday` (date string, not a JS window) + IST salt
   rotation (⚠️ load-bearing for unique-visitor counting) + both crons →
   `timezone: 'Asia/Kolkata'`, firing 00:15 / 01:00 IST. ✅ *done*
3. **Update tests** — Layers 1 & 5 got IST expected values; Layers 2/3 carried over
   (Layer 3 gained an explicit IST-vs-UTC bucketing test). ✅ *done*

---

## Files created / changed — Step 1 (UTC baseline) ✅ DONE

### Tooling
- **`worker/package.json`** — added devDeps (`vitest`, `@vitest/coverage-v8`,
  `cron-parser`) and scripts: `test` (all + coverage), `test:unit`, `test:integration`,
  `test:watch`, `job:aggregate`, `job:expire`.
- **`worker/vitest.config.ts`** (new) — node env, coverage v8 → `tests/coverage/`
  (HTML + text), scope `src/jobs/**` + `src/repositories/**`, `fileParallelism: false`
  (integration files share one DB connection and truncate between tests).
- **`worker/.gitignore`** (new) — ignores `tests/coverage/`, `dist/`, generated client.

### Source (minimal change for testability)
- **`src/jobs/aggregation.job.ts`** — `export` the previously-private `utcDayWindow`
  so Layer 1 can test the boundary math directly. No behaviour change.
- **`src/jobs/run-aggregation.ts`** (new) — CLI: `npm run job:aggregate [-- YYYY-MM-DD]`.
  Runs one aggregation pass against the real DB and exits. Backfill + on-demand verify.
- **`src/jobs/run-expiry.ts`** (new) — CLI: `npm run job:expire [-- <ISO instant>]`.

### Tests
- **`tests/unit/aggregation-window.test.ts`** (Layer 1, 7 tests) — half-open window,
  month/year boundaries, time-of-day independence, **TZ-determinism guard**.
- **`tests/unit/aggregation-job.test.ts`** (Layer 2, 2) — forwards exact `(start,end,date)`;
  swallows repo error.
- **`tests/unit/expiry-job.test.ts`** (Layer 2, 2) — forwards reference date; swallows error.
- **`tests/unit/schedule.test.ts`** (Layer 5, 4) — `cron-parser` proves 00:05/01:00 UTC
  (= 05:35/06:30 IST) + expiry-after-aggregation ordering.
- **`tests/integration/helpers/test-db.ts`** (new) — real `PrismaPg` on `DATABASE_URL_TEST`,
  rebuilds schema from the api migration SQL, fail-loud if DB down, `/test/` name safety rail.
- **`tests/integration/aggregate.repository.integration.test.ts`** (Layer 3, 4) — totals,
  uniques, JSONB breakdowns, `'direct'` referrer, boundary inclusivity, `ON CONFLICT` idempotency.
- **`tests/integration/url.repository.integration.test.ts`** (Layer 3, 4) — soft-delete
  targeting, strict `<` boundary, analytics survival, idempotency.

---

## Verification summary — Step 1

Run: `npm run test` (with `DATABASE_URL_TEST` set + docker-compose Postgres up).

| Check | Result |
|---|---|
| `npm run test:unit` (no DB) | ✅ 15/15 |
| `npm run test:integration` (real Postgres) | ✅ 8/8 |
| `npm run test` (all + coverage HTML) | ✅ 23/23 |
| `tsc --noEmit` on `worker` (incl. new CLIs) | ✅ clean |
| Coverage HTML at `tests/coverage/index.html` | ✅ emitted |
| `aggregation.job.ts` / `expiry.job.ts` coverage | ✅ 100% / 100% |
| `aggregate.repository.ts` / `url.repository.ts` coverage | ✅ 100% / 100% |
| Cron-must-not-crash (repo throw swallowed) | ✅ asserted (Layer 2) |
| Schedule maps to 00:05 / 01:00 (timezone correct) | ✅ asserted (Layer 5) |

> **Coverage note:** `analytics.job.ts` and `click-event.repository.ts` show 0% — they are
> the **Day-7 click-event pipeline**, out of scope for Day 15 (nightly crons). Left visible
> rather than excluded so the worker-wide number stays honest; a future day can cover them.

### How to run the integration layer
```powershell
docker compose up -d postgres                     # ensure Postgres is up
# one-time: create the test DB
docker exec -e PGPASSWORD=secret url-shortner-postgres-1 `
  psql -U admin -d postgres -c "CREATE DATABASE urlshortener_test;"
$env:DATABASE_URL_TEST = "postgresql://admin:secret@localhost:5432/urlshortener_test"
npm run test
```

### Manual job verification (3b — does it run + write the DB)
```powershell
npm run job:aggregate -- 2026-06-13   # roll up that UTC day; check daily_analytics_aggregates
npm run job:expire                    # sweep expired now; check urls.is_deleted
```

---

## Step 2 + 3 — UTC→IST — ✅ DONE

> This section supersedes the earlier "build an `istDayWindow` JS helper" sketch.
> A design review (below) showed a cleaner approach: let Postgres do the IST
> bucketing, so the JS window math mostly disappears. **Built exactly as designed
> below (Option A); the "As-built" + "Verification" subsections at the end record
> what shipped.** The design rationale that follows is retained as the decision record.

### Design question: "why not just store IST in the database?"

Tempting, but a known anti-pattern. The timestamp columns are `TIMESTAMPTZ`, which
**does not store a timezone** — Postgres normalizes every value to an absolute
instant (UTC internally) and only *renders* it in a timezone. "Store IST" would
mean switching to `TIMESTAMP` (no zone) holding IST wall-clock numbers, which
breaks three ways:

1. **Ambiguity** — `2026-06-15 04:00` with no offset; nothing in the data says IST.
2. **`NOW()` / `expires_at < now` break** — Postgres clock functions are UTC-based;
   comparing them to naive IST values is silently off by 5.5h.
3. **Every writer must pre-convert** — api, redirect, worker each have to remember;
   one missed spot = corrupted data, no error.

**Decision: keep storing the absolute instant (UTC). Reason in IST at the edges.**

### The better realization — IST bucketing in SQL

The instinct ("stop computing windows in JS") is right; we just push it into the
query instead of into storage:

```sql
-- IST calendar date of each click — Postgres converts the stored instant to IST:
(clicked_at AT TIME ZONE 'Asia/Kolkata')::date
```

So the aggregation filters/groups by the IST day directly. Cleaner than UTC windows
*and* than storing local time: storage stays correct, queries think in IST.

### What "IST everywhere" actually touches

Principle: **store the instant (UTC), reason at the edges in one fixed zone
(`Asia/Kolkata`).** Only some layers are timezone-sensitive:

| Layer | Affected by IST? |
|---|---|
| Storage (timestamptz) | ❌ no change |
| **Expiry** (`expires_at < now`, lazy + eager) | ❌ **no change** — instant comparison, correct in any zone |
| Analytics day-bucket | ✅ becomes IST |
| IP-hash salt rotation | ✅ becomes IST (must match the bucket) |
| Cron firing | ✅ `Asia/Kolkata` |
| Display / API output | ✅ IST |

> Key narrowing: **expiry is NOT affected** — it compares instants, not calendar
> days. Only analytics bucketing, the salt, cron timing, and display change.

### Two ways to make IST the reference

| | **Option A — explicit in SQL (recommended)** | **Option B — connection timezone** |
|---|---|---|
| How | `AT TIME ZONE 'Asia/Kolkata'` in the aggregation query | set each service's DB connection to `Asia/Kolkata`; `::date`, `NOW()`, `CURRENT_DATE` all become IST |
| Scope | worker aggregation only | whole app (api + redirect + worker) |
| Risk | remember it per tz-sensitive query | implicit; raw psql differs; bigger re-test surface |

**Recommended: Option A** — self-documenting, blast radius limited to the worker.

### As-built (Option A) ✅

**Source:**
1. **`aggregate.repository.ts`** — `aggregateDay(date: string)` (was `(start, end, date)`).
   A `bounds` CTE resolves the IST day to instants in SQL:
   `(${date}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'` for start,
   `((${date}::date + 1)::timestamp) AT TIME ZONE 'Asia/Kolkata'` for end; the existing
   `base` CTE filters `clicked_at >= day_start AND < day_end` (half-open, unchanged shape).
   Storage stays `timestamptz` — no schema/migration change.
2. **`aggregation.job.ts`** — `utcDayWindow(now, offsetDays)` replaced by
   `istYesterday(now): string` (shift `+05:30`, step back one day, slice `YYYY-MM-DD`;
   pure, host-TZ-independent). Job now calls `repo.aggregateDay(date)`.
3. **`analytics.job.ts`** — `hashIp` salt now rotates on the **IST** date
   (`new Date(Date.now() + IST_OFFSET_MS)`), matching the bucket boundary. ⚠️ load-bearing.
4. **`worker.ts`** — both crons → `timezone: 'Asia/Kolkata'`; aggregation `'15 0 * * *'`
   (00:15 IST = 18:45 UTC prev day), expiry `'0 1 * * *'` (01:00 IST = 19:30 UTC prev day).
   Expiry logic unchanged (instant comparison, tz-agnostic).
5. **`run-aggregation.ts`** — comment-only. The `+1-day` backfill trick still holds:
   `referenceDate = (D+1)T00:00Z` → `istYesterday` → IST day `D`.

**Tests (Step 3):**
| Test | Change | Result |
|---|---|---|
| `aggregation-window.test.ts` (L1) | rewritten for `istYesterday`; incl. the `02:00 IST` (=`20:30 UTC` prev day) case + the `18:30 UTC` IST-midnight boundary | ✅ 7 |
| `aggregate.repository.integration.test.ts` (L3) | seeds straddle `18:30 UTC` IST-midnight; **+1 new test** asserting IST-day (not UTC-day) bucketing | ✅ 5 |
| `schedule.test.ts` (L5) | cron strings `'15 0 * * *'` / `'0 1 * * *'` @ `Asia/Kolkata`; asserts 00:15 / 01:00 IST + ordering | ✅ 4 |
| `aggregation-job.test.ts` (L2) | asserts the single IST date string passed to repo | ✅ 2 |
| `expiry-job.test.ts` + `url.repository` integration | no change (tz-agnostic) | ✅ 6 |

### Verification summary — Step 2 + 3

Run: `npm run test` (with `DATABASE_URL_TEST` set + docker-compose Postgres up).

| Check | Result |
|---|---|
| `npm run test:unit` (no DB) | ✅ 15/15 |
| `npm run test:integration` (real Postgres) | ✅ 9/9 |
| `npm run test` (all + coverage HTML) | ✅ **24/24** |
| `tsc --noEmit` on `worker` | ✅ clean |
| `aggregation.job.ts` / `expiry.job.ts` coverage | ✅ 100% / 100% |
| `aggregate.repository.ts` / `url.repository.ts` coverage | ✅ 100% / 100% |
| IST-vs-UTC bucketing (a `01:30 IST` click excluded from the prior IST day) | ✅ asserted (L3) |
| Schedule maps to 00:15 / 01:00 IST (timezone correct) | ✅ asserted (L5) |
| `code-reviewer` against locked docs | ✅ no correctness violations |

> **Salt-rotation note:** the `hashIp` IST change lives in `analytics.job.ts` (the
> Day-7 click pipeline), which remains out of scope for Day-15 automated coverage
> (0%, as flagged above). The change is a one-line date-source swap, verified by
> inspection; covering the click pipeline is left to a future day.

### Open confirmations — RESOLVED
1. Option **A** (SQL, worker-only) vs **B** (connection tz). → **A** (built). Self-documenting,
   blast radius limited to the worker; raw `psql` behaviour unchanged.
2. Aggregation fire time. → **00:15 IST** (built). 15-min lag after IST midnight lets
   late-arriving click jobs land before roll-up; idempotent re-run is the backstop.
