import * as React from "react";
import { formatNumber } from "@/lib/format";

export interface BarListItem {
  /** Stable React key. */
  key: string;
  /** Row label — must handle its own truncation (e.g. a `truncate` span). */
  label: React.ReactNode;
  value: number;
}

/**
 * A compact ranked list where each row is a proportional bar (Plausible-style):
 * the bar width encodes the row's share of the largest value, with the label
 * overlaid on the left and the count on the right. Pure presentational — shared
 * by the referrers and countries analytics cards.
 */
export function BarList({
  items,
  emptyLabel,
}: {
  items: BarListItem[];
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  const max = Math.max(...items.map((item) => item.value), 1);

  return (
    <ul className="space-y-1.5">
      {items.map((item) => {
        // Floor a non-zero share at a sliver so a single click stays visible.
        const pct = item.value === 0 ? 0 : Math.max((item.value / max) * 100, 4);
        return (
          <li
            key={item.key}
            className="relative overflow-hidden rounded-md"
          >
            <div
              className="absolute inset-y-0 left-0 bg-primary/15"
              style={{ width: `${pct}%` }}
              aria-hidden
            />
            <div className="relative flex items-center gap-3 px-2.5 py-2 text-sm">
              <div className="min-w-0 flex-1">{item.label}</div>
              <span className="shrink-0 font-medium tabular-nums">
                {formatNumber(item.value)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
