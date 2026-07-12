import fp from 'fastify-plugin';
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

async function PrismaPlugin(app: FastifyInstance) {
  const adapter = new PrismaPg({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });

  const prisma = new PrismaClient({ adapter });

  app.log.info('Database connected');

  app.decorate('prisma', prisma);

  app.addHook('onClose', async () => {
    await prisma.$disconnect();
    app.log.info('Database disconnected');
  });
}

export default fp(PrismaPlugin, { name: 'prisma' });
