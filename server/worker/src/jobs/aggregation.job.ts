import type { AggregateRepository } from '../repositories/aggregate.repository';
import { logger } from '../logger';

const DAY_MS = 86_400_000;
/** IST is a fixed +05:30 offset (no DST), so a constant shift is exact. */
const IST_OFFSET_MS = 19_800_000; // 5.5h

/**
 * IST calendar date (YYYY-MM-DD) of the day before the IST day containing `now`.
 * We shift the instant by the IST offset and read the UTC date of the result —
 * that *is* the IST wall-clock date — then step back exactly one day. Uses only
 * `getTime` / `toISOString` (both UTC-based), so the result is independent of
 * the host's local timezone. Exported for unit testing (Day 15).
 *
 * Storage stays UTC; we only reason in IST here at the edge. See DECISIONS.md #12.
 */
export function istYesterday(now: Date): string {
  const istNow = now.getTime() + IST_OFFSET_MS;
  return new Date(istNow - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Roll up the previous IST day's raw click_events into daily_analytics_aggregates.
 * Scheduled at 00:15 IST. The IST→instant bucketing happens in SQL (the repo
 * takes just the IST date string). Idempotent — safe to re-run for the same day.
 * `referenceDate` is injectable for testing (defaults to now).
 */
export function createAggregationJob(repo: AggregateRepository) {
  return async function runDailyAggregation(referenceDate: Date = new Date()): Promise<void> {
    const date = istYesterday(referenceDate);
    logger.info({ date }, 'Daily aggregation starting');
    try {
      const rows = await repo.aggregateDay(date);
      logger.info({ date, urls: rows }, 'Daily aggregation complete');
    } catch (err) {
      // Cron job failures must not crash the worker process; log and move on.
      logger.error({ err, date }, 'Daily aggregation failed');
    }
  };
}
