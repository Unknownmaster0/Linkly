import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { config } from './config';

// Plain (non-Fastify) Prisma client for the worker process.
const adapter = new PrismaPg({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: 5000,
});

export const prisma = new PrismaClient({ adapter });

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
