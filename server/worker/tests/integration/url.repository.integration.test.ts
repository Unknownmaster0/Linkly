import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createUrlRepository } from '../../src/repositories/url.repository';
import { resetDatabase, createTestPrisma, truncateAll } from './helpers/test-db';

/**
 * Layer 3 — the real expiry-sweep SQL against a real Postgres.
 *
 * Proves the soft-delete UPDATE flips only the right rows, never hard-deletes
 * (analytics history must survive), is idempotent, and respects the strict
 * `expires_at < now` boundary.
 */

const NOW = new Date('2026-06-16T00:00:00.000Z');

let prisma: PrismaClient;
let repo: ReturnType<typeof createUrlRepository>;

beforeAll(async () => {
  await resetDatabase();
  prisma = createTestPrisma();
  repo = createUrlRepository(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

async function seedUrl(opts: {
  id: number;
  shortCode: string;
  expiresAt: string | null;
  isDeleted: boolean;
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO urls (id, short_code, original_url, expires_at, is_deleted)
    VALUES (
      ${BigInt(opts.id)}, ${opts.shortCode}, ${`https://example.com/${opts.id}`},
      ${opts.expiresAt === null ? null : new Date(opts.expiresAt)}, ${opts.isDeleted}
    )
  `;
}

async function isDeleted(id: number): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ is_deleted: boolean }[]>`
    SELECT is_deleted FROM urls WHERE id = ${BigInt(id)}
  `;
  return rows[0]!.is_deleted;
}

describe('softDeleteExpired (UTC baseline, real Postgres)', () => {
  it('soft-deletes only past, not-already-deleted URLs', async () => {
    await seedUrl({ id: 1, shortCode: 'past', expiresAt: '2026-06-15T00:00:00.000Z', isDeleted: false }); // expired → delete
    await seedUrl({ id: 2, shortCode: 'futr', expiresAt: '2026-06-20T00:00:00.000Z', isDeleted: false }); // future → keep
    await seedUrl({ id: 3, shortCode: 'perm', expiresAt: null, isDeleted: false }); // no expiry → keep
    await seedUrl({ id: 4, shortCode: 'gone', expiresAt: '2026-06-10T00:00:00.000Z', isDeleted: true }); // already gone

    const deleted = await repo.softDeleteExpired(NOW);

    expect(deleted).toBe(1); // only url 1
    expect(await isDeleted(1)).toBe(true);
    expect(await isDeleted(2)).toBe(false);
    expect(await isDeleted(3)).toBe(false);
    expect(await isDeleted(4)).toBe(true); // untouched, not re-counted
  });

  it('excludes a URL expiring exactly at now (strict <)', async () => {
    await seedUrl({ id: 1, shortCode: 'edge', expiresAt: '2026-06-16T00:00:00.000Z', isDeleted: false });
    const deleted = await repo.softDeleteExpired(NOW);
    expect(deleted).toBe(0);
    expect(await isDeleted(1)).toBe(false);
  });

  it('soft-deletes only — never hard-deletes; analytics rows survive', async () => {
    await seedUrl({ id: 1, shortCode: 'keep', expiresAt: '2026-06-15T00:00:00.000Z', isDeleted: false });
    await prisma.$executeRaw`
      INSERT INTO click_events (url_id, ip_hash, device_type)
      VALUES (${BigInt(1)}, ${'h'}, ${'mobile'}::"DeviceType")
    `;

    await repo.softDeleteExpired(NOW);

    const urlRows = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM urls WHERE id = ${BigInt(1)}`;
    const clickRows = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM click_events WHERE url_id = ${BigInt(1)}`;
    expect(urlRows[0]!.n).toBe(1); // row still present (flagged, not removed)
    expect(clickRows[0]!.n).toBe(1); // analytics history preserved
  });

  it('is idempotent — a second run deletes nothing', async () => {
    await seedUrl({ id: 1, shortCode: 'idem', expiresAt: '2026-06-15T00:00:00.000Z', isDeleted: false });

    expect(await repo.softDeleteExpired(NOW)).toBe(1);
    expect(await repo.softDeleteExpired(NOW)).toBe(0);
    expect(await isDeleted(1)).toBe(true);
  });
});
