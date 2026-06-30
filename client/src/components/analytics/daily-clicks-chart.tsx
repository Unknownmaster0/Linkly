"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import type { DailyBreakdownItem } from "@/lib/api-types";

const config = {
  clicks: { label: "Clicks", color: "var(--chart-1)" },
} satisfies ChartConfig;

/**
 * Clicks-per-day area chart. The API returns `dailyBreakdown` newest-first, so
 * we reverse to ascending for a left-to-right timeline. Colors come from the
 * chart tokens in globals.css (ChartStyle injects `--color-clicks`).
 */
export function DailyClicksChart({ data }: { data: DailyBreakdownItem[] }) {
  const series = [...data].reverse();

  if (series.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        No clicks yet.
      </p>
    );
  }

  return (
    <ChartContainer config={config} className="aspect-[16/6] w-full">
      <AreaChart data={series} margin={{ left: 0, right: 8, top: 8 }}>
        <defs>
          <linearGradient id="fillClicks" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="5%"
              stopColor="var(--color-clicks)"
              stopOpacity={0.4}
            />
            <stop
              offset="95%"
              stopColor="var(--color-clicks)"
              stopOpacity={0.05}
            />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
          tickFormatter={(value: string) =>
            new Date(value).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })
          }
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={32}
          allowDecimals={false}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(value) =>
                new Date(value as string).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })
              }
            />
          }
        />
        <Area
          dataKey="clicks"
          type="monotone"
          stroke="var(--color-clicks)"
          fill="url(#fillClicks)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}
