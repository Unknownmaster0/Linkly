"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  ExternalLink,
  MousePointerClick,
  SearchX,
  TrendingUp,
} from "lucide-react";
import { useAnalyticsSummary } from "@/hooks/use-analytics";
import { useUrls } from "@/hooks/use-urls";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ApiError } from "@/lib/api-client";
import { API_BASE_URL } from "@/lib/config";
import { expiryLabel, formatDate, formatNumber, prettyUrl } from "@/lib/format";
import { PageHeader } from "@/components/common/page-header";
import { EmptyState } from "@/components/common/empty-state";
import { ErrorState } from "@/components/common/error-state";
import { CopyButton } from "@/components/common/copy-button";
import { StatCard } from "@/components/common/stat-card";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DailyClicksChart } from "@/components/analytics/daily-clicks-chart";
import { ReferrersCard } from "@/components/analytics/referrers-card";
import { CountriesCard } from "@/components/analytics/countries-card";
import { EventsTable } from "@/components/analytics/events-table";

export default function AnalyticsPage() {
  const { code } = useParams<{ code: string }>();
  useDocumentTitle(`/${code}`);
  const { data: summary, isLoading, isError, error, refetch } =
    useAnalyticsSummary(code);

  // The summary omits `shortUrl`; pull the real (working) short link from the
  // user's cached link list — it's guaranteed present since the user owns it.
  const { data: urlsData } = useUrls();
  const listItem = urlsData?.urls.find((url) => url.shortCode === code);
  const shortUrl = listItem?.shortUrl ?? `${API_BASE_URL}/${code}`;

  const backLink = (
    <Button
      asChild
      variant="link"
      size="sm"
      className="mb-3 h-auto p-0 text-muted-foreground hover:text-foreground"
    >
      <Link href="/links">
        <ArrowLeft className="size-3.5" />
        Back to links
      </Link>
    </Button>
  );

  if (isError) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div>
        {backLink}
        {notFound ? (
          <EmptyState
            icon={SearchX}
            title="Link not found"
            description="This short link doesn't exist or isn't yours."
            action={
              <Button asChild variant="outline" size="sm">
                <Link href="/links">Go to my links</Link>
              </Button>
            }
          />
        ) : (
          <ErrorState
            message={
              error instanceof ApiError
                ? error.message
                : "Couldn't load analytics for this link."
            }
            onRetry={() => void refetch()}
          />
        )}
      </div>
    );
  }

  if (isLoading || !summary) {
    return (
      <div>
        {backLink}
        <AnalyticsSkeleton />
      </div>
    );
  }

  return (
    <div>
      {backLink}
      <PageHeader
        title={`/${code}`}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={summary.originalUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground"
              title={summary.originalUrl}
            >
              {prettyUrl(summary.originalUrl)}
              <ExternalLink className="size-3" />
            </a>
            <span aria-hidden>·</span>
            <span>Created {formatDate(summary.createdAt)}</span>
            <span aria-hidden>·</span>
            <span>{expiryLabel(summary.expiresAt)}</span>
          </span>
        }
      >
        <CopyButton value={shortUrl} variant="outline" size="sm">
          <span>Copy link</span>
        </CopyButton>
      </PageHeader>

      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label="Total clicks"
            value={formatNumber(summary.totalClicks)}
            icon={MousePointerClick}
          />
          <StatCard
            label="Last 7 days"
            value={formatNumber(summary.last7Days)}
            icon={TrendingUp}
          />
          <StatCard
            label="Last 30 days"
            value={formatNumber(summary.last30Days)}
            icon={CalendarClock}
          />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Clicks over time</CardTitle>
          </CardHeader>
          <CardContent>
            <DailyClicksChart data={summary.dailyBreakdown} />
          </CardContent>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <ReferrersCard referrers={summary.topReferrers} />
          <CountriesCard countries={summary.countries} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent clicks</CardTitle>
          </CardHeader>
          <CardContent>
            <EventsTable shortCode={code} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
