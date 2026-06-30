/** URL management endpoints (server/api/src/routes/url.ts). */

import { apiFetch } from "../api-client";
import type { CreateUrlInput, ShortenResult, UrlListResult } from "../api-types";

/** `GET /api/urls` — the caller's URLs (server scopes by the authed user). */
export function listUrls(signal?: AbortSignal): Promise<UrlListResult> {
  return apiFetch<UrlListResult>("/api/urls", { signal });
}

/** `POST /api/urls` — create a short URL (rate limited per user). */
export function createUrl(input: CreateUrlInput): Promise<ShortenResult> {
  return apiFetch<ShortenResult>("/api/urls", { method: "POST", body: input });
}

/** `DELETE /api/urls/:shortCode` — soft delete (404 if missing or not owned). */
export function deleteUrl(shortCode: string): Promise<void> {
  return apiFetch<void>(`/api/urls/${encodeURIComponent(shortCode)}`, {
    method: "DELETE",
  });
}
