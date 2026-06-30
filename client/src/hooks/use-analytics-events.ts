"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getAnalyticsEvents } from "@/lib/api/analytics";
import { ApiError } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";

const TERMINAL_STATUSES = new Set([401, 403, 404, 410]);

/** Paginated raw click events for one short code. */
export function useAnalyticsEvents(
  shortCode: string,
  limit: number,
  offset: number,
) {
  return useQuery({
    queryKey: queryKeys.analyticsEvents(shortCode, limit, offset),
    queryFn: ({ signal }) =>
      getAnalyticsEvents(shortCode, { limit, offset }, signal),
    enabled: shortCode.length > 0,
    placeholderData: keepPreviousData,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && TERMINAL_STATUSES.has(error.status)) {
        return false;
      }
      return failureCount < 2;
    },
  });
}
