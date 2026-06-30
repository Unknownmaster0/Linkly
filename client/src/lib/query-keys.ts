/** Centralized TanStack Query keys — one place to invalidate from mutations. */

export const queryKeys = {
  urls: ["urls"] as const,
  analytics: (shortCode: string) => ["analytics", shortCode] as const,
  analyticsEvents: (shortCode: string, limit: number, offset: number) =>
    ["analytics", shortCode, "events", { limit, offset }] as const,
  health: ["health"] as const,
} as const;
