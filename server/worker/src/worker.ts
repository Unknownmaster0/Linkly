import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import cron from 'node-cron';
import { CLICK_QUEUE, registerGracefulShutdown } from '@url-shortener/shared';
import type { ClickJob } from '@url-shortener/shared';
import { config } from './config';
import { logger } from './logger';
import { prisma, disconnect } from './db';
import { createClickEventRepository } from './repositories/click-event.repository';
import { createAggregateRepository } from './repositories/aggregate.repository';
import { createUrlRepository } from './repositories/url.repository';
import { createClickProcessor } from './jobs/analytics.job';
import { createAggregationJob } from './jobs/aggregation.job';
import { createExpiryJob } from './jobs/expiry.job';

const clickRepo = createClickEventRepository(prisma);
const aggregateRepo = createAggregateRepository(prisma);
const urlRepo = createUrlRepository(prisma);

// ── Denormalized click_count batch accumulator ──────────────────────────────
// Per section-4/5: accumulate counts in memory and flush as a single batched
// UPDATE on size OR interval — never one UPDATE per click.
let pending = new Map<bigint, number>();
let flushing = false;

function recordClick(urlId: bigint): void {
  pending.set(urlId, (pending.get(urlId) ?? 0) + 1);
  if (pending.size >= config.CLICK_BATCH_SIZE) {
    void flush();
  }
}

async function flush(): Promise<void> {
  if (flushing || pending.size === 0) return;
  flushing = true;
  const batch = pending;
  pending = new Map();
  try {
    await clickRepo.batchIncrementClickCount(batch);
    logger.debug({ urls: batch.size }, 'Flushed click_count batch');
  } catch (err) {
    // Re-queue the counts so they aren't lost on a transient DB error.
    for (const [urlId, delta] of batch) {
      pending.set(urlId, (pending.get(urlId) ?? 0) + delta);
    }
    logger.error({ err }, 'click_count batch flush failed — re-queued');
  } finally {
    flushing = false;
  }
}

const flushTimer = setInterval(() => void flush(), config.CLICK_FLUSH_MS);

// ── BullMQ click worker ─────────────────────────────────────────────────────
const connection = new Redis(config.VALKEY_URL, { maxRetriesPerRequest: null });
connection.on('error', (err: unknown) => logger.warn({ err }, 'Worker Valkey connection error'));

const worker = new Worker<ClickJob>(CLICK_QUEUE, createClickProcessor(clickRepo, recordClick), {
  connection,
  concurrency: config.WORKER_CONCURRENCY,
});

worker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, attempts: job?.attemptsMade, err }, 'Click job failed');
});
worker.on('error', (err) => logger.error({ err }, 'Worker error'));

// ── Nightly aggregation cron (00:15 IST) ────────────────────────────────────
// Buckets clicks by the IST calendar day (DECISIONS.md #12); fires a few minutes
// after IST midnight so the just-closed day is complete before roll-up.
const runDailyAggregation = createAggregationJob(aggregateRepo);
const aggregationTask = cron.schedule('15 0 * * *', () => void runDailyAggregation(), {
  timezone: 'Asia/Kolkata',
});

// ── Nightly expiry cleanup cron (01:00 IST) ─────────────────────────────────
// Eager half of expiry: soft-delete URLs past expires_at so they drop out of
// the hot partial indexes. Lazy expiry at redirect already returns 410 for them.
// Expiry compares instants (expires_at < now), so it's timezone-agnostic — the
// IST timezone here only fixes the wall-clock fire time, after the aggregation.
const runExpiryCleanup = createExpiryJob(urlRepo);
const expiryTask = cron.schedule('0 1 * * *', () => void runExpiryCleanup(), {
  timezone: 'Asia/Kolkata',
});

logger.info(
  { queue: CLICK_QUEUE, concurrency: config.WORKER_CONCURRENCY },
  'Analytics worker started'
);

// ── Graceful shutdown ───────────────────────────────────────────────────────
// The drain order is worker-specific and load-bearing: stop pulling new work
// (cron + flush timer), close the BullMQ worker so in-flight jobs finish, THEN
// do a final flush so no click_count delta is lost, and only then drop the DB
// and Valkey connections. The shared helper supplies the signal wiring,
// idempotency guard, force-exit timeout, and uncaughtException/unhandledRejection
// handlers that the inline version was missing.
registerGracefulShutdown({
  cleanup: async () => {
    aggregationTask.stop();
    expiryTask.stop();
    clearInterval(flushTimer);
    await worker.close();
    await flush(); // persist any remaining click_count deltas
    await disconnect();
    await connection.quit();
  },
  logger,
  timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
});
