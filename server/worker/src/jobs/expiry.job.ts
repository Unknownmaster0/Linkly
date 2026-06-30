import type { UrlRepository } from '../repositories/url.repository';
import { logger } from '../logger';

/**
 * Eager expiry sweep: soft-delete URLs whose expires_at has passed.
 * Scheduled at 01:00 UTC (after the 00:05 aggregation run).
 *
 * This is the *eager* half of the two-part expiry strategy. The *lazy* half
 * (the redirect handler returning 410 the instant expires_at < now) already
 * guarantees correctness on the read path; this job is purely about hygiene —
 * dropping dead rows out of the hot partial indexes (WHERE is_deleted = false)
 * so the redirect server's index scans stay small as expired links accumulate.
 *
 * `referenceDate` is injectable for testing (defaults to now). Failures are
 * logged and swallowed: a cron error must never crash the worker process.
 */
export function createExpiryJob(repo: UrlRepository) {
  return async function runExpiryCleanup(referenceDate: Date = new Date()): Promise<void> {
    logger.info('Expiry cleanup starting');
    try {
      const deleted = await repo.softDeleteExpired(referenceDate);
      logger.info({ deleted }, `Expiry cleanup complete: soft-deleted ${deleted} expired URLs`);
    } catch (err) {
      logger.error({ err }, 'Expiry cleanup failed');
    }
  };
}
