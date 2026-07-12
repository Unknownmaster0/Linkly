import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * All Prisma access for the daily_analytics_aggregates resource.
 *
 * CQRS write side: raw click_events are rolled up per url_id into one
 * pre-aggregated row per (url_id, date). Read side (api analytics route)
 * currently queries raw click_events per the locked contract; these aggregates
 * are populated for future scale.
 */
export function createAggregateRepository(prisma: PrismaClient) {
  return {
    /**
     * Aggregate all click_events falling on the IST calendar day `date`
     * (YYYY-MM-DD) and upsert one daily_analytics_aggregates row per url_id.
     * Storage is UTC (timestamptz); the IST day is resolved in SQL via
     * `AT TIME ZONE 'Asia/Kolkata'`, which turns the IST midnight boundaries
     * into the absolute instants `clicked_at` is compared against — a half-open
     * [IST 00:00, next IST 00:00) window. Idempotent (ON CONFLICT updates), so
     * the job can be re-run for the same day. Returns the number of url rows
     * written. See DECISIONS.md #12.
     */
    async aggregateDay(date: string): Promise<number> {
      return prisma.$executeRaw`
        WITH bounds AS (
          SELECT
            (${date}::date)::timestamp       AT TIME ZONE 'Asia/Kolkata' AS day_start,
            ((${date}::date + 1)::timestamp) AT TIME ZONE 'Asia/Kolkata' AS day_end
        ),
        base AS (
          SELECT c.url_id, c.ip_hash, c.country_code, c.referrer_domain, c.device_type
          FROM click_events c, bounds b
          WHERE c.clicked_at >= b.day_start AND c.clicked_at < b.day_end
        ),
        totals AS (
          SELECT url_id, COUNT(*)::int AS total, COUNT(DISTINCT ip_hash)::int AS uniq
          FROM base GROUP BY url_id
        ),
        countries AS (
          SELECT url_id, jsonb_object_agg(country_code, c) AS top_countries
          FROM (
            SELECT url_id, country_code, COUNT(*)::int c
            FROM base WHERE country_code IS NOT NULL
            GROUP BY url_id, country_code
          ) x GROUP BY url_id
        ),
        referrers AS (
          SELECT url_id, jsonb_object_agg(ref, c) AS top_referrers
          FROM (
            SELECT url_id, COALESCE(referrer_domain, 'direct') AS ref, COUNT(*)::int c
            FROM base GROUP BY url_id, COALESCE(referrer_domain, 'direct')
          ) x GROUP BY url_id
        ),
        devices AS (
          SELECT url_id, jsonb_object_agg(device_type, c) AS device_breakdown
          FROM (
            SELECT url_id, device_type::text AS device_type, COUNT(*)::int c
            FROM base GROUP BY url_id, device_type
          ) x GROUP BY url_id
        )
        INSERT INTO daily_analytics_aggregates
          (url_id, date, total_clicks, unique_clicks, top_countries, top_referrers, device_breakdown)
        SELECT
          t.url_id,
          ${date}::date,
          t.total,
          t.uniq,
          COALESCE(c.top_countries, '{}'::jsonb),
          COALESCE(r.top_referrers, '{}'::jsonb),
          COALESCE(d.device_breakdown, '{}'::jsonb)
        FROM totals t
        LEFT JOIN countries c USING (url_id)
        LEFT JOIN referrers r USING (url_id)
        LEFT JOIN devices  d USING (url_id)
        ON CONFLICT (url_id, date) DO UPDATE SET
          total_clicks     = EXCLUDED.total_clicks,
          unique_clicks    = EXCLUDED.unique_clicks,
          top_countries    = EXCLUDED.top_countries,
          top_referrers    = EXCLUDED.top_referrers,
          device_breakdown = EXCLUDED.device_breakdown
      `;
    },
  };
}

export type AggregateRepository = ReturnType<typeof createAggregateRepository>;
