import type { PrismaClient } from '../generated/prisma/client';

export type UrlRecord = {
  id: bigint;
  originalUrl: string;
  isActive: boolean;
  isDeleted: boolean;
  isFlagged: boolean;
  expiresAt: Date | null;
};

export function createUrlRepository(prisma: PrismaClient) {
  return {
    async findByShortCode(shortCode: string): Promise<UrlRecord | null> {
      return prisma.url.findUnique({
        where: { shortCode },
        select: {
          id: true,
          originalUrl: true,
          isActive: true,
          isDeleted: true,
          isFlagged: true,
          expiresAt: true,
        },
      });
    },
  };
}
