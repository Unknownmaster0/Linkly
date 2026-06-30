import { describe, it, expect, vi } from 'vitest';
import { createExpiryJob } from '../../src/jobs/expiry.job';
import type { UrlRepository } from '../../src/repositories/url.repository';

/**
 * Layer 2 — expiry job orchestration with a fake repo (no DB).
 *
 * Proves the job forwards its reference instant to softDeleteExpired and, like
 * the aggregation job, swallows a repository error so a transient DB failure
 * during the nightly sweep can never crash the long-running worker.
 */
describe('createExpiryJob (UTC baseline)', () => {
  it('passes the reference date through to repo.softDeleteExpired', async () => {
    const softDeleteExpired = vi
      .fn<UrlRepository['softDeleteExpired']>()
      .mockResolvedValue(2);
    const run = createExpiryJob({ softDeleteExpired });

    const ref = new Date('2026-06-16T01:00:00.000Z');
    await run(ref);

    expect(softDeleteExpired).toHaveBeenCalledOnce();
    expect(softDeleteExpired).toHaveBeenCalledWith(ref);
  });

  it('swallows a repository error (cron must never crash the worker)', async () => {
    const softDeleteExpired = vi
      .fn<UrlRepository['softDeleteExpired']>()
      .mockRejectedValue(new Error('boom: transient DB error'));
    const run = createExpiryJob({ softDeleteExpired });

    await expect(run(new Date('2026-06-16T01:00:00.000Z'))).resolves.toBeUndefined();
    expect(softDeleteExpired).toHaveBeenCalledOnce();
  });
});
