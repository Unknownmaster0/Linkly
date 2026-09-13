# Test Writing Contract — Backend Monorepo

**Status:** Locked (Adopted after Day 15's worker suite)  
**Last Updated:** 2026-08-08 (initial adoption; codifies the worker suite proven on Day 15 and
extends the same conventions to `api`, `redirect`, and `shared`)  
**Audience:** Any AI agent or developer writing or modifying test files under `server/`

---

## What this contract is

A single, authoritative document governing **every test suite** in the backend monorepo:
`server/api`, `server/redirect`, `server/shared`, `server/worker`. It fixes the framework,
directory layout, layer taxonomy, integration-test environment, timezone determinism rules,
mocking conventions, HTTP route testing approach, the locked decisions tests must assert,
naming/comment style, and the "done" checklist.

**Rule: any agent writing a test file must read this document first**, and key its
assertions to `docs/notes/API_CONTRACT.md`, `docs/notes/ERROR_CONTRACT.md`, and
`docs/notes/DECISIONS.md` — never invent shapes or status codes from memory.

This is a *contract* for writing tests, not a test library. The current state of test
coverage is uneven (only `worker/` has an automated suite today); the contract describes the
target all four packages must converge on whenever their tests are (or get) written.

---

## 1. Framework & Runtime Environment

| Concern | Locked value | Why |
|---|---|---|
| Runner | **Vitest** (all packages) | Project standard since Day 15; ESM-native, matches `"type": "module"` + `tsx`. Never Jest. |
| Globals | `globals: true` | `describe`, `it`, `expect`, `vi`, `beforeAll`, `afterAll`, `beforeEach` available without imports. |
| Environment | `node` | No DOM. No `jsdom`/`happy-dom`. |
| TypeScript | Tests run through Vitest/`tsx` native TS | No separate `tsc` step to run tests; `type-check` is a separate gate (see §9). |
| Node | ≥ 20 | Matches the repo's runtime. |
| Coverage provider | `@vitest/coverage-v8` | v8 native; worker already uses it (§2.1). |

Package `package.json` must expose the standard scripts (§2.2). The root
`server/package.json` should expose a single `npm run test` that runs the four workspaces:
`npm run test -w api -w redirect -w shared -w worker`.

## 2. Per-Package Wiring

### 2.1 Required scripts (each package)

| Script | Command | Notes |
|---|---|---|
| `test` | `vitest run --coverage` | the one command: all tests + coverage report |
| `test:unit` | `vitest run tests/unit` | pure logic + fake-repo layers; no DB/Valkey |
| `test:integration` | `vitest run tests/integration` | real Postgres (and Valkey for api/redirect); only added where §4 requires it |
| `test:watch` | `vitest` | dev loop |

`shared` has no integration layer — omit `test:integration` there (see §4).
`worker` already complies exactly; use it as the reference.

### 2.2 Example package.json fragment

```jsonc
// api, redirect, worker
"scripts": {
  "test": "vitest run --coverage",
  "test:unit": "vitest run tests/unit",
  "test:integration": "vitest run tests/integration",
  "test:watch": "vitest"
},
"devDependencies": {
  "@vitest/coverage-v8": "^2.1.8",
  "vitest": "^2.1.8",
  // tsx, typescript already present in every workspace
}
```

```jsonc
// shared (no integration layer)
"scripts": {
  "test": "vitest run --coverage",
  "test:unit": "vitest run tests/unit",
  "test:watch": "vitest"
}
```

---

## 3. Directory, File, and Naming Layout

```
server/<package>/
├── tests/
│   ├── unit/
│   │   └── <feature>.test.ts            # Layers 1, 2 (+ 5 for worker)
│   ├── integration/
│   │   ├── helpers/
│   │   │   └── test-db.ts               # shared harness (see §6)
│   │   ├── <repository>.integration.test.ts
│   │   └── <group>.routes.integration.test.ts   # api/redirect only
│   └── coverage/                        # gitignored; text + HTML reports
├── vitest.config.ts
└── package.json
```

**File-name rules:**
- Unit tests: `tests/unit/<feature>.test.ts` — e.g. `base62.test.ts`, `auth.service.test.ts`, `rate-limit-middleware.test.ts`.
- Repository integration: `tests/integration/<repo>.integration.test.ts` — e.g. `url.repository.integration.test.ts`.
- Route integration (api/redirect): `tests/integration/<group>.routes.integration.test.ts` — e.g. `auth.routes.integration.test.ts`, `redirect.routes.integration.test.ts`.
- Harness helpers live under `tests/integration/helpers/` (or a shared location the package imports); never duplicated inline per file.

**Do not** place tests in `src/`, and do not name test files `*.spec.ts` — `.test.ts` is the
single convention.

---

## 4. Evidence: the Five Test Layers (core taxonomy)

Day 15 established that "does this feature work" is several distinct claims, each proven a
different way. Every new test must state which layer it is (file header comment, §11).

| Layer | What it proves | DB | Example targets per package |
|---|---|---|---|
| **1 — Pure logic** | Date math, base62, validation, pure functions — no I/O | No | worker: `istYesterday`; api: `base62`, `schemas/*` zod refinements; shared: `rateLimitCheck` math, `logger` level/format helpers |
| **2 — Orchestration with fake dependency** | Service/job forwards the correct args, swallows/throws repo errors per contract, calls queue/cache correctly | No | worker: `aggregation.job`, `expiry.job` (fake repo); api: `services/*` (fake repository); redirect: cache-aside handler logic (fake cache+repo) |
| **3 — Repository / real SQL** | The real query changes the real DB correctly (JSONB, `ON CONFLICT`, soft-delete `UPDATE`, `AT TIME ZONE`, pagination window) | **Yes — real Postgres** | worker: `aggregate.repository`, `url.repository`; api: `url.repository`, `auth.repository`, `analytics.repository`; redirect: `url.repository` |
| **4 — HTTP route** | Full Fastify app via `inject()`: status codes, headers, cookies, error envelope, 405/410/429/504, 404-not-403, 302 | **Yes — real DB + real Valkey** | api: all routes; redirect: `GET /:shortCode` |
| **5 — Schedule** | `cron-parser` next-fire assertions; cron string + timezone correct | No | worker only: `schedule.test.ts` |

### Rules of the taxonomy

1. **Every package must have Layers 1–2.** Pure logic and orchestration are fast and need no
   infra; a package with no Layer-1/2 coverage is unfinished.
2. **Every package that touches the DB (api, redirect, worker) must have Layer 3.**
3. **Every package with HTTP routes (api, redirect) must have Layer 4.**
4. **Only worker has Layer 5** (no other package owns cron strings).
5. **Layer 3 exists because a mock cannot prove SQL.** Never substitute a mocked Prisma layer
   for the real engine when the query is where the bug lives (JSONB `object_agg`, `ON
   CONFLICT`, `AT TIME ZONE`, soft-delete `UPDATE`).

---

## 5. Timezone Determinism (IST / UTC rules)

**Why it matters:** a test that passes under a UTC host but fails under an IST host (or vice
versa) makes CI green on one box and red on another. `DECISIONS.md #12` fixes IST
bucketing; the tests must be host-TZ-independent forever.

1. **Pure helpers must only use UTC-reliable APIs:** `getTime()`, `toISOString()`,
   `Date.UTC()`. **Never** `getFullYear()`, `getMonth()`, `getDate()`, `getHours()`,
   `getTimezoneOffset()` in code under test or in seeds; those read the host TZ.
2. **Determinism guard (mandatory for any IST-sensitive helper):** each such test file
   must include a sub-suite that flips `process.env.TZ` and asserts identical output, e.g.
   submit the same instant with `TZ=America/New_York` then `TZ=Asia/Kolkata` and expect
   `toBeEqual` (see worker `tests/unit/aggregation-window.test.ts` for the pattern: save
   original `TZ` in a `afterEach`, restore it).
3. **Seeds use explicit instants, never `new Date()`/`Date.now()`:** write ISO-8601 UTC
   strings (`'2026-06-16T01:00:00.000Z'`); it makes ICRO boundary cases (IST midnight =
   `18:30 UTC` of the preceding day) readable and deterministic.
4. **Boundary tests must pin the half-open window:** `>= start AND < end`. Assert
   `start` is included and `end` excluded explicitly.
5. Any test that creates dates *from the system clock* or with local getters is a defect.

---

## 6. Integration Test Environment Contract (Layers 3–5)

Copied from the proven `worker/tests/integration/helpers/test-db.ts` and memoized for
api/redirect. Non-negotiable:

| Rule | Implementation |
|---|---|
| **Separate test DB only** | Integration tests connect to the URL in `DATABASE_URL_TEST` — **never** read `DATABASE_URL` (the dev/prod value). Name must contain `test` (case-insensitive); e.g. `postgresql://dev:dev@localhost:5432/urlshortener_test`. |
| **Fail loud, never skip** | This harness throws an explicit, actionable error at `beforeAll` if Postgres is unreachable or `DATABASE_URL_TEST` is unset/empty. No `test.skip`, no `console.warn`, no silent pass. A green suite must prove it ran. |
| **Safety rail** | Refuse to run against a DB whose name doesn't match `/test/i` — the harness does `DROP SCHEMA public` on reset, so a wrong target would destroy data. |
| **Schema from api migrations** | `resetDatabase()` (`beforeAll` per file) drops `public` and replays `server/api/prisma/migrations/*/migration.sql` in sorted (timestamp = chronological) order. Never run `prisma migrate` from test code; the api owns the schema. |
| **Per-test isolation** | `beforeEach` → `truncateAll(prisma)`: `TRUNCATE click_events, daily_analytics_aggregates, urls RESTART IDENTITY CASCADE`. Explicit table list; `CASCADE` covers FK dependencies. |
| **Real engine** | Tests build `PrismaClient` with the same `PrismaPg` adapter used in production (`db/index.ts`). The SQL must execute against the real Postgres, not a mock. |
| **Valkey for api/redirect Layer 4** | Route tests spin up the real Valkey (dev `docker-compose` instance), a separate logical DB (`VALKEY_URL_TEST`, default `redis://localhost:6379/1` — distinct from the dev/other keys), and `FLUSHDB` in `beforeEach`. Cache, negative-cache (Decision 9), jti denylist (Decision 18), and rate-limit tests need the real store. |
| **Fail fast on missing Valkey** | Same policy as Postgres: unset/invalid `VALKEY_URL_TEST` throws at startup, never skips. |

---

## 7. Mocking Rules

| What to mock | How | Note |
|---|---|---|
| Repository/dependency interfaces in Layers 1–2 | `vi.fn<RepoType['method']>()`, type-checked against the real interface (import the type from `src/`), with `mockResolvedValue`/`mockRejectedValue` | Keeps call-site typing; lets you assert `toHaveBeenCalledWith(exactArgs)`. See `worker/tests/unit/expiry-job.test.ts`. |
| External libs / plugins near the app boundary | `vi.mock('../src/plugins/queue', ...)` etc. | Keep mocks file-local, not global. |
| Logger | `vi.spyOn(logger, '...')` or a no-op logger injected | Route/service inputs. |
| **Prisma itself (Layer 3)** | **Never mock.** | The point of Layer 3 is the real SQL; mocking Prisma reintroduces the bug it exists to catch. |
| `Date.now` / timers (Layers 1–2 only) | `vi.useFakeTimers()` + `vi.setSystemTime(new Date(...))` | Deterministic instants for logic under test; **never** in integration layers — they assert against an internal `now`/instant passes through, the caller decides. |
| `console.*`, logger noise | `vi.spyOn` and `mockImplementation(() => {})` in a repo-specific setup or `beforeEach` | Keep output readable, especially under `--coverage` HTML. |

---

## 8. HTTP Route Testing (Fastify `app.inject()`, Layers 4)

- **Always use `inject()`**, never `app.listen()` + fetch. `inject()` runs the full plugin
  tree, hooks, error handler, and `notFoundHandler` in-process with zero ports.
- Build the app from `src/app.ts` (exports the Fastify instance) — not `src/server.ts`
  (which binds/listens).
- Assert **response status + body shape + the contract's headers** per `API_CONTRACT.md` /
  `ERROR_CONTRACT.md`:

| Behavior | Assert |
|---|---|
| 201/200 envelopes | `{ success, message, data }` shape, per endpoint |
| Error cases | `{ error, details?, retryAfter? }` envelope — `ERROR_CONTRACT.md` |
| 401 (auth) | `WWW-Authenticate: Bearer` present, envelope shape |
| 429 (rate limit) | `Retry-After` header + `X-RateLimit-Limit`/`Remaining`/`Reset`, envelope `{ error, retryAfter }` |
| 405 (wrong method) | `Allow` header set (Fastify `setNotFoundHandler({ methodNotAllowed: true })`, Decision 23), envelope |
| 404 (ownership) | `404` never `403` (Decision 7) — ownership mismatch payload indistinguishable from not-found |
| 410 (like deleted/expired URL) | envelope + negative-cache behavior (Decision 9) |
| 302 (redirect) | `Location` header = original URL, `302` not `301` (Decision 1); `Cache-Control: no-cache` on the redirect (the redirect path must not be browser-cached) |
| 504 (timeout path) | the app's own 504 envelope + `Retry-After` (Decision 24) |

- **Auth fixtures:** register/login are real Endpoints — test them via `inject()` (register →
  login → use `Authorization: Bearer <access>`), and for revoked/expired-token cases use
  `jti` denylist writes (Valkey, Decision 18) with the signature secrets from config, or
  abstract a `createTestAuth()` helper in the package's test helpers.

- **Rate limiting**: hammer `limit + 1` genuine requests and assert 429 + headers (Decision
  16 per-IP and per-account buckets); and assert the fail-open path when Valkey is
  unavailable (the `rateLimitCheck` cache-miss path).

- **Redirect specifics**: assert cache-aside (miss → DB + populates `url:<code>`,
  delete/expire → negative `DELETED:<code>` with 30s TTL → 410 on repeat), and that
  analytics is fire-and-forget (queue `.add` called but not awaited in the handler; Decision
  4 + 21).

---

## 9. Locked Assertions Each Suite Must Contain

For every code path under test, look up the relevant `DECISIONS.md` row and add at least one
test asserting the lock. Minimum mapping (expand for the code under test):

| Decision | Rule the test must assert |
|---|---|
| #1 | redirect returns `302`, `Location` present |
| #7 | ownership mismatch → `404` (identical body to not-found); never `403` |
| #8 | delete/expiry = soft-delete (`is_deleted=true`), `click_events` survive |
| #9 | delete of a cached URL → negative-cache marker `DELETED:<code>` with 30s TTL → next redirect no DB hit (410) |
| #12 | analytics bucketing uses IST calendar day (`AT TIME ZONE Asia/Kolkata`), boundaries half-open |
| #18 | revoked access token rejected (denylist) even though signature valid; fails open when Valkey down |
| #21 | duplicate `clickId` insert → exactly one `click_events` row (`ON CONFLICT DO NOTHING`) |
| #22 | duplicate URL per user (non-deleted pair) → `409` |
| #23 | known path, wrong method → `405` + `Allow` set |
| #25 | `GET /api/urls` cursor pagination shape (`nextCursor`, `hasMore`, `total`/`items`) stable across pages |
| #16 | auth endpoints per-IP + per-account buckets across the IP rotates |

---

## 10. Coverage Policy

- `vitest.config.ts` per package: `provider: 'v8'`, reporters `['text', 'html']`,
  `reportsDirectory: 'tests/coverage'`.
- `include` = the code the suite actually targets (services, repositories, utils, route
  handlers — see the worker config for the pattern: `src/services/**`, `src/repositories/**`,
  `src/utils/**`, …).
- **`exclude`**: generated Prisma client, `server.ts` / `worker.ts` / cron CLIs (`run-*ts`),
  configs, openapi plumbing, mocks.
- Integration tests mutate the DB — files must **not run in parallel** if they share the
  integration DB state. `fileParallelism: false` is safe for the worker; api/redirect would
  want the same when integration tests share the `test` schema.
- **Coverage is report-only**: no failing threshold. A low number never fails the run — it's
  a signal for the human to open the HTML report.

---

## 11. Naming & Comments

- **File header block, mandatory, per file** — states the layer, what it proves, what it
  needs. Copy the style from the worker suites:

```ts
/**
 * Layer 2 — job orchestration with a fake repo (no DB).
 *
 * Proves the job forwards its reference instant to softDeleteExpired and,
 * like the aggregation job, swallows a repository error so a transient DB
 * failure during the nightly sweep can never crash the long-running worker.
 */
```

- `describe` names → `<unit under test> (<variant>)` — e.g. `describe('istYesterday
  (UTC baseline)')`, `describe('POST /api/auth/register (per-IP rate limit)')`;
- `it/expect` names → behavioral sentence, e.g. `it('passes the reference date through to
  repo.softDeleteExpired')`, `it('returns 404 for an ownership mismatch, never 403')`;
- always `expect(await promise)` / `await expect(promise).resolves|rejects` — no floating
  promises;
- manage time/restore in `afterEach` when switching `process.env.TZ` (see §5.2).

---

## 12. "Checklist before done" (any agent finished writing tests)

Before declaring a test task complete, verify:

1. `npm run type-check -w <pkg>` passes in the package being tested.
2. `npm run test -w <pkg>` (or the root `npm run test`) — all are green.
3. `npm run test:unit` alone (no DB/Valkey up) is green for every package (the fast loop).
4. For packages with Layers 3–4: `npm run test:integration` green with
   `DATABASE_URL_TEST` +, for api/redirect, `VALKEY_URL_TEST`, and docker-compose up.
5. The locks are covered: each `DECISIONS.md` row applicable to the code has at least one
   asserting test (see §9).
6. No `test.skip`/`it.skip`, no conditional `skip`, no swallowed DB lookups — integration
   must **fail open (loudly)** on missing infra.
7. The coverage HTML lands in `<pkg>/tests/coverage/index.html` (gitignored; inspect it
   locally).
8. The file carries the layer header comment, uses `*.test.ts` naming, and places itself in
   `tests/unit` / `tests/integration` per its layer.

---

## 13. Human Lifecycle & Extensions

- The worker suite (Day 15) is the reference implementation of this contract; any drift
  between these sections and the worker tests should be resolved in favor of the rules above
  (documented in `server/docs/dev-log/day-15-async-job-testing.md`).
- This contract does not cover the `client/` app (Vitest/whatever the frontend standard is
  there is out of scope until set).
- New decisions that touch testing (e.g. a future parallelization strategy, DB-per-test,
  or CI service containers) should be recorded here and cross-linked from
  `docs/notes/DECISIONS.md`.