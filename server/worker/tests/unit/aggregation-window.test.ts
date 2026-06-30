import { describe, it, expect, afterEach } from 'vitest';
import { istYesterday } from '../../src/jobs/aggregation.job';

/**
 * Layer 1 — pure date-math, no DB.
 *
 * `istYesterday(now)` returns the YYYY-MM-DD label of the day before the IST
 * calendar day containing `now`. The aggregation job buckets by this IST day;
 * the actual instant boundaries are resolved later in SQL via `AT TIME ZONE`.
 * These tests pin the boundary the SQL depends on: IST midnight is 18:30 UTC of
 * the previous day, and the label is the IST wall-clock date — NOT the UTC date.
 */
describe('istYesterday (IST bucketing)', () => {
  it('returns the IST day before the IST day containing now', () => {
    // 2026-06-16T10:30Z = 16:00 IST Jun 16 → IST yesterday = Jun 15
    expect(istYesterday(new Date('2026-06-16T10:30:00.000Z'))).toBe('2026-06-15');
  });

  it('uses the IST wall-clock day, not the UTC day (the whole point)', () => {
    // 2026-06-16T20:30Z = 02:00 IST Jun 17 → IST yesterday = Jun 16.
    // UTC-based logic would have said Jun 15 — this is the 5.5h correction.
    expect(istYesterday(new Date('2026-06-16T20:30:00.000Z'))).toBe('2026-06-16');
  });

  it('handles the IST-midnight boundary (18:30 UTC = 00:00 IST next day)', () => {
    // 18:29:59Z = 23:59:59 IST Jun 16 → IST yesterday = Jun 15
    expect(istYesterday(new Date('2026-06-16T18:29:59.000Z'))).toBe('2026-06-15');
    // 18:30:00Z = 00:00:00 IST Jun 17 → IST yesterday = Jun 16
    expect(istYesterday(new Date('2026-06-16T18:30:00.000Z'))).toBe('2026-06-16');
  });

  it('is independent of the time-of-day within the same IST day', () => {
    // Both instants fall on IST Jun 16 (05:30 IST and 23:59 IST) → yesterday = Jun 15
    const morning = istYesterday(new Date('2026-06-16T00:00:00.000Z')); // 05:30 IST Jun 16
    const night = istYesterday(new Date('2026-06-16T18:29:00.000Z')); // 23:59 IST Jun 16
    expect(morning).toBe('2026-06-15');
    expect(night).toBe('2026-06-15');
  });

  it('handles a month boundary', () => {
    // 2026-07-01T00:05Z = 05:35 IST Jul 1 → IST yesterday = Jun 30
    expect(istYesterday(new Date('2026-07-01T00:05:00.000Z'))).toBe('2026-06-30');
  });

  it('handles a year boundary', () => {
    // 2026-01-01T05:00Z = 10:30 IST Jan 1 → IST yesterday = Dec 31 2025
    expect(istYesterday(new Date('2026-01-01T05:00:00.000Z'))).toBe('2025-12-31');
  });

  // Determinism guard: the helper uses only getTime()/toISOString() (UTC-based),
  // so its output must not change with the host's local timezone. If someone
  // later swaps in getFullYear()/getMonth() (local), this fails.
  describe('timezone determinism', () => {
    const originalTz = process.env['TZ'];
    afterEach(() => {
      process.env['TZ'] = originalTz;
    });

    it('produces identical results regardless of process.env.TZ', () => {
      const now = new Date('2026-06-16T20:30:00.000Z'); // 02:00 IST Jun 17

      process.env['TZ'] = 'America/New_York'; // UTC-4/5
      const west = istYesterday(now);

      process.env['TZ'] = 'Asia/Kolkata'; // UTC+5:30
      const east = istYesterday(now);

      expect(west).toBe(east);
      expect(west).toBe('2026-06-16');
    });
  });
});
