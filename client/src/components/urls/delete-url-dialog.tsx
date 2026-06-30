"use client";

import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDeleteUrl } from "@/hooks/use-delete-url";
import { ApiError } from "@/lib/api-client";
import type { UrlListItem } from "@/lib/api-types";

/** Confirmation for a soft-delete. Controlled: a non-null `url` opens it. */
export function DeleteUrlDialog({
  url,
  onOpenChange,
}: {
  url: UrlListItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteUrl = useDeleteUrl();
  const label = url ? (url.customAlias ?? url.shortCode) : "";

  async function handleConfirm() {
    if (!url) return;
    try {
      await deleteUrl.mutateAsync(url.shortCode);
      toast.success("Link deleted");
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof ApiError ? error.message : "Couldn't delete the link",
      );
    }
  }

  return (
    <AlertDialog open={url !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this link?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">/{label}</span> will
            stop redirecting. Its analytics history is preserved, but this
            can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteUrl.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleteUrl.isPending}
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {deleteUrl.isPending && <Loader2 className="size-4 animate-spin" />}
            Delete link
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
