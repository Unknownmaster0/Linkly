import { describe, it, expect } from 'vitest';
import { parseExpression } from 'cron-parser';

/**
 * Layer 5 — schedule mapping (no DB, no waiting for midnight).
 *
 * These assert that the cron EXPRESSIONS + timezone actually fire at the
 * intended wall-clock time. This is the test that proves the timezone is set
 * correctly — i.e. the exact concern behind the UTC-vs-IST question. It does
 * NOT prove node-cron invokes the callback on the running box (that's 3b —
 * verified operationally via logs + the manual-trigger CLIs).
 *
 * IST (Step 2): the crons in worker.ts run on Asia/Kolkata:
 *   aggregation '15 0 * * *' → 00:15 IST = 18:45 UTC (prev day)
 *   expiry      '0 1 * * *'  → 01:00 IST = 19:30 UTC (prev day)
 * Expiry still fires after aggregation, on the IST wall clock.
 */

const AGGREGATION_CRON = '15 0 * * *';
const EXPIRY_CRON = '0 1 * * *';
const SCHEDULE_TZ = 'Asia/Kolkata';

/** HH:mm of an instant as seen on the wall clock in `timeZone`. */
function wallClock(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === 'hour')!.value;
  const minute = parts.find((p) => p.type === 'minute')!.value;
  return `${hour}:${minute}`;
}

function nextFire(expression: string, after: Date): Date {
  return parseExpression(expression, { currentDate: after, tz: SCHEDULE_TZ }).next().toDate();
}

describe('cron schedules (IST)', () => {
  // Just after IST midnight (18:30 UTC = 00:00 IST Jun 17), so .next() returns
  // the same IST day's run.
  const justAfterMidnightIst = new Date('2026-06-16T18:30:00.000Z');

  describe('analytics aggregation', () => {
    it('fires at 00:15 IST', () => {
      const next = nextFire(AGGREGATION_CRON, justAfterMidnightIst);
      expect(wallClock(next, 'Asia/Kolkata')).toBe('00:15');
    });

    it('= 18:45 UTC (prev day) as an absolute instant', () => {
      const next = nextFire(AGGREGATION_CRON, justAfterMidnightIst);
      expect(next.toISOString()).toBe('2026-06-16T18:45:00.000Z');
    });
  });

  describe('expiry sweep', () => {
    it('fires at 01:00 IST, after the aggregation run', () => {
      const next = nextFire(EXPIRY_CRON, justAfterMidnightIst);
      expect(wallClock(next, 'Asia/Kolkata')).toBe('01:00');
      // ordering invariant: expiry must run after aggregation (worker.ts comment)
      const aggregation = nextFire(AGGREGATION_CRON, justAfterMidnightIst);
      expect(next.getTime()).toBeGreaterThan(aggregation.getTime());
    });

    it('= 19:30 UTC (prev day) as an absolute instant', () => {
      const next = nextFire(EXPIRY_CRON, justAfterMidnightIst);
      expect(next.toISOString()).toBe('2026-06-16T19:30:00.000Z');
    });
  });
});
