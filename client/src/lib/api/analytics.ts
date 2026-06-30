/** Analytics endpoints (server/api/src/routes/analytics.ts). */

import { apiFetch } from "../api-client";
import type { AnalyticsEventsResult, AnalyticsSummary } from "../api-types";

/** `GET /api/analytics/:shortCode` — aggregated summary (owner only → 404 else). */
export function getAnalyticsSummary(
  shortCode: string,
  signal?: AbortSignal,
): Promise<AnalyticsSummary> {
  return apiFetch<AnalyticsSummary>(
    `/api/analytics/${encodeURIComponent(shortCode)}`,
    { signal },
  );
}

/** `GET /api/analytics/:shortCode/events?limit=&offset=` — paginated raw clicks. */
export function getAnalyticsEvents(
  shortCode: string,
  params: { limit: number; offset: number },
  signal?: AbortSignal,
): Promise<AnalyticsEventsResult> {
  const qs = new URLSearchParams({
    limit: String(params.limit),
    offset: String(params.offset),
  });
  return apiFetch<AnalyticsEventsResult>(
    `/api/analytics/${encodeURIComponent(shortCode)}/events?${qs.toString()}`,
    { signal },
  );
}
