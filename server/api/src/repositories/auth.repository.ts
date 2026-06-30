import type { PrismaClient } from '../generated/prisma/client';

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
  };
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
