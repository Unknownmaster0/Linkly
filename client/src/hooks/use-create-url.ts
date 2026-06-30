"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createUrl } from "@/lib/api/urls";
import { queryKeys } from "@/lib/query-keys";
import type { CreateUrlInput, ShortenResult } from "@/lib/api-types";

/** Create a short URL, then refresh the list. */
export function useCreateUrl() {
  const queryClient = useQueryClient();
  return useMutation<ShortenResult, Error, CreateUrlInput>({
    mutationFn: (input) => createUrl(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.urls });
    },
  });
}
