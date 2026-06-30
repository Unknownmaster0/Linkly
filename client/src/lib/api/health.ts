/** Health endpoint (server/api/src/routes/health.ts) — flat, not enveloped. */

import { API_BASE_URL } from "../config";
import type { HealthStatus } from "../api-types";

export async function getHealth(): Promise<HealthStatus> {
  const res = await fetch(`${API_BASE_URL}/health`, {
    credentials: "include",
    cache: "no-store",
  });
  return (await res.json()) as HealthStatus;
}
