import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../src/generated/prisma/client';

/**
 * Integration test harness (Layer 3).
 *
 * Runs the worker's raw SQL against a REAL Postgres — the only thing that can
 * actually validate jsonb_object_agg / DISTINCT / ON CONFLICT / the expiry
 * UPDATE. Per the Day-15 decision it points at a SEPARATE `urlshortener_test`
 * database (env DATABASE_URL_TEST) on the same docker-compose Postgres, so dev
 * data is never mutated. The schema is built by replaying the real api
 * migrations — api owns the schema, we don't duplicate it here.
 */

const here = dirname(fileURLToPath(import.meta.url));
// helpers → integration → tests → worker → server → api/prisma/migrations
const MIGRATIONS_DIR = join(here, '..', '..', '..', '..', 'api', 'prisma', 'migrations');

/** Resolve the test DB URL or fail LOUD (per the Q2 decision — never skip). */
export function getTestDatabaseUrl(): string {
  const url = process.env['DATABASE_URL_TEST'];
  if (url === undefined || url.length === 0) {
    throw new Error(
      'Integration tests require a running Postgres and DATABASE_URL_TEST. ' +
        'Start docker-compose and set DATABASE_URL_TEST to a *test* database, e.g.\n' +
        '  DATABASE_URL_TEST=postgresql://dev:dev@localhost:5432/urlshortener_test'
    );
  }
  // Safety rail: this helper runs DROP SCHEMA. Refuse to touch a DB whose name
  // doesn't look like a test database, so a misconfigured URL can't wipe dev/prod.
  const dbName = url.split('/').pop()?.split('?')[0] ?? '';
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run integration tests against "${dbName}": the database name ` +
        'must contain "test" (this harness DROPs and recreates the schema).'
    );
  }
  return url;
}

/**
 * Drop and rebuild the schema by replaying the api migrations in order.
 * Called once per integration file (beforeAll). Throws an explicit, actionable
 * error if Postgres is unreachable.
 */
export async function resetDatabase(): Promise<void> {
  const connectionString = getTestDatabaseUrl();
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
  try {
    // Fail loud and clear if the server isn't up.
    try {
      await pool.query('SELECT 1');
    } catch (err) {
      throw new Error(
        `Cannot connect to the test Postgres at DATABASE_URL_TEST. Is docker-compose up?\n` +
          `Underlying error: ${(err as Error).message}`
      );
    }

    await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

    const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(); // timestamp-prefixed → lexicographic sort = chronological

    if (dirs.length === 0) {
      throw new Error(`No migrations found under ${MIGRATIONS_DIR}`);
    }

    for (const dir of dirs) {
      const sql = readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf8');
      await pool.query(sql);
    }
  } finally {
    await pool.end();
  }
}

/** A Prisma client (same PrismaPg adapter as production db.ts) on the test DB. */
export function createTestPrisma(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: getTestDatabaseUrl() });
  return new PrismaClient({ adapter });
}

/** Per-test isolation: wipe the tables the jobs touch. CASCADE covers FKs. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE click_events, daily_analytics_aggregates, urls RESTART IDENTITY CASCADE'
  );
}
