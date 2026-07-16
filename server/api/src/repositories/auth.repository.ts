import { randomBytes } from 'crypto';
import type { PrismaClient } from '../generated/prisma/client.js';

interface CreateUserData {
  email: string;
  passwordHash: string;
  name: string;
}

interface CreateRefreshTokenData {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgent: string;
}

export function createAuthRepository(prisma: PrismaClient) {
  return {
    async findUserByEmail(email: string) {
      return prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, passwordHash: true, isActive: true },
      });
    },

    async findUserById(userId: string) {
      return prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, passwordHash: true, isActive: true },
      });
    },

    async createUser(data: CreateUserData) {
      return prisma.user.create({
        data,
        select: { id: true, email: true },
      });
    },

    async createRefreshToken(data: CreateRefreshTokenData) {
      return prisma.refreshToken.create({
        data,
        select: { id: true },
      });
    },

    async findRefreshToken(tokenHash: string) {
      return prisma.refreshToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          expiresAt: true,
          revokedAt: true,
          user: { select: { id: true, email: true, isActive: true } },
        },
      });
    },

    async revokeRefreshToken(tokenHash: string) {
      return prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },

    // Anonymizes the user row (email/name/password overwritten, isActive
    // flipped false — the sole "account deleted" signal; there's no separate
    // is_deleted flag since isActive has no other producer in this codebase),
    // soft-deletes all their URLs (analytics history survives per the
    // soft-delete rule), and hard-deletes their refresh tokens (no retention
    // requirement applies to those — they only carry auth/session data,
    // including the account-linked raw user-agent string). The trg_users_
    // updated_at DB trigger (schema_augmentation migration) stamps updatedAt
    // with the exact moment of this UPDATE, so it doubles as the deletion time.
    async deleteAccount(userId: string): Promise<void> {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: userId },
          data: {
            email: `deleted-${userId}@deleted.invalid`,
            name: '',
            passwordHash: randomBytes(32).toString('hex'),
            isActive: false,
          },
        }),
        prisma.url.updateMany({
          where: { userId, isDeleted: false },
          data: { isDeleted: true },
        }),
        prisma.refreshToken.deleteMany({ where: { userId } }),
      ]);
    },
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
