import type { PrismaClient } from '../generated/prisma/client';

interface CreateUrlData {
  shortCode: string;
  userId?: string;
  originalUrl: string;
  customAlias: string | null;
  expiresAt: Date;
  tags: string[];
}

interface UrlRecord {
  shortCode: string;
  originalUrl: string;
  customAlias: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

interface UrlListRecord {
  shortCode: string;
  originalUrl: string;
  customAlias: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  clickCount: bigint;
}

export function createUrlRepository(prisma: PrismaClient) {
  return {
    // Checks whether a code is already taken in the shared short-code namespace.
    // short_code and custom_alias are two separate @unique columns, but a
    // requested alias collides if it matches EITHER — so probe both. No
    // is_deleted filter: soft-deleted rows still occupy the unique indexes,
    // so this pre-check must mirror what the DB constraint will actually enforce.
    async findByShortCodeOrAlias(code: string): Promise<{ id: bigint } | null> {
      return prisma.url.findFirst({
        where: { OR: [{ shortCode: code }, { customAlias: code }] },
        select: { id: true },
      });
    },

    async nextSequenceValue(): Promise<bigint> {
      const result = await prisma.$queryRaw<[{ nextval: bigint }]>`
        SELECT nextval('urls_id_seq')
      `;
      const nextId = result[0]?.nextval;
      if (nextId === undefined) {
        throw new Error('Sequence nextval returned no rows');
      }
      return nextId;
    },

    async create(data: CreateUrlData): Promise<UrlRecord> {
      return prisma.url.create({
        data,
        select: {
          shortCode: true,
          originalUrl: true,
          customAlias: true,
          expiresAt: true,
          createdAt: true,
        },
      });
    },

    // The caller's non-deleted URLs, newest first. Backed by the partial index
    // (WHERE is_deleted = false) on (user_id, created_at DESC) from the
    // schema_augmentation migration. `clickCount` is the denormalized counter
    // column the analytics worker maintains write-behind — not a live COUNT(*).
    async findByUserId(userId: string): Promise<UrlListRecord[]> {
      return prisma.url.findMany({
        where: { userId, isDeleted: false },
        orderBy: { createdAt: 'desc' },
        select: {
          shortCode: true,
          originalUrl: true,
          customAlias: true,
          expiresAt: true,
          createdAt: true,
          clickCount: true,
        },
      });
    },

    // Soft-delete a URL the caller owns. `code` may be either the short_code or
    // the custom_alias (they share one namespace), so probe both. The query is
    // scoped by userId, so a code owned by another user looks identical to a
    // missing one — both return null and the service maps that to a 404
    // (IDOR prevention; never reveal that the resource exists).
    //
    // find + update run in an interactive transaction so the ownership check and
    // the write are atomic: a concurrent delete in the gap can't make both calls
    // observe the row as not-yet-deleted. Returns the row's identifying fields so
    // the route handler knows which Valkey key to evict, or null if nothing matched.
    async softDeleteByCode(
      code: string,
      userId: string
    ): Promise<{ shortCode: string; customAlias: string | null } | null> {
      return prisma.$transaction(async (tx) => {
        const record = await tx.url.findFirst({
          where: {
            OR: [{ shortCode: code }, { customAlias: code }],
            userId,
            isDeleted: false,
          },
          select: { shortCode: true, customAlias: true },
        });
        if (!record) return null;

        await tx.url.update({
          where: { shortCode: record.shortCode },
          data: { isDeleted: true },
        });

        return record;
      });
    },
  };
}
