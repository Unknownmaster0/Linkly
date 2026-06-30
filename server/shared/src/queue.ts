/**
 * Shared BullMQ queue contract.
 *
 * Single source of truth for the click-events queue name and job payload,
 * consumed by both the producer (redirect) and the consumer
 * (worker). Keeping this here prevents the two processes from
 * drifting out of sync on the queue name or payload shape.
 */

/** BullMQ queue name for click analytics events. */
export const CLICK_QUEUE = 'click-events';

/**
 * Payload enqueued (fire-and-forget) by the redirect server on every served
 * redirect and consumed by the analytics worker.
 *
 * Note on `ip`: the RAW client IP is carried so the worker can perform a geo
 * lookup. The worker stores only a hash of it (`ip_hash`) — the raw IP is
 * never persisted or logged.
 */
export type ClickJob = {
  shortCode: string;
  ip: string;
  userAgent?: string;
  referrer?: string;
  /** Click timestamp in epoch milliseconds (Date.now()). */
  ts: number;
};
