import { Globe } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { BarList, type BarListItem } from "@/components/analytics/bar-list";
import type { CountryItem } from "@/lib/api-types";

/** Two-letter ISO country code → flag emoji (regional indicator symbols). */
function flagEmoji(code: string): string {
  if (!/^[a-zA-Z]{2}$/.test(code)) return "";
  const codePoints = code
    .toUpperCase()
    .split("")
    .map((char) => 0x1f1e6 + (char.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

export function CountriesCard({ countries }: { countries: CountryItem[] }) {
  const items: BarListItem[] = countries.map((item, index) => {
    const name = item.countryName || item.countryCode;
    const flag = flagEmoji(item.countryCode);
    return {
      key: item.countryCode || name || String(index),
      label: (
        <span className="flex items-center gap-2">
          {flag ? (
            <span aria-hidden className="shrink-0">
              {flag}
            </span>
          ) : null}
          <span className="truncate">{name}</span>
        </span>
      ),
      value: item.clicks,
    };
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-4 text-muted-foreground" />
          Top countries
        </CardTitle>
      </CardHeader>
      <CardContent>
        <BarList items={items} emptyLabel="No location data yet." />
      </CardContent>
    </Card>
  );
}
