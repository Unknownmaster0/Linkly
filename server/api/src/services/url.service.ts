import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { encodeToBase62 } from '../utils/base62.js';
import { config } from '../config.js';
import { ConflictError, OwnershipError } from '../utils/errors.js';
import { createUrlRepository } from '../repositories/url.repository.js';
import type { CreateUrlCommand, ShortenResult, UrlListResult } from '../schemas/url.schema.js';

// Auto-generated short codes are re-rolled on the (astronomically rare) chance
// that the Base62-encoded sequence value collides with an existing custom alias
// occupying the shared short_code namespace. Each attempt pulls a NEW sequence
// value, so the input genuinely changes between tries (this is a code-generation
// retry, not a blind P2002 retry). A small cap is a safety valve.
const MAX_CODE_GEN_ATTEMPTS = 5;

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return (err as Prisma.PrismaClientKnownRequestError).code === 'P2002';
}

export function createUrlService(prisma: PrismaClient) {
  const repo = createUrlRepository(prisma);

  function toResult(created: Awaited<ReturnType<typeof repo.create>>): ShortenResult {
    // shortUrl resolves to customAlias if provided, otherwise the Base62 code
    const resolvedCode = created.customAlias ?? created.shortCode;
    return {
      shortCode: created.shortCode,
      shortUrl: `${config.REDIRECT_URL}/${resolvedCode}`,
      originalUrl: created.originalUrl,
      customAlias: created.customAlias,
      createdAt: created.createdAt.toISOString(),
      expiresAt: created.expiresAt?.toISOString() ?? null,
    };
  }

  return {
    async createShortUrl(command: CreateUrlCommand, userId: string): Promise<ShortenResult> {
      const alias = command.customAlias;

      // ── Custom alias path ───────────────────────────────────────────────────
      // The alias shares one namespace with auto-generated codes (it is written
      // into both the unique short_code and custom_alias columns). The pre-check
      // is best-effort UX; the unique constraint is the real guarantee. Catching
      // P2002 from create() closes the TOCTOU race between the pre-check and the
      // insert so the race loser gets the SAME field-scoped 409 as the pre-check.
      if (alias !== undefined) {
        const existing = await repo.findByShortCodeOrAlias(alias);
        if (existing !== null) {
          throw new ConflictError('Custom alias already in use', { field: 'customAlias' });
        }

        try {
          const created = await repo.create({
            shortCode: alias,
            userId,
            originalUrl: command.originalUrl,
            customAlias: alias,
            expiresAt: command.expiresAt,
            tags: [],
          });
          return toResult(created);
        } catch (err) {
          // A P2002 here means a concurrent request claimed the alias first
          // (race loser). The conflict is always the user's alias — return the
          // identical envelope the pre-check would have produced.
          if (isUniqueViolation(err)) {
            throw new ConflictError('Custom alias already in use', { field: 'customAlias' });
          }
          throw err;
        }
      }

      // ── Auto-generated path ─────────────────────────────────────────────────
      // No alias → customAlias is null, so the insert only writes short_code; a
      // P2002 can only be a short_code collision (e.g. the generated code equals
      // an existing custom alias). Re-roll with the next sequence value.
      for (let attempt = 0; attempt < MAX_CODE_GEN_ATTEMPTS; attempt++) {
        const nextId = await repo.nextSequenceValue();
        const shortCode = encodeToBase62(nextId);
        try {
          const created = await repo.create({
            shortCode,
            userId,
            originalUrl: command.originalUrl,
            customAlias: null,
            expiresAt: command.expiresAt,
            tags: [],
          });
          return toResult(created);
        } catch (err) {
          // Re-roll on collision; on the final attempt let P2002 propagate to the
          // global handler (generic 409) rather than loop forever.
          if (isUniqueViolation(err) && attempt < MAX_CODE_GEN_ATTEMPTS - 1) {
            continue;
          }
          throw err;
        }
      }

      // Unreachable: the loop either returns or throws on the final attempt.
      throw new ConflictError('Unable to generate a unique short code, please retry');
    },

    async listUrls(userId: string): Promise<UrlListResult> {
      const records = await repo.findByUserId(userId);
      const urls = records.map((r: { shortCode: string; originalUrl: string; customAlias: string | null; expiresAt: Date | null; createdAt: Date; clickCount: bigint }) => ({
        shortCode: r.shortCode,
        // Mirrors toResult(): a custom alias, when present, IS the short code.
        shortUrl: `${config.REDIRECT_URL}/${r.customAlias ?? r.shortCode}`,
        originalUrl: r.originalUrl,
        customAlias: r.customAlias,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null,
        // clickCount is BigInt in Prisma; JSON.stringify(BigInt) throws, so the
        // Number() conversion is non-optional. The contract types it as an integer.
        clickCount: Number(r.clickCount),
        // Constant: the repository already filters out soft-deleted rows.
        isDeleted: false,
      }));
      return { urls, total: urls.length };
    },

    // Soft-delete the caller's URL. The repository scopes by userId, so a null
    // result means "not found OR not owned" — both surface as OwnershipError (404)
    // to avoid leaking which short codes exist (IDOR). The identifying record is
    // returned so the route handler can evict the matching cache key.
    async deleteUrl(
      code: string,
      userId: string
    ): Promise<{ shortCode: string; customAlias: string | null }> {
      const record = await repo.softDeleteByCode(code, userId);
      if (!record) throw new OwnershipError();
      return record;
    },
  };
}

export type UrlService = ReturnType<typeof createUrlService>;
