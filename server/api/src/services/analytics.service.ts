import type { PrismaClient } from '../generated/prisma/client';
import { createAnalyticsRepository } from '../repositories/analytics.repository';
import { OwnershipError } from '../utils/errors';
import type {
  AnalyticsSummary,
  AnalyticsEventsResult,
} from '../schemas/analytics.schema';

// Resolve ISO 3166-1 alpha-2 → English country name via Intl (full ICU in Node 20).
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export function createAnalyticsService(prisma: PrismaClient) {
  const repo = createAnalyticsRepository(prisma);

  /** Resolve + ownership-check in one place. Not found OR not owner → 404
   *  (OwnershipError), never 403 — prevents resource-existence leakage. */
  async function requireOwnedUrl(shortCode: string, userId: string) {
    const url = await repo.findUrlMetaByShortCode(shortCode);
    if (url === null || url.userId !== userId) {
      throw new OwnershipError();
    }
    return url;
  }

  return {
    async getSummary(shortCode: string, userId: string): Promise<AnalyticsSummary> {
      const url = await requireOwnedUrl(shortCode, userId);

      const [counts, daily, referrers, countries] = await Promise.all([
        repo.counts(url.id),
        repo.dailyBreakdown(url.id),
        repo.topReferrers(url.id),
        repo.topCountries(url.id),
      ]);

      return {
        shortCode: url.customAlias ?? url.shortCode,
        originalUrl: url.originalUrl,
        createdAt: url.createdAt.toISOString(),
        expiresAt: url.expiresAt?.toISOString() ?? null,
        totalClicks: counts.total,
        last7Days: counts.last7,
        last30Days: counts.last30,
        dailyBreakdown: daily,
        topReferrers: referrers,
        countries: countries.map((c) => ({
          countryCode: c.countryCode,
          countryName: countryName(c.countryCode),
          clicks: c.clicks,
        })),
      };
    },

    async getEvents(
      shortCode: string,
      userId: string,
      limit: number,
      offset: number
    ): Promise<AnalyticsEventsResult> {
      const url = await requireOwnedUrl(shortCode, userId);
      const { rows, total } = await repo.listEvents(url.id, limit, offset);

      return {
        events: rows.map((e) => ({
          id: e.id.toString(),
          clickedAt: e.clickedAt.toISOString(),
          countryCode: e.countryCode,
          city: e.city,
          deviceType: e.deviceType,
          browser: e.browser,
          os: e.os,
          referrerDomain: e.referrerDomain,
        })),
        total,
        limit,
        offset,
      };
    },
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
