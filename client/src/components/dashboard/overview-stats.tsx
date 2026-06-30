import { BarChart3, Link2, MousePointerClick, Zap } from "lucide-react";
import { StatCard } from "@/components/common/stat-card";
import { formatNumber, isExpired } from "@/lib/format";
import type { UrlListItem } from "@/lib/api-types";

export function OverviewStats({ urls }: { urls: UrlListItem[] }) {
  const totalLinks = urls.length;
  const totalClicks = urls.reduce((sum, url) => sum + url.clickCount, 0);
  const activeLinks = urls.filter((url) => !isExpired(url.expiresAt)).length;
  const avgClicks = totalLinks ? Math.round(totalClicks / totalLinks) : 0;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Total links" value={formatNumber(totalLinks)} icon={Link2} />
      <StatCard
        label="Total clicks"
        value={formatNumber(totalClicks)}
        icon={MousePointerClick}
      />
      <StatCard
        label="Active links"
        value={formatNumber(activeLinks)}
        icon={Zap}
        hint={totalLinks - activeLinks > 0 ? `${totalLinks - activeLinks} expired` : "All active"}
      />
      <StatCard
        label="Avg. clicks / link"
        value={formatNumber(avgClicks)}
        icon={BarChart3}
      />
    </div>
  );
}
