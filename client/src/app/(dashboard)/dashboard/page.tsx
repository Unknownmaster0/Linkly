"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useUrls } from "@/hooks/use-urls";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useAuth } from "@/providers/auth-provider";
import { ApiError } from "@/lib/api-client";
import { formatNumber, prettyUrl } from "@/lib/format";
import type { UrlListItem } from "@/lib/api-types";
import { PageHeader } from "@/components/common/page-header";
import { ErrorState } from "@/components/common/error-state";
import { CopyButton } from "@/components/common/copy-button";
import { OverviewStats } from "@/components/dashboard/overview-stats";
import { CreateUrlForm } from "@/components/urls/create-url-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardPage() {
  useDocumentTitle("Dashboard");
  const { user } = useAuth();
  const { data, isLoading, isError, error, refetch } = useUrls();
  const urls = data?.urls ?? [];
  const recent = [...urls]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, 5);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Dashboard"
        description={user ? `Welcome back, ${user.email}` : "Welcome back"}
      />

      {isError ? (
        <ErrorState
          message={
            error instanceof ApiError
              ? error.message
              : "Couldn't load your data."
          }
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          {isLoading ? <StatsSkeleton /> : <OverviewStats urls={urls} />}

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Create a short link</CardTitle>
                <CardDescription>
                  Shorten a URL and start tracking clicks instantly.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CreateUrlForm />
              </CardContent>
            </Card>

            <Card className="lg:col-span-1">
              <CardHeader>
                <CardTitle>Recent links</CardTitle>
                <CardAction>
                  <Button
                    asChild
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                  >
                    <Link href="/links">
                      View all
                      <ArrowRight className="size-3.5" />
                    </Link>
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <RecentSkeleton />
                ) : recent.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No links yet — create your first one.
                  </p>
                ) : (
                  <ul className="divide-y divide-border/60">
                    {recent.map((url) => (
                      <RecentItem key={url.shortCode} url={url} />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function RecentItem({ url }: { url: UrlListItem }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <Link
          href={`/analytics/${url.shortCode}`}
          className="block truncate text-sm font-medium hover:text-primary"
        >
          /{url.customAlias ?? url.shortCode}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {prettyUrl(url.originalUrl)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatNumber(url.clickCount)}
        </span>
        <CopyButton value={url.shortUrl} />
      </div>
    </li>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24 rounded-xl" />
      ))}
    </div>
  );
}

function RecentSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <div className="w-full space-y-1.5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="size-7 rounded-md" />
        </div>
      ))}
    </div>
  );
}
