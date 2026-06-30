/** Presentation helpers — locale-aware date / number formatting. */

const dateFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact" });
const numberFmt = new Intl.NumberFormat("en-US");

export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return dateTimeFmt.format(new Date(iso));
}

/** "just now", "5m ago", "3h ago", "2d ago", else an absolute date. */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);

  if (abs < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diffSec / 86400), "day");
  return formatDate(iso);
}

export function formatNumber(value: number): string {
  return numberFmt.format(value);
}

/** 1,234 → "1.2K", 1,500,000 → "1.5M" (for stat cards / axes). */
export function formatCompact(value: number): string {
  return compactFmt.format(value);
}

export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
}

/** Human label for a URL's expiry, e.g. "No expiry", "Expired", "Expires Apr 18, 2026". */
export function expiryLabel(expiresAt: string | null): string {
  if (!expiresAt) return "No expiry";
  if (isExpired(expiresAt)) return "Expired";
  return `Expires ${formatDate(expiresAt)}`;
}

/** A short, readable form of a long URL for tables/cards. */
export function prettyUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.hostname}${path}${u.search}`.replace(/^www\./, "");
  } catch {
    return raw;
  }
}