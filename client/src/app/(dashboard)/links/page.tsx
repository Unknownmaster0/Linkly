"use client";

import { useState } from "react";
import { Link2 } from "lucide-react";
import { useUrls } from "@/hooks/use-urls";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ApiError } from "@/lib/api-client";
import type { UrlListItem } from "@/lib/api-types";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState } from "@/components/common/error-state";
import { EmptyState } from "@/components/common/empty-state";
import { UrlTable } from "@/components/urls/url-table";
import { DeleteUrlDialog } from "@/components/urls/delete-url-dialog";
import { CreateUrlDialog } from "@/components/urls/create-url-dialog";
import { Skeleton } from "@/components/ui/skeleton";

export default function LinksPage() {
  useDocumentTitle("My links");
  const { data, isLoading, isError, error, refetch } = useUrls();
  const [deleteTarget, setDeleteTarget] = useState<UrlListItem | null>(null);
  const urls = data?.urls ?? [];
  console.log(urls);
  return (
    <div>
      <PageHeader
        title="My links"
        description="Create, manage, and track your short links."
      >
        <CreateUrlDialog />
      </PageHeader>

      {isError ? (
        <ErrorState
          message={
            error instanceof ApiError
              ? error.message
              : "Couldn't load your links."
          }
          onRetry={() => void refetch()}
        />
      ) : isLoading ? (
        <TableSkeleton />
      ) : urls.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="No links yet"
          description="Create your first short link to start sharing and tracking clicks."
          action={<CreateUrlDialog />}
        />
      ) : (
        <>
          <UrlTable urls={urls} onDelete={setDeleteTarget} />
          <p className="mt-3 text-xs text-muted-foreground">
            {urls.length} link{urls.length === 1 ? "" : "s"} total
          </p>
        </>
      )}

      <DeleteUrlDialog
        url={deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/10">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <div className="w-full space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-4 w-10" />
          <Skeleton className="size-7 rounded-md" />
        </div>
      ))}
    </div>
  );
}
