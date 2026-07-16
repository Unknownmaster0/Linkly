import type { PrismaClient } from '../generated/prisma/client.js';

export interface UrlMeta {
  id: bigint;
  userId: string | null;
  shortCode: string;
  customAlias: string | null;
  originalUrl: string;
  createdAt: Date;
  expiresAt: Date | null;
}

interface CountRow {
  total: number;
  last7: number;
  last30: number;
}
interface DailyRow {
  date: string;
  clicks: number;
}
interface ReferrerRow {
  referrer: string;
  clicks: number;
}
interface CountryRow {
  countryCode: string;
  clicks: number;
}

const DAY_MS = 86_400_000;

/**
 * All Prisma access for analytics reads. Per the LOCKED API_CONTRACT, the summary
 * is computed live from raw click_events (no pre-aggregation in MVP). Counts are
 * cast to ::int in SQL so they arrive as JS numbers, not BigInt.
 */
export function createAnalyticsRepository(prisma: PrismaClient) {
  return {
    /** Resolve a short code OR custom alias to its owning URL's metadata.
     *  Returns null when no such URL exists (caller maps null → 404). */
    async findUrlMetaByShortCode(shortCode: string): Promise<UrlMeta | null> {
      return prisma.url.findFirst({
        where: { OR: [{ shortCode }, { customAlias: shortCode }] },
        select: {
          id: true,
          userId: true,
          shortCode: true,
          customAlias: true,
          originalUrl: true,
          createdAt: true,
          expiresAt: true,
        },
      });
    },

    async counts(urlId: bigint): Promise<CountRow> {
      const now = Date.now();
      const d7 = new Date(now - 7 * DAY_MS);
      const d30 = new Date(now - 30 * DAY_MS);
      const rows = await prisma.$queryRaw<CountRow[]>`
        SELECT
          COUNT(*)::int                                        AS total,
          COUNT(*) FILTER (WHERE clicked_at >= ${d7})::int     AS last7,
          COUNT(*) FILTER (WHERE clicked_at >= ${d30})::int    AS last30
        FROM click_events
        WHERE url_id = ${urlId}
      `;
      return rows[0] ?? { total: 0, last7: 0, last30: 0 };
    },

    /** Per-day click counts over the last 30 days (UTC), sorted descending. */
    async dailyBreakdown(urlId: bigint): Promise<DailyRow[]> {
      const d30 = new Date(Date.now() - 30 * DAY_MS);
      return prisma.$queryRaw<DailyRow[]>`
        SELECT to_char(clicked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
               COUNT(*)::int AS clicks
        FROM click_events
        WHERE url_id = ${urlId} AND clicked_at >= ${d30}
        GROUP BY 1
        ORDER BY 1 DESC
      `;
    },

    /** Top 10 referrers; NULL referrer_domain is reported as 'direct'. */
    async topReferrers(urlId: bigint): Promise<ReferrerRow[]> {
      return prisma.$queryRaw<ReferrerRow[]>`
        SELECT COALESCE(referrer_domain, 'direct') AS referrer,
               COUNT(*)::int AS clicks
        FROM click_events
        WHERE url_id = ${urlId}
        GROUP BY 1
        ORDER BY clicks DESC
        LIMIT 10
      `;
    },

    /** Top 20 countries (rows with a resolved country_code only). */
    async topCountries(urlId: bigint): Promise<CountryRow[]> {
      return prisma.$queryRaw<CountryRow[]>`
        SELECT country_code AS "countryCode",
               COUNT(*)::int AS clicks
        FROM click_events
        WHERE url_id = ${urlId} AND country_code IS NOT NULL
        GROUP BY 1
        ORDER BY clicks DESC
        LIMIT 20
      `;
    },

    /** Paginated raw events within the 90-day retention window. */
    async listEvents(urlId: bigint, limit: number, offset: number) {
      const since = new Date(Date.now() - 90 * DAY_MS);
      const where = { urlId, clickedAt: { gt: since } };
      const [rows, total] = await Promise.all([
        prisma.clickEvent.findMany({
          where,
          orderBy: { clickedAt: 'desc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            clickedAt: true,
            countryCode: true,
            deviceType: true,
            browser: true,
            os: true,
            referrerDomain: true,
          },
        }),
        prisma.clickEvent.count({ where }),
      ]);
      return { rows, total };
    },
  };
}

export type AnalyticsRepository = ReturnType<typeof createAnalyticsRepository>;
