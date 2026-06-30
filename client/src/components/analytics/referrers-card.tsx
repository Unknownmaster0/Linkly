import { Share2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BarList, type BarListItem } from "@/components/analytics/bar-list";
import type { ReferrerItem } from "@/lib/api-types";

export function ReferrersCard({ referrers }: { referrers: ReferrerItem[] }) {
  const items: BarListItem[] = referrers.map((item) => ({
    key: item.referrer,
    label: (
      <span className="block truncate">
        {item.referrer === "direct" ? "Direct" : item.referrer}
      </span>
    ),
    value: item.clicks,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Share2 className="size-4 text-muted-foreground" />
          Top referrers
        </CardTitle>
      </CardHeader>
      <CardContent>
        <BarList items={items} emptyLabel="No referrer data yet." />
      </CardContent>
    </Card>
  );
}
