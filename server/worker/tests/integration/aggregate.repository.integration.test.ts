import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createAggregateRepository } from '../../src/repositories/aggregate.repository';
import { resetDatabase, createTestPrisma, truncateAll } from './helpers/test-db';

/**
 * Layer 3 — the real aggregation SQL against a real Postgres.
 *
 * A mock can't validate jsonb_object_agg / COUNT(DISTINCT) / ON CONFLICT, nor
 * the `AT TIME ZONE 'Asia/Kolkata'` IST bucketing — only the engine can. These
 * seed click_events, run repo.aggregateDay(istDate), then SELECT the
 * daily_analytics_aggregates row back and assert the numbers and JSONB.
 *
 * DAY is an IST calendar date. The IST day 2026-06-15 is the half-open instant
 * window [2026-06-14T18:30Z, 2026-06-15T18:30Z) — IST midnight is 18:30 UTC of
 * the previous day. Seeds straddle that boundary to prove IST (not UTC) bucketing.
 */

const DAY = '2026-06-15'; // IST calendar date
const IST_START = '2026-06-14T18:30:00.000Z'; // 00:00 IST Jun 15
const IST_END = '2026-06-15T18:30:00.000Z'; // 00:00 IST Jun 16 (excluded)

let prisma: PrismaClient;
let repo: ReturnType<typeof createAggregateRepository>;

beforeAll(async () => {
  await resetDatabase();
  prisma = createTestPrisma();
  repo = createAggregateRepository(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await truncateAll(prisma);
});

async function seedUrl(id: number, shortCode: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO urls (id, short_code, original_url)
    VALUES (${BigInt(id)}, ${shortCode}, ${`https://example.com/${id}`})
  `;
}

async function seedClick(opts: {
  urlId: number;
  ipHash: string;
  country: string | null;
  referrer: string | null;
  device: string;
  clickedAt: string;
}): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO click_events (url_id, ip_hash, country_code, referrer_domain, device_type, clicked_at)
    VALUES (
      ${BigInt(opts.urlId)}, ${opts.ipHash}, ${opts.country}, ${opts.referrer},
      ${opts.device}::"DeviceType", ${new Date(opts.clickedAt)}
    )
  `;
}

type AggregateRow = {
  total_clicks: number;
  unique_clicks: number;
  top_countries: Record<string, number>;
  top_referrers: Record<string, number>;
  device_breakdown: Record<string, number>;
};

async function readAggregate(urlId: number): Promise<AggregateRow | undefined> {
  const rows = await prisma.$queryRaw<AggregateRow[]>`
    SELECT total_clicks, unique_clicks, top_countries, top_referrers, device_breakdown
    FROM daily_analytics_aggregates
    WHERE url_id = ${BigInt(urlId)} AND date = ${DAY}::date
  `;
  return rows[0];
}

describe('aggregateDay (IST bucketing, real Postgres)', () => {
  it('rolls the IST day up into one row with correct totals, uniques and JSONB', async () => {
    await seedUrl(1, 'aaa');
    // 4 in-window clicks (IST Jun 15); ip 'a' repeats (so 3 uniques).
    await seedClick({ urlId: 1, ipHash: 'a', country: 'US', referrer: 'google.com', device: 'mobile', clickedAt: IST_START }); // == IST start → included
    await seedClick({ urlId: 1, ipHash: 'a', country: 'US', referrer: 'google.com', device: 'mobile', clickedAt: '2026-06-15T06:00:00.000Z' }); // 11:30 IST Jun 15
    await seedClick({ urlId: 1, ipHash: 'b', country: 'IN', referrer: null, device: 'desktop', clickedAt: '2026-06-15T12:00:00.000Z' }); // 17:30 IST; null referrer → 'direct'
    await seedClick({ urlId: 1, ipHash: 'c', country: null, referrer: 'twitter.com', device: 'mobile', clickedAt: '2026-06-15T18:29:59.000Z' }); // 23:59:59 IST Jun 15
    // out-of-window — must be ignored
    await seedClick({ urlId: 1, ipHash: 'z', country: 'US', referrer: 'google.com', device: 'mobile', clickedAt: '2026-06-14T18:29:59.000Z' }); // before IST start (23:59:59 IST Jun 14)
    await seedClick({ urlId: 1, ipHash: 'y', country: 'US', referrer: 'google.com', device: 'mobile', clickedAt: IST_END }); // == IST end (00:00 IST Jun 16) → excluded

    const written = await repo.aggregateDay(DAY);
    expect(written).toBe(1); // one url row written

    const row = await readAggregate(1);
    expect(row).toBeDefined();
    expect(row!.total_clicks).toBe(4);
    expect(row!.unique_clicks).toBe(3);
    expect(row!.top_countries).toEqual({ US: 2, IN: 1 }); // null country omitted
    expect(row!.top_referrers).toEqual({ 'google.com': 2, direct: 1, 'twitter.com': 1 });
    expect(row!.device_breakdown).toEqual({ mobile: 3, desktop: 1 });
  });

  it('buckets by the IST calendar day, not the UTC day', async () => {
    await seedUrl(1, 'tz');
    // 2026-06-15T05:00Z = 10:30 IST Jun 15 → belongs to IST day Jun 15
    await seedClick({ urlId: 1, ipHash: 'a', country: 'US', referrer: null, device: 'mobile', clickedAt: '2026-06-15T05:00:00.000Z' });
    // 2026-06-15T20:00Z = 01:30 IST Jun 16 → IST day Jun 16, NOT Jun 15 (UTC logic would wrongly include it)
    await seedClick({ urlId: 1, ipHash: 'b', country: 'US', referrer: null, device: 'mobile', clickedAt: '2026-06-15T20:00:00.000Z' });

    await repo.aggregateDay(DAY); // DAY = 2026-06-15 IST

    const row = await readAggregate(1);
    expect(row!.total_clicks).toBe(1); // only the 10:30 IST click
  });

  it('respects the half-open IST boundary: includes IST start, excludes IST end', async () => {
    await seedUrl(1, 'bnd');
    await seedClick({ urlId: 1, ipHash: 'a', country: 'US', referrer: null, device: 'mobile', clickedAt: '2026-06-14T18:29:59.999Z' }); // before IST start
    await seedClick({ urlId: 1, ipHash: 'b', country: 'US', referrer: null, device: 'mobile', clickedAt: IST_START }); // == IST start, in
    await seedClick({ urlId: 1, ipHash: 'c', country: 'US', referrer: null, device: 'mobile', clickedAt: IST_END }); // == IST end, out

    await repo.aggregateDay(DAY);

    const row = await readAggregate(1);
    expect(row!.total_clicks).toBe(1);
  });

  it('is idempotent — re-running updates the same row (ON CONFLICT), never duplicates', async () => {
    await seedUrl(1, 'idem');
    await seedClick({ urlId: 1, ipHash: 'a', country: 'US', referrer: null, device: 'mobile', clickedAt: '2026-06-15T10:00:00.000Z' });

    await repo.aggregateDay(DAY);
    await repo.aggregateDay(DAY); // second run, same day

    const all = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM daily_analytics_aggregates WHERE url_id = ${BigInt(1)}
    `;
    expect(all[0]!.n).toBe(1); // still exactly one row

    // A new click + re-run UPDATEs the existing row in place.
    await seedClick({ urlId: 1, ipHash: 'b', country: 'US', referrer: null, device: 'mobile', clickedAt: '2026-06-15T11:00:00.000Z' });
    await repo.aggregateDay(DAY);

    const row = await readAggregate(1);
    expect(row!.total_clicks).toBe(2);
    expect(row!.unique_clicks).toBe(2);
  });

  it('writes one row per url and returns the row count', async () => {
    await seedUrl(1, 'one');
    await seedUrl(2, 'two');
    await seedClick({ urlId: 1, ipHash: 'a', country: 'US', referrer: null, device: 'mobile', clickedAt: '2026-06-15T10:00:00.000Z' });
    await seedClick({ urlId: 2, ipHash: 'b', country: 'IN', referrer: null, device: 'desktop', clickedAt: '2026-06-15T10:00:00.000Z' });

    const written = await repo.aggregateDay(DAY);
    expect(written).toBe(2);
  });
});
