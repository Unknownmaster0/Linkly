"use client";

import { useQuery } from "@tanstack/react-query";
import { listUrls } from "@/lib/api/urls";
import { queryKeys } from "@/lib/query-keys";

/** The authenticated user's URLs. */
export function useUrls() {
  return useQuery({
    queryKey: queryKeys.urls,
    queryFn: ({ signal }) => listUrls(signal),
  });
}
