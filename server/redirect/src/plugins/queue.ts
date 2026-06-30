import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { CLICK_QUEUE } from '@url-shortener/shared';
import type { ClickJob } from '@url-shortener/shared';
import { config } from '../config';

type QueueClient = {
  /**
   * Enqueue a click event for async analytics processing.
   * Fail-open: a queue/Valkey outage must NEVER break a redirect — failures are
   * caught and logged, never thrown. Callers fire-and-forget (do not await).
   */
  enqueueClick(job: ClickJob): Promise<void>;
};

declare module 'fastify' {
  interface FastifyInstance {
    queue: QueueClient;
  }
}

async function queuePlugin(app: FastifyInstance): Promise<void> {
  // BullMQ requires maxRetriesPerRequest: null on its connection.
  // Dedicated connection — separate from the cache plugin's client.
  const connection = new Redis(config.VALKEY_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: 5000,
  });

  connection.on('error', (err: unknown) => {
    app.log.warn({ err }, 'Queue Valkey connection error');
  });

  const clickQueue = new Queue<ClickJob>(CLICK_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    },
  });

  app.decorate('queue', {
    async enqueueClick(job: ClickJob): Promise<void> {
      try {
        await clickQueue.add('click', job);
      } catch (err) {
        // Fail-open: losing a click event is acceptable; breaking the hot path is not.
        app.log.warn({ err }, 'Failed to enqueue click event');
      }
    },
  });

  app.addHook('onClose', async () => {
    await clickQueue.close().catch((err: unknown) => {
      app.log.warn({ err }, 'Queue close error');
    });
    await connection.quit().catch((err: unknown) => {
      app.log.warn({ err }, 'Queue connection quit error');
    });
    app.log.info('Click queue disconnected');
  });

  app.log.info('Click queue connected');
}

export default fp(queuePlugin, { name: 'queue' });
