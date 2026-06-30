### Why all the `@` attributes?

In Prisma schema, `@` (field-level) and `@@` (model-level) are **attributes** — they refine how a field/model is generated and mapped to the database. Without them, Prisma picks defaults that are often too generic for production. They fall into a few buckets:

| Attribute | Purpose |
|---|---|
| `@id`, `@@id` | Mark primary key (single or composite) |
| `@default(...)` | Default value (`uuid()`, `now()`, `autoincrement()`, literal) |
| `@unique`, `@@unique` | Uniqueness constraint |
| `@relation(...)` | Define FK columns + cascade behavior |
| `@updatedAt` | Auto-update timestamp on every write |
| `@db.<Type>` | Pick the **exact** Postgres column type |
| `@map`, `@@map` | Rename column/table in the DB (without renaming the TS field) |
| `@@index([...])` | Composite/sorted indexes |

### Why `@db.Timestamptz(6)` instead of just `DateTime`?

Prisma's `DateTime` is a **logical type**. By default it maps to Postgres `timestamp(3)` — *no timezone*, millisecond precision. That's a footgun:

- `timestamp` (without `tz`) stores a wall-clock value with no timezone info. Two servers in different timezones inserting "now" produce different absolute moments. Bug-prone.
- `timestamptz` stores an absolute UTC instant; Postgres converts on read/write. This is what every production system should use.

`@db.Timestamptz(6)` = `timestamp(6) with time zone` — microsecond precision, timezone-aware. Aligns with db-design.md (`TIMESTAMPTZ` everywhere) and the standing rule "always store UTC."

Same reasoning drives the other `@db.*` choices:
- `@db.VarChar(255)` — bounded length (vs unbounded `text`) for emails/hashes; enforces a constraint at the DB level.
- `@db.Text` for `originalUrl` — URLs can exceed 255 chars; `text` is the right unbounded type.
- `@db.Uuid` — native Postgres `uuid` (16 bytes) instead of `varchar(36)` (~36 bytes + collation overhead).
- `@db.Char(2)` for `countryCode` — fixed 2-letter ISO code.
- `@db.JsonB` — binary JSON (indexable, faster than `json`).
- `@db.Date` — calendar date only, no time component.

Without these, Prisma would pick `text`, `varchar`, `timestamp(3)`, `jsonb` defaults that don't match the design doc's contracts.

### What is `@map` (and `@@map`)?

They **decouple the application name from the database name**.

- `@map("password_hash")` on a field → Prisma client exposes `passwordHash` (idiomatic camelCase TS), but the actual Postgres column is `password_hash` (idiomatic snake_case SQL).
- `@@map("users")` on a model → Prisma client uses `prisma.user.*`, but the table is `users`.

Why we do this:

1. **Two ecosystems, two conventions.** JS/TS code reads naturally in camelCase (`user.passwordHash`). SQL reads naturally in snake_case (`SELECT password_hash FROM users`). `@map` lets each side keep its convention without compromising the other.
2. **Raw SQL stays readable.** Phase 3 will write hand-crafted SQL (triggers, partial indexes). Writing `CREATE INDEX ... ON urls(user_id, created_at DESC)` is much cleaner than `ON "Url"("userId", "createdAt" DESC)` (Prisma's default would force quoted PascalCase identifiers everywhere).
3. **DBA / analyst friendliness.** Anyone who opens psql, runs `\d urls`, or writes a BI query sees standard SQL naming — not Prisma artifacts.
4. **Refactor safety.** You can rename a TS field (`passwordHash` → `pwdHash`) without a DB migration, as long as `@map("password_hash")` stays. The DB column name is the stable contract.
5. **Matches the design doc.** db-design.md specifies `users`, `refresh_tokens`, `click_events`, `password_hash`, etc. — `@map`/`@@map` is what makes the generated SQL match that spec exactly.

Without `@@map("users")`, Prisma would create a table named `User` (PascalCase, quoted in SQL). Without `@map("password_hash")`, the column would be `passwordHash` (camelCase, quoted in SQL). Both work, both are ugly to query by hand, and neither matches the design doc.


---------------------------------------------------------------------------

From phase 3 -- 

### What got swapped

| Removed (Prisma `@@index`) | Replaced with (raw SQL) |
|---|---|
| `urls_user_id_created_at_idx` on `(user_id, created_at DESC)` | `idx_urls_user_created` on `(user_id, created_at DESC)` **WHERE is_deleted = false** |
| `urls_expires_at_idx` on `(expires_at)` | `idx_urls_expires_at` on `(expires_at)` **WHERE is_deleted = false AND expires_at IS NOT NULL** |
| `refresh_tokens_user_id_revoked_at_idx` on `(user_id, revoked_at)` | `idx_refresh_tokens_user_id` on `(user_id)` **WHERE revoked_at IS NULL** |
| `refresh_tokens_expires_at_idx` on `(expires_at)` | `idx_refresh_tokens_expires_at` on `(expires_at)` **WHERE revoked_at IS NULL** |

Two things changed: a **`WHERE` predicate** was added, and in the refresh-tokens case the **column list was simplified**.

### The core difference: full vs. partial index

A normal B-tree index includes **every row** in the table. A *partial* index includes **only rows matching the predicate**. Postgres will use the partial index automatically as long as your query's `WHERE` clause is logically implied by the index's predicate.

### Why this is a meaningful improvement

**1. Smaller index → faster lookups, less memory, less I/O.**
- A URL shortener will eventually have millions of soft-deleted rows (`is_deleted = true`). With the original full index, those dead rows occupy index pages, push hot pages out of the buffer cache, and slow every dashboard query.
- With the partial index, soft-deleted rows are simply not in the index. The dashboard query `WHERE user_id = ? AND is_deleted = false ORDER BY created_at DESC` walks an index containing only live URLs.

**2. Matches actual query shape.**
- Every "list user's URLs" query filters `is_deleted = false` — the API never returns deleted rows. So indexing them is pure waste.
- Every "find sessions to clean up" query filters `revoked_at IS NULL` — revoked tokens are dead state we keep for audit, not for lookup.

**3. The expiry-cleanup index gets a double benefit.**
- Original: `(expires_at)` indexed every URL, including the (likely majority) with `expires_at IS NULL`. Those NULLs sit in the index serving no one — the cleanup job is `WHERE expires_at < NOW()`, which can't match NULL anyway.
- Partial: `WHERE is_deleted = false AND expires_at IS NOT NULL` strips out both soft-deleted rows AND every never-expires URL. The index shrinks dramatically and the cleanup job's planner cost drops.

**4. The refresh-tokens case also drops a column.**
- Original was a composite `(user_id, revoked_at)`. The second column existed only so the planner could filter active sessions after seeking by user.
- Partial replaces that with `(user_id) WHERE revoked_at IS NULL`. The predicate enforces the filter at index-build time; storing `revoked_at` inside the index is no longer needed. Result: narrower index keys, smaller pages, faster scans.

### Why Prisma couldn't express this

Prisma's `@@index([...])` does not expose a `where:` argument for partial indexes (Postgres-specific feature). The schema language is intentionally ORM-portable; partial indexes are a Postgres extension to the SQL standard. The escape hatch is exactly what we did: drop the Prisma-generated index and re-create it via raw SQL in a migration.

### One thing the partial index "loses"

A full index can serve a query that *doesn't* include the predicate (e.g. an admin tool that wants to list deleted URLs too). A partial index can't. Trade-off accepted: those queries are rare, won't be on the hot path, and can fall back to a sequential scan or a separate purpose-built index when actually needed.

### Quick mental model

```
Full index:    every row, every value → big, "fair to all queries"
Partial index: subset Postgres knows you actually query → small, fast, specialized
```

For an OLTP system where ~95% of queries hit the same predicate, partial indexes are almost always the right call.