import type { PrismaClient } from '../generated/prisma/client.js';
import type { DeviceType } from '../generated/prisma/enums.js';

export type InsertClickData = {
  urlId: bigint;
  ipHash: string;
  countryCode: string | null;
  city: string | null;
  deviceType: DeviceType;
  browser: string | null;
  os: string | null;
  referrerDomain: string | null;
};

/**
 * All Prisma access for the click_events resource and the denormalized
 * urls.click_count counter (per the "all Prisma calls → repository layer" rule).
 */
export function createClickEventRepository(prisma: PrismaClient) {
  return {
    /**
     * Resolve a short code to its URL id. Returns null when the URL does not
     * exist (or was hard-deleted) — the caller discards the job in that case.
     */
    async resolveUrlId(shortCode: string): Promise<bigint | null> {
      const url = await prisma.url.findUnique({
        where: { shortCode },
        select: { id: true },
      });
      return url?.id ?? null;
    },

    async insertClick(data: InsertClickData): Promise<void> {
      await prisma.clickEvent.create({ data });
    },

    /**
     * Batch-increment the denormalized click_count for many URLs in one round
     * trip. Each entry: [urlId, delta]. Runs inside a single transaction.
     */
    async batchIncrementClickCount(counts: Map<bigint, number>): Promise<void> {
      if (counts.size === 0) return;
      await prisma.$transaction(
        [...counts.entries()].map(([urlId, delta]) =>
          prisma.url.update({
            where: { id: urlId },
            data: { clickCount: { increment: delta } },
          })
        )
      );
    },
  };
}

export type ClickEventRepository = ReturnType<typeof createClickEventRepository>;
