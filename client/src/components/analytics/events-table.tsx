"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, MousePointerClick } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { useAnalyticsEvents } from "@/hooks/use-analytics-events";
import { ApiError } from "@/lib/api-client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const LIMIT = 10;

export function EventsTable({ shortCode }: { shortCode: string }) {
  const [offset, setOffset] = useState(0);
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
    isPlaceholderData,
  } = useAnalyticsEvents(shortCode, LIMIT, offset);

  if (isError) {
    return (
      <ErrorState
        message={
          error instanceof ApiError
            ? error.message
            : "Couldn't load click events."
        }
        onRetry={() => void refetch()}
      />
    );
  }

  if (isLoading) {
    return <EventsSkeleton />;
  }

  const events = data?.events ?? [];
  const total = data?.total ?? 0;

  if (total === 0) {
    return (
      <EmptyState
        icon={MousePointerClick}
        title="No clicks yet"
        description="Once this link is clicked, individual events will show up here."
      />
    );
  }

  const start = offset + 1;
  const end = Math.min(offset + LIMIT, total);
  const canPrev = offset > 0;
  const canNext = offset + LIMIT < total;
  const paging = isFetching && isPlaceholderData;

  return (
    <div className="space-y-3">
      <div
        className={cn(
          "overflow-hidden rounded-xl border bg-card ring-1 ring-foreground/10 transition-opacity",
          paging && "opacity-60",
        )}
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead className="hidden sm:table-cell">Country</TableHead>
              <TableHead>Device</TableHead>
              <TableHead className="hidden md:table-cell">Browser</TableHead>
              <TableHead className="hidden lg:table-cell">OS</TableHead>
              <TableHead className="hidden sm:table-cell">Referrer</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => {
              const referrer = event.referrerDomain ?? "Direct";
              return (
                <TableRow key={event.id}>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(event.clickedAt)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {event.countryCode ?? "—"}
                  </TableCell>
                  <TableCell className="capitalize">
                    {event.deviceType}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    {event.browser ?? "—"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {event.os ?? "—"}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span
                      className="block max-w-[12rem] truncate"
                      title={referrer}
                    >
                      {referrer}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs tabular-nums text-muted-foreground">
          Showing {start}–{end} of {formatNumber(total)}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!canPrev || isFetching}
            onClick={() => setOffset((current) => Math.max(current - LIMIT, 0))}
          >
            <ChevronLeft />
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canNext || isFetching}
            onClick={() => setOffset((current) => current + LIMIT)}
          >
            Next
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

function EventsSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 ring-1 ring-foreground/10">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="hidden h-4 w-14 sm:block" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="ml-auto h-4 w-24" />
        </div>
      ))}
    </div>
  );
}
