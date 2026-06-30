"use client";

import { useQuery } from "@tanstack/react-query";
import { getAnalyticsSummary } from "@/lib/api/analytics";
import { ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

const TERMINAL_STATUSES = new Set([401, 403, 404, 410]);

/** Aggregated analytics summary for one short code. */
export function useAnalyticsSummary(shortCode: string) {
  return useQuery({
    queryKey: queryKeys.analytics(shortCode),
    queryFn: ({ signal }) => getAnalyticsSummary(shortCode, signal),
    enabled: shortCode.length > 0,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && TERMINAL_STATUSES.has(error.status)) {
        return false;
      }
      return failureCount < 2;
    },
  });
}
