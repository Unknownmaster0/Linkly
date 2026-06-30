# Day 2 — Database Schema Initialization

> **Goal (per [url-shortener-expert-plan.md](../../../docs/notes/url-shortener-expert-plan.md)):** Translate the design in [db-design.md](./db-design.md) into a working Prisma schema, apply an initial migration to Postgres, and verify the database is ready for the rest of Week 1.
>
> **Scope decisions taken before starting:**
> - All 5 models from `db-design.md` (not the Day 2 minimum of `User` + `Url`).
> - Click-events monthly partitioning **deferred** to a later migration (production-load concern, not MVP).
> - Use a **two-migration strategy**: Prisma-managed `init`, then a hand-written `schema_augmentation` for things Prisma cannot model.

---

## Table of Contents

1. [Phase 1 — Schema Authoring](#phase-1--schema-authoring)
2. [Phase 2 — Initial Migration](#phase-2--initial-migration)
3. [Phase 3 — Raw-SQL Augmentation Migration](#phase-3--raw-sql-augmentation-migration)
4. [Phase 4 — Verification & Smoke Test](#phase-4--verification--smoke-test)
5. [Folder Restructure (Mid-Day Correction)](#folder-restructure-mid-day-correction)
6. [Final State](#final-state)
7. [Decisions Log](#decisions-log)
8. [Known Non-Issues](#known-non-issues)

---

## Phase 1 — Schema Authoring

**File:** [api/prisma/schema.prisma](../../api/prisma/schema.prisma)

### Steps

1. Defined two enums:
   - `Plan { free, pro, enterprise }` — drives rate-limit tier and feature gating.
   - `DeviceType { mobile, desktop, tablet, bot, unknown }` — User-Agent classification on click events.
2. Authored five models — `User`, `RefreshToken`, `Url`, `ClickEvent`, `DailyAnalyticsAggregate` — matching the column types, nullability, and constraints in `db-design.md`.
3. Mapped every field/model to snake_case in the database via `@map` / `@@map`.
4. Picked precise Postgres column types via `@db.*`:
   - `@db.Uuid` for UUID PKs (16-byte native, vs 36-byte VarChar).
   - `@db.VarChar(N)` with the lengths from the design doc (255, 100, 50, 64, 500, etc.).
   - `@db.Text` for `urls.original_url` (URLs can exceed 255 chars).
   - `@db.Char(2)` for `country_code` (ISO 3166-1 alpha-2).
   - `@db.Timestamptz(6)` everywhere a timestamp appears.
   - `@db.Date` for the analytics aggregate's date column.
   - `@db.JsonB` for analytics JSON columns (binary, indexable).
5. Set FK behavior to `onDelete: Cascade, onUpdate: Cascade` on every relation, matching the design doc.
6. Added Prisma-modellable indexes (composite, sorted) where the augmentation migration would not later replace them. Added comments on `RefreshToken` and `Url` indicating which `@@index` lines were intentionally **removed** because Phase 3 raw SQL replaces them with partial-index variants — preventing a future contributor from re-adding them and causing migration drift.

### Why these choices

| Choice | Reason |
|---|---|
| **All 5 models in Day 2** (not just User/Url) | Avoids two near-future migrations that would touch the same tables. The full design is already locked in `db-design.md`. |
| **Snake_case in DB, camelCase in TS** | Each ecosystem keeps its idiomatic convention. Raw SQL queries in psql / future migrations / BI tools stay readable; Prisma client API stays idiomatic. |
| **`@db.Timestamptz(6)` instead of default `DateTime`** | Prisma's default `DateTime` maps to `timestamp(3)` *without* timezone. That's a footgun in any multi-region/UTC system. `timestamptz` always stores absolute UTC instants. |
| **`@db.Uuid` instead of `String`** | Native 16-byte type vs 36-byte text; smaller indexes, faster joins. |
| **BigInt PK on `Url` and `ClickEvent`** | Source for Base62 short codes; future-proofed past `Number.MAX_SAFE_INTEGER`. Aligns with [DECISIONS.md](../../../docs/notes/DECISIONS.md) #2. |
| **`@db.JsonB` (not `Json`)** | Binary storage, indexable with GIN, faster reads. Required for fast analytics queries (`top_countries->>'IN'`). |
| **`onDelete: Cascade` on every FK** | Matches design doc. Combined with the soft-delete pattern (`is_deleted = true`), production code never hard-deletes a user/URL anyway, so cascade is a safety net for development/test. |
| **Defer click_events partitioning** | Prisma can't model `PARTITION BY RANGE` natively. Adding partitioning requires raw SQL plus partition-management tooling (cron-rotated monthly partitions). Out of scope for Day 2 MVP; converted via partition-swap migration before production load. |

**Validation:** `npx prisma validate --schema=src/prisma/schema.prisma` → `valid 🚀`.

---

## Phase 2 — Initial Migration

### Steps

1. Confirmed [docker-compose.yml](../../../docker-compose.yml) services were not running; brought them up:
   ```bash
   docker compose up -d
   ```
   Result: `url-shortner-postgres-1` (postgres:15) + `url-shortner-valkey-1` (valkey:7) on host ports 5432 and 6379.
2. Verified `.env` already had `DATABASE_URL="postgresql://admin:secret@localhost:5432/urlshortener"` matching docker-compose credentials.
3. Initial attempt: `npx prisma migrate dev --name init` from `api/` failed — Prisma couldn't find `prisma.config.ts` (it lived under `src/`).
4. Ran from `api/src/`. Next failure: `Connection url is empty` because `dotenv/config` loads `.env` from `process.cwd()` and `.env` was at `api/.env`, not `api/src/.env`.
5. (See [Folder Restructure](#folder-restructure-mid-day-correction) for the fix.)
6. After restructure, ran from `api/`:
   ```bash
   npx prisma migrate dev --name init
   ```
7. Migration `20260422125523_init` was generated and applied. Prisma Client regenerated to `api/generated/prisma`.

### Why these choices

| Choice | Reason |
|---|---|
| **`npx prisma migrate dev`** (vs `db push`) | `migrate dev` produces a versioned, reviewable SQL artifact in `prisma/migrations/`. `db push` skips the migration history — fine for prototyping, unacceptable for a system that will need rollbacks and team-shared schema evolution. |
| **`--name init`** | Conventional first migration name; immediately self-documenting in CI and code review. |
| **Run docker-compose `up -d`** (not `up`) | Detached mode keeps the terminal free. Logs are still accessible via `docker logs <container>` if needed. |

**Verification:**
```bash
docker exec url-shortner-postgres-1 psql -U admin -d urlshortener -c "\dt" -c "\dT"
```
Result: `users`, `refresh_tokens`, `urls`, `click_events`, `daily_analytics_aggregates` tables + `Plan`, `DeviceType` enums all present.

---

## Phase 3 — Raw-SQL Augmentation Migration

**File:** [api/prisma/migrations/20260422130939_schema_augmentation/migration.sql](../../api/prisma/migrations/20260422130939_schema_augmentation/migration.sql)

### Steps

1. Removed four `@@index` lines from `schema.prisma` (the ones we wanted to convert to partial indexes), leaving an explanatory comment in their place.
2. Ran:
   ```bash
   npx prisma migrate dev --create-only --name schema_augmentation
   ```
   `--create-only` generates the migration file **without applying** it. Prisma emitted the four `DROP INDEX` statements automatically.
3. Hand-edited the generated `migration.sql` to append the augmentation SQL.
4. Applied with `npx prisma migrate dev`.

### What was added in the augmentation

| # | Feature | Purpose | Why Prisma can't model it |
|---|---|---|---|
| 1 | `update_timestamp()` PL/pgSQL function + `BEFORE UPDATE` triggers on `users` and `urls` | DB-level guarantee that `updated_at` reflects the truth — even when written by raw SQL, analytics jobs, or admin tools that bypass the Prisma client. | Prisma's `@updatedAt` only fires on writes through the Prisma client. |
| 2 | `CREATE UNIQUE INDEX idx_users_email_lower ON users (LOWER(email))` | Case-insensitive uniqueness: `Foo@x.com` and `foo@x.com` cannot both register. | Prisma `@unique` is case-sensitive; functional indexes (on expressions) aren't expressible in the schema. |
| 3 | `idx_urls_user_created` partial index `WHERE is_deleted = false` | Replaces `urls_user_id_created_at_idx`. Excludes soft-deleted rows, keeping the dashboard index small and hot. | Prisma `@@index` doesn't expose `where:` (Postgres-specific feature). |
| 4 | `idx_urls_expires_at` partial index `WHERE is_deleted = false AND expires_at IS NOT NULL` | Cleanup-job index. Strips out NULL expiries (never expires) and soft-deleted rows. | Same as above. |
| 5 | `idx_refresh_tokens_user_id` partial index `WHERE revoked_at IS NULL` | "Active sessions for user" lookup. Drops the second column (`revoked_at`) entirely — the predicate enforces the filter. | Same as above. |
| 6 | `idx_refresh_tokens_expires_at` partial index `WHERE revoked_at IS NULL` | Cleanup job: find expired, still-active tokens. | Same as above. |
| 7 | `idx_urls_original_url_fts` GIN index on `to_tsvector('english', original_url)` | Enables full-text search across destination URLs. | GIN + `to_tsvector` not modellable via `@@index`. |
| 8 | `ALTER SEQUENCE urls_id_seq CACHE 1000` | Pre-allocate 1000 IDs in memory per backend → fewer round-trips to the sequence at high insert rates. | Prisma can't tune sequence cache values. |

### Why a separate migration (not part of `init`)

| Choice | Reason |
|---|---|
| **Two migrations, not one combined hand-edited init** | Keeps the Prisma-generated `init` migration as something `prisma migrate dev` can regenerate cleanly if the schema is ever rebuilt from scratch. The augmentation file is the only one that requires hand-editing — easy to find, easy to review, easy to keep in sync with `schema.prisma`. |
| **Drop and recreate the four indexes (not ALTER)** | Postgres has no `ALTER INDEX … ADD WHERE`. The only way to convert a full index into a partial one is drop + recreate. |
| **`clock_timestamp()` instead of `NOW()` in the trigger** *(see Phase 4)* | `NOW()` returns transaction-start time. An INSERT+UPDATE in one transaction would leave `updated_at == created_at`. `clock_timestamp()` returns wall-clock time and advances within a transaction — what an audit timestamp actually needs. |

**Verification:**
```sql
SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'idx_%';
SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE NOT tgisinternal;
SELECT relname, seqcache FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid WHERE relname='urls_id_seq';
```
All 6 partial/expression/GIN indexes present with correct predicates; both triggers registered; sequence cache = 1000.

---

## Phase 4 — Verification & Smoke Test

### Steps

1. `npx prisma migrate status` → `Database schema is up to date!` (2 migrations).
2. Ran a transactional smoke-test SQL script (BEGIN…ROLLBACK so the DB stays clean):
   - **Check 1:** Insert `Smoke@Test.com`, then attempt to insert `smoke@test.com` → unique-violation as expected.
   - **Check 2:** Insert a URL, then UPDATE its `original_url`; confirm `updated_at > created_at`.
   - **Check 3:** Insert a `ClickEvent` for the URL; confirm row count = 1.
   - **Check 4:** `DELETE` the user; confirm `urls` for that user_id = 0 (cascade fired).
   - **Check 5:** Confirm `click_events` for that url_id = 0 (cascade chained).

### What we caught

- **First run:** Check 2 reported `trigger fires = false`. Diagnosis: the trigger called `NOW()` (transaction-start time), so within a single transaction `updated_at == created_at`. **Not a wrong test — a real bug in the trigger.** Patched to `clock_timestamp()` in both the live DB (via `CREATE OR REPLACE FUNCTION`) and the migration file. Re-ran: all 5 checks passed.
- This is exactly the value of running an end-to-end smoke test before declaring a phase complete.

### Why a transactional smoke test (not a long-lived seed)

- `BEGIN … ROLLBACK` leaves zero data behind — no cleanup required, no risk of contaminating dev DB state.
- Exercises every constraint and cascade in one round-trip.
- Faster feedback than spinning up the Prisma client + a full app.

---

## Folder Restructure (Mid-Day Correction)

### Problem

Initial layout had `prisma/` and `prisma.config.ts` under `api/src/` — non-standard for Prisma projects. This caused two failures during Phase 2:

1. `prisma migrate dev` couldn't find `prisma.config.ts` (Prisma auto-discovers only at the cwd).
2. After moving to `src/` to run, dotenv loaded `.env` from cwd (`src/`), missing the `.env` at the package root.

### Fix

Moved to the conventional layout:

```
api/
├── .env                    ← root (cwd for all npm/npx commands)
├── package.json
├── prisma.config.ts        ← auto-discovered by Prisma CLI
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── generated/prisma/       ← Prisma client output (gitignored)
└── src/                    ← only application TS source
    ├── app.ts
    └── server.ts
```

### Why this layout

| Reason | Detail |
|---|---|
| **CLI ergonomics** | Every `npx prisma …` runs from the package root, same place as `npm run dev`, `npm test`. No `cd` gymnastics. |
| **`.env` resolution** | `dotenv/config` loads from `process.cwd()`. With both `.env` and Prisma config at the root, the simple `import "dotenv/config"` works without path tricks. |
| **Source vs data layer separation** | `src/` is for code that `tsc` compiles. Schema and migrations are not TS source — they shouldn't share that namespace. |
| **Tooling expectations** | Every Prisma tutorial, `npx prisma init`, and the official starter assume this layout. Lower onboarding friction for new contributors. |
| **Generated artifacts placement** | `output = "../generated/prisma"` now resolves to `api/generated/`, sibling of `dist/`, both gitignored. |

The init migration history moved with the folder; `prisma migrate status` confirmed no drift after the move.

---

## Final State

### Files

| Path | Purpose |
|---|---|
| [api/prisma/schema.prisma](../../api/prisma/schema.prisma) | 5 models, 2 enums, Prisma-managed indexes |
| [api/prisma/migrations/20260422125523_init/migration.sql](../../api/prisma/migrations/20260422125523_init/migration.sql) | Tables, FKs, base indexes |
| [api/prisma/migrations/20260422130939_schema_augmentation/migration.sql](../../api/prisma/migrations/20260422130939_schema_augmentation/migration.sql) | Triggers, partial indexes, FTS, sequence cache |
| [api/prisma.config.ts](../../api/prisma.config.ts) | Prisma CLI configuration |
| [api/.env](../../api/.env) | `DATABASE_URL` (gitignored) |

### Database objects

- **Tables:** `users`, `refresh_tokens`, `urls`, `click_events`, `daily_analytics_aggregates`.
- **Enums:** `Plan`, `DeviceType`.
- **Indexes:** 20 total (Prisma-managed PKs/uniques + 6 augmentation indexes).
- **Triggers:** `trg_users_updated_at`, `trg_urls_updated_at` calling `update_timestamp()`.
- **Sequences:** `urls_id_seq` (CACHE 1000), `click_events_id_seq`.

### Containers

- `url-shortner-postgres-1` — postgres:15, port 5432.
- `url-shortner-valkey-1` — valkey:7, port 6379.

---

## Decisions Log

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Models in scope | All 5 from `db-design.md` | Single migration cycle vs incremental rework. |
| 2 | Click-events partitioning | Defer | Adds raw-SQL DDL + cron-rotated partition management; not MVP. Convertible later via partition-swap. |
| 3 | Migration strategy | Two migrations: Prisma `init` + raw-SQL `schema_augmentation` | Keeps the auto-generated init regenerable; isolates hand-edited SQL to one reviewable file. |
| 4 | Generated client output | `api/generated/prisma` (sibling of `dist/`) | Separates generated artifacts from `src/`; both already gitignored. |
| 5 | Folder layout | Conventional Prisma (root-level `prisma/` + `prisma.config.ts`) | Tooling default; removes dotenv/cwd workarounds. |
| 6 | `update_timestamp()` time source | `clock_timestamp()` | `NOW()` returns transaction-start time → trigger appears no-op on single-txn writes. |
| 7 | Email uniqueness | Functional unique index on `LOWER(email)` | Application-layer normalization can drift; DB-level enforcement is the only true guarantee. |
| 8 | Index style for queries that always filter `is_deleted = false` / `revoked_at IS NULL` | Partial indexes | Smaller indexes, faster lookups, naturally exclude dead rows. |
| 9 | Smoke-test approach | Transactional script with ROLLBACK | Zero data residue; exercises all constraints + cascades in one round-trip. |

---

## Known Non-Issues

### "SQL syntax errors" in `init/migration.sql` from VS Code

VS Code's SQL Server (T-SQL) language server flags valid PostgreSQL syntax it doesn't recognize:

- `CREATE TYPE … AS ENUM (...)` — Postgres native enum syntax; no T-SQL equivalent.
- `TEXT[]`, `ARRAY[]::TEXT[]` — Postgres array types.
- `TIMESTAMPTZ(6)` — Postgres-only.
- Double-quoted identifiers — ANSI/Postgres style; T-SQL uses `[brackets]`.

**Proof these aren't real errors:** the migration applied successfully twice and the smoke test passed end-to-end.

**Optional fix** — set the file association in `.vscode/settings.json`:
```json
{
  "files.associations": {
    "**/prisma/migrations/**/*.sql": "postgres"
  }
}
```
(Requires a Postgres-aware extension active.)

---

*Day 2 complete. Next: Day 3 — Base62 encode/decode in [api/src/utils/base62.ts](../../api/src/utils/base62.ts).*
