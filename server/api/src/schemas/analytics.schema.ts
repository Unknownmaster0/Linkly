import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Request schema — events pagination query (?limit=&offset=)
// ─────────────────────────────────────────────────────────────────────────────

export const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type EventsQueryInput = z.input<typeof eventsQuerySchema>;
export type EventsQuery = z.infer<typeof eventsQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyBreakdownItem {
  date: string; // YYYY-MM-DD
  clicks: number;
}

export interface ReferrerItem {
  referrer: string; // 'direct' when no referrer
  clicks: number;
}

export interface CountryItem {
  countryCode: string;
  countryName: string;
  clicks: number;
}

/** Exact locked API_CONTRACT.md §Analytics summary shape. */
export interface AnalyticsSummary {
  shortCode: string;
  originalUrl: string;
  createdAt: string;
  expiresAt: string | null;
  totalClicks: number;
  last7Days: number;
  last30Days: number;
  dailyBreakdown: DailyBreakdownItem[];
  topReferrers: ReferrerItem[];
  countries: CountryItem[];
}

export interface AnalyticsEvent {
  id: string;
  clickedAt: string;
  countryCode: string | null;
  deviceType: string;
  browser: string | null;
  os: string | null;
  referrerDomain: string | null;
}

export interface AnalyticsEventsResult {
  events: AnalyticsEvent[];
  total: number;
  limit: number;
  offset: number;
}
