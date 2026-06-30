import { describe, it, expect, vi } from 'vitest';
import { createAggregationJob } from '../../src/jobs/aggregation.job';
import type { AggregateRepository } from '../../src/repositories/aggregate.repository';

/**
 * Layer 2 — job orchestration with a fake repo (no DB).
 *
 * Proves the job (a) computes the IST "yesterday" date and forwards that single
 * date string to the repository, and (b) honours the cron-must-not-crash
 * contract: a repo failure is logged and SWALLOWED, never rethrown (a throw
 * from a cron callback would bubble to the Node process and kill the worker).
 */
describe('createAggregationJob (IST bucketing)', () => {
  it('forwards the IST "yesterday" date to repo.aggregateDay', async () => {
    const aggregateDay = vi.fn<AggregateRepository['aggregateDay']>().mockResolvedValue(3);
    const run = createAggregationJob({ aggregateDay });

    // 2026-06-16T20:30Z = 02:00 IST Jun 17 → IST yesterday = Jun 16
    // (UTC-based logic would have passed '2026-06-15' — guards the correction).
    await run(new Date('2026-06-16T20:30:00.000Z'));

    expect(aggregateDay).toHaveBeenCalledTimes(1);
    expect(aggregateDay).toHaveBeenCalledWith('2026-06-16');
  });

  it('swallows a repository error (cron must never crash the worker)', async () => {
    const aggregateDay = vi
      .fn<AggregateRepository['aggregateDay']>()
      .mockRejectedValue(new Error('boom: transient DB error'));
    const run = createAggregationJob({ aggregateDay });

    await expect(run(new Date('2026-06-16T10:30:00.000Z'))).resolves.toBeUndefined();
    expect(aggregateDay).toHaveBeenCalledOnce();
  });
});
