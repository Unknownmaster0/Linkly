import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import { config } from '../config';
import { AuthError, ConflictError } from '../utils/errors';
import { createAuthRepository } from '../repositories/auth.repository';
import type { PrismaClient } from '../generated/prisma/client';

interface AuthResult {
  user: { id: string; email: string };
  accessToken: string;
  refreshToken: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateOpaqueToken(): string {
  return randomBytes(32).toString('hex');
}

function signAccessToken(userId: string, email: string): string {
  return jwt.sign({ userId, email }, config.JWT_SECRET, { expiresIn: '15m' });
}

function refreshTokenExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d;
}

export function createAuthService(prisma: PrismaClient) {
  const repo = createAuthRepository(prisma);

  return {
    async register(
      email: string,
      password: string,
      name: string,
      userAgent: string
    ): Promise<AuthResult> {
      const existing = await repo.findUserByEmail(email);
      if (existing !== null) {
        throw new ConflictError('Email already registered', { field: 'email' });
      }

      const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
      const user = await repo.createUser({ email, passwordHash, name });

      const accessToken = signAccessToken(user.id, user.email);
      const refreshToken = generateOpaqueToken();

      await repo.createRefreshToken({
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshTokenExpiry(),
        userAgent,
      });

      return { user, accessToken, refreshToken };
    },

    async login(
      email: string,
      password: string,
      userAgent: string
    ): Promise<AuthResult> {
      const user = await repo.findUserByEmail(email);

      // Always run a hash operation to prevent timing-based user enumeration
      if (user === null || !user.isActive) {
        await argon2.hash(password, { type: argon2.argon2id });
        throw new AuthError('Invalid email or password');
      }

      const valid = await argon2.verify(user.passwordHash, password);
      if (!valid) {
        throw new AuthError('Invalid email or password');
      }

      const accessToken = signAccessToken(user.id, user.email);
      const refreshToken = generateOpaqueToken();

      await repo.createRefreshToken({
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshTokenExpiry(),
        userAgent,
      });

      return { user: { id: user.id, email: user.email }, accessToken, refreshToken };
    },

    async refresh(tokenValue: string, userAgent: string): Promise<AuthResult> {
      const stored = await repo.findRefreshToken(hashToken(tokenValue));

      if (
        stored === null ||
        stored.revokedAt !== null ||
        stored.expiresAt < new Date() ||
        !stored.user.isActive
      ) {
        throw new AuthError('Unauthorized');
      }

      // Token rotation: revoke old, issue new pair
      await repo.revokeRefreshToken(hashToken(tokenValue));

      const accessToken = signAccessToken(stored.user.id, stored.user.email);
      const newRefreshToken = generateOpaqueToken();

      await repo.createRefreshToken({
        userId: stored.userId,
        tokenHash: hashToken(newRefreshToken),
        expiresAt: refreshTokenExpiry(),
        userAgent,
      });

      return {
        user: { id: stored.user.id, email: stored.user.email },
        accessToken,
        refreshToken: newRefreshToken,
      };
    },

    async logout(userId: string, tokenValue: string): Promise<void> {
      const stored = await repo.findRefreshToken(hashToken(tokenValue));
      // Silently ignore: token already revoked, expired, or belongs to a different user
      if (stored === null || stored.userId !== userId) {
        return;
      }
      await repo.revokeRefreshToken(hashToken(tokenValue));
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
