import { z } from 'zod';
import { config } from '../config';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const RESERVED_ALIASES = new Set(['api', 'health', 'docs', 'admin', 'static']);

// ─────────────────────────────────────────────────────────────────────────────
// SSRF guard — blocks loopback, link-local, and RFC-1918 private ranges
// ─────────────────────────────────────────────────────────────────────────────

function isPrivateOrLocal(hostname: string): boolean {
  // Strip IPv6 brackets: [::1] → ::1
  const host =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname.toLowerCase();

  // Localhost names
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // IPv4 private / reserved ranges
  const parts = host.split('.');
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const nums = parts.map(Number);
    const a = nums[0] ?? 0;
    const b = nums[1] ?? 0;
    if (
      a === 0 ||                             // 0.0.0.0/8
      a === 10 ||                            // 10.0.0.0/8  (RFC-1918)
      a === 127 ||                           // 127.0.0.0/8 (loopback)
      (a === 169 && b === 254) ||            // 169.254.0.0/16 (link-local)
      (a === 172 && b >= 16 && b <= 31) ||   // 172.16.0.0/12 (RFC-1918)
      (a === 192 && b === 168) ||            // 192.168.0.0/16 (RFC-1918)
      a === 255                              // broadcast
    ) return true;
  }

  // IPv6 loopback and private ranges
  if (host === '::1' || host === '::') return true;       // loopback / unspecified
  if (host.startsWith('fe80:')) return true;              // link-local fe80::/10
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique-local fc00::/7

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request schemas
// ─────────────────────────────────────────────────────────────────────────────

export const shortenBodySchema = z.object({
  url: z
    .string()
    .min(1, 'URL is required')
    .max(2048, 'URL must not exceed 2048 characters')
    .refine(
      (val) => {
        try {
          const parsed = new URL(val);
          return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'URL must be a valid http or https URI' }
    )
    .refine(
      (val) => {
        try {
          const { hostname } = new URL(val);
          return !isPrivateOrLocal(hostname);
        } catch {
          return true; // structural invalidity already caught above
        }
      },
      { message: 'URL must not point to a local or private network address' }
    ),

  customAlias: z
    .string()
    .min(3, 'Alias must be at least 3 characters')
    .max(50, 'Alias must not exceed 50 characters')
    .regex(/^[a-zA-Z0-9-]+$/, 'Alias must be alphanumeric + hyphen only')
    .refine(
      (val) => !RESERVED_ALIASES.has(val.toLowerCase()),
      { message: 'Alias is reserved' }
    )
    .optional(),

  ttlDays: z
    .number({ error: 'TTL must be a number' })
    .int('TTL must be a whole number')
    .min(1, 'TTL must be at least 1 day')
    .max(365, 'TTL must not exceed 365 days')
    .optional(),
}).transform((data) => {
  const days = data.ttlDays ?? config.DEFAULT_URL_TTL_DAYS;
  return {
    originalUrl: data.url,
    customAlias: data.customAlias,
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
  };
});

export type CreateUrlCommand = z.infer<typeof shortenBodySchema>;
export type ShortenBodyInput = z.input<typeof shortenBodySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Response shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ShortenResult {
  shortCode: string;
  shortUrl: string;
  originalUrl: string;
  customAlias: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface UrlListItem {
  shortCode: string;
  shortUrl: string;
  originalUrl: string;
  customAlias: string | null;
  createdAt: string;
  expiresAt: string | null;
  clickCount: number;
  isDeleted: boolean;
}

export interface UrlListResult {
  urls: UrlListItem[];
  total: number;
}
