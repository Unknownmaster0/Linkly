import type { PrismaClient } from '../generated/prisma/client';

/**
 * All Prisma access for the urls resource needed by the worker (per the
 * "all Prisma calls → repository layer" rule). Currently only the eager
 * expiry sweep.
 */
export function createUrlRepository(prisma: PrismaClient) {
  return {
    /**
     * Eager expiry cleanup: soft-delete every URL whose expires_at has already
     * passed and that isn't already deleted. SOFT delete only (is_deleted =
     * true) — never a hard DELETE — so analytics history (click_events,
     * aggregates) survives, per the locked delete-strategy decision.
     *
     * Raw SQL (matching aggregate.repository) so the worker's minimal Prisma
     * model doesn't need the expires_at column. Returns the number of rows
     * affected, for the job's "deleted N expired URLs" log line.
     */
    async softDeleteExpired(now: Date): Promise<number> {
      return prisma.$executeRaw`
        UPDATE urls
        SET is_deleted = true, updated_at = NOW()
        WHERE expires_at IS NOT NULL
          AND expires_at < ${now}
          AND is_deleted = false
      `;
    },
  };
}

export type UrlRepository = ReturnType<typeof createUrlRepository>;
