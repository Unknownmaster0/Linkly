/**
 * Manual trigger for the expiry-sweep job (Day 15).
 *
 *   npm run job:expire                       # sweep as of now
 *   npm run job:expire -- 2026-06-16T00:00:00Z  # sweep as of an explicit instant
 *
 * Runs ONE soft-delete sweep against the real database (DATABASE_URL), then
 * exits. Lets you confirm the job flips is_deleted on expired rows on demand,
 * without waiting for 01:00.
 */
import { prisma, disconnect } from '../db.js';
import { logger } from '../logger.js';
import { createUrlRepository } from '../repositories/url.repository.js';
import { createExpiryJob } from './expiry.job.js';

async function main(): Promise<void> {
  const asOf = process.argv[2]; // optional ISO instant
  let referenceDate: Date;

  if (asOf !== undefined) {
    const ms = Date.parse(asOf);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid instant "${asOf}" — expected an ISO date-time`);
    }
    referenceDate = new Date(ms);
    logger.info({ asOf }, 'Manual expiry sweep as of explicit instant');
  } else {
    referenceDate = new Date();
    logger.info('Manual expiry sweep as of now');
  }

  const repo = createUrlRepository(prisma);
  await createExpiryJob(repo)(referenceDate);
}

main()
  .catch((err) => logger.error({ err }, 'Manual expiry run failed'))
  .finally(async () => {
    await disconnect();
    process.exit(0);
  });
