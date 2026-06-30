/**
 * Manual trigger for the daily aggregation job (Day 15).
 *
 *   npm run job:aggregate              # aggregate yesterday (same as the cron)
 *   npm run job:aggregate -- 2026-06-13  # aggregate a specific IST day (backfill)
 *
 * Runs ONE aggregation pass against the real database (DATABASE_URL), then
 * exits. This is how you verify the job actually writes rows without waiting
 * for 00:15 IST, and how you backfill a night the cron missed.
 *
 * The job rolls up "the IST day before referenceDate". Setting referenceDate to
 * UTC-midnight of D+1 (below) lands on 05:30 IST of D+1, whose IST-yesterday is
 * exactly the target IST day D — so the same +1-day math works for IST buckets.
 */
import { prisma, disconnect } from '../db';
import { logger } from '../logger';
import { createAggregateRepository } from '../repositories/aggregate.repository';
import { createAggregationJob } from './aggregation.job';

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const targetDay = process.argv[2]; // optional YYYY-MM-DD
  let referenceDate: Date;

  if (targetDay !== undefined) {
    const targetMs = Date.parse(`${targetDay}T00:00:00.000Z`);
    if (Number.isNaN(targetMs)) {
      throw new Error(`Invalid date "${targetDay}" — expected YYYY-MM-DD`);
    }
    referenceDate = new Date(targetMs + DAY_MS); // so "yesterday" == targetDay
    logger.info({ targetDay }, 'Manual aggregation for explicit day');
  } else {
    referenceDate = new Date();
    logger.info('Manual aggregation for yesterday (no date arg)');
  }

  const repo = createAggregateRepository(prisma);
  await createAggregationJob(repo)(referenceDate);
}

main()
  .catch((err) => logger.error({ err }, 'Manual aggregation run failed'))
  .finally(async () => {
    await disconnect();
    process.exit(0);
  });
