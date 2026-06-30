-- DropIndex
DROP INDEX "refresh_tokens_expires_at_idx";

-- DropIndex
DROP INDEX "refresh_tokens_user_id_revoked_at_idx";

-- DropIndex
DROP INDEX "urls_expires_at_idx";

-- DropIndex
DROP INDEX "urls_user_id_created_at_idx";

-- ────────────────────────────────────────────────────────────────────────────
-- Schema augmentation (raw SQL — features Prisma cannot model natively)
-- Reference: docs/db/db-design.md
-- ────────────────────────────────────────────────────────────────────────────

-- 1. update_timestamp() function + triggers
--    Prisma's @updatedAt only fires on writes through the client; raw SQL
--    UPDATEs (analytics jobs, admin tools, psql) bypass it. A DB-level
--    trigger guarantees updated_at always reflects the truth.
--    Uses clock_timestamp() instead of NOW(): NOW() returns the transaction
--    start time, so an INSERT+UPDATE inside one transaction would leave
--    updated_at == created_at. clock_timestamp() reflects the actual
--    modification moment.
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_urls_updated_at
  BEFORE UPDATE ON "urls"
  FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- 2. Case-insensitive uniqueness on users.email
--    Prisma manages "users_email_key" (case-sensitive). Add a functional
--    unique index on LOWER(email) so "Foo@x.com" and "foo@x.com" cannot
--    both be registered. App code should also normalize on write.
CREATE UNIQUE INDEX "idx_users_email_lower" ON "users" (LOWER("email"));

-- 3. Partial indexes on urls (replace plain @@index variants)
--    WHERE is_deleted = false → smaller index, faster lookups, ignores
--    soft-deleted rows that the API never returns anyway.
CREATE INDEX "idx_urls_user_created"
  ON "urls" ("user_id", "created_at" DESC)
  WHERE "is_deleted" = false;

CREATE INDEX "idx_urls_expires_at"
  ON "urls" ("expires_at")
  WHERE "is_deleted" = false AND "expires_at" IS NOT NULL;

-- 4. Partial indexes on refresh_tokens (replace plain @@index variants)
--    WHERE revoked_at IS NULL → only active sessions are indexed.
CREATE INDEX "idx_refresh_tokens_user_id"
  ON "refresh_tokens" ("user_id")
  WHERE "revoked_at" IS NULL;

CREATE INDEX "idx_refresh_tokens_expires_at"
  ON "refresh_tokens" ("expires_at")
  WHERE "revoked_at" IS NULL;

-- 5. GIN full-text index on urls.original_url
--    Enables fast full-text search across destination URLs (advanced
--    dashboard feature). Optional per docs but cheap to add now.
CREATE INDEX "idx_urls_original_url_fts"
  ON "urls"
  USING GIN (to_tsvector('english', "original_url"));

-- 6. Sequence cache for urls_id_seq
--    Pre-allocate 1000 IDs in memory per backend → fewer round-trips to
--    the sequence table at high insert rates. Tradeoff: gaps after crash
--    (acceptable for short-code source).
ALTER SEQUENCE urls_id_seq CACHE 1000;

