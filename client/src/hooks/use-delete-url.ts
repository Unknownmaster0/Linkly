"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteUrl } from "@/lib/api/urls";
import { queryKeys } from "@/lib/query-keys";

/** Soft-delete a short URL, then refresh the list. */
export function useDeleteUrl() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (shortCode) => deleteUrl(shortCode),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.urls });
    },
  });
}
