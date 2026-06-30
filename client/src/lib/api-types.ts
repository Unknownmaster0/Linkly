/**
 * Client-side mirror of the backend's request/response shapes.
 *
 * These are derived 1:1 from the locked contract (docs/notes/API_CONTRACT.md)
 * AND the real server code (server/api/src/schemas/*.ts) — field names and
 * nullability match exactly. Do not hand-edit shapes from memory; if the API
 * changes, update here from the schema.
 */

// ── Envelopes ────────────────────────────────────────────────────────────────

export interface ApiSuccess<T> {
  success: true;
  message: string;
  data: T;
}

/** Error envelope per ERROR_CONTRACT.md — `{ error, details?, retryAfter? }`. */
export interface ApiErrorBody {
  error: string;
  details?: Record<string, unknown>;
  retryAfter?: number;
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
}

export interface AuthData {
  user: AuthUser;
  accessToken: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  confirmPassword: string;
  name?: string;
}

// ── URLs ─────────────────────────────────────────────────────────────────────

/** Response of `POST /api/urls`. */
export interface ShortenResult {
  shortCode: string;
  shortUrl: string;
  originalUrl: string;
  customAlias: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Item of `GET /api/urls`. */
export interface UrlListItem {
  shortCode: string;
  shortUrl: string;
  originalUrl: string;
  customAlias: string | null;
  createdAt: string;
  expiresAt: string | null;
  clickCount: number;
  isDeleted: boolean;
}

export interface UrlListResult {
  urls: UrlListItem[];
  total: number;
}

export interface CreateUrlInput {
  url: string;
  customAlias?: string;
  ttlDays?: number;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface DailyBreakdownItem {
  date: string; // YYYY-MM-DD (IST calendar day — see DECISIONS.md #12)
  clicks: number;
}

export interface ReferrerItem {
  referrer: string; // "direct" when no referrer
  clicks: number;
}

export interface CountryItem {
  countryCode: string;
  countryName: string;
  clicks: number;
}

/** Response `data` of `GET /api/analytics/:shortCode`. */
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

/** Item of `GET /api/analytics/:shortCode/events`. */
export interface AnalyticsEvent {
  id: string;
  clickedAt: string;
  countryCode: string | null;
  city: string | null;
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

// ── Health ───────────────────────────────────────────────────────────────────

/** `GET /health` — intentionally NOT enveloped (probe-friendly flat shape). */
export interface HealthStatus {
  status: string;
  db: string;
  cache: string;
  timestamp: string;
}
