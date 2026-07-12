import { createHash } from 'node:crypto';
import { UAParser } from 'ua-parser-js';
import type { Job } from 'bullmq';
import type { ClickJob } from '@url-shortener/shared';
import type { DeviceType } from '../generated/prisma/enums.js';
import type { ClickEventRepository } from '../repositories/click-event.repository.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

type Geo = { countryCode: string | null; city: string | null };
type Ua = { deviceType: DeviceType; browser: string | null; os: string | null };

/** IST is a fixed +05:30 offset (no DST), so a constant shift is exact. */
const IST_OFFSET_MS = 19_800_000; // 5.5h

/**
 * SHA-256 of the raw IP with a rotating daily salt (IST date + secret).
 * Non-reversible (unlike plain SHA-256 of a 32-bit IPv4), yet stable within an
 * IST day so the aggregation job — which buckets by the IST calendar day — can
 * count unique visitors via DISTINCT ip_hash. The salt MUST rotate on the same
 * IST boundary as the bucket, or a visitor straddling IST midnight would be
 * counted twice. The raw IP is never stored or logged.
 */
function hashIp(ip: string): string {
  const day = new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10); // YYYY-MM-DD (IST)
  return createHash('sha256').update(`${ip}:${day}:${config.IP_HASH_SECRET}`).digest('hex');
}

/** Extract the referrer hostname. Returns null for missing/invalid referrers
 *  ('direct' is applied at read/aggregation time, not stored). */
function parseReferrerDomain(referrer: string | undefined): string | null {
  if (referrer === undefined || referrer.length === 0) return null;
  try {
    return new URL(referrer).hostname.slice(0, 255);
  } catch {
    return null;
  }
}

const BOT_RE = /bot|crawler|spider|crawling/i;

function parseUserAgent(userAgent: string | undefined): Ua {
  if (userAgent === undefined || userAgent.length === 0) {
    return { deviceType: 'unknown', browser: null, os: null };
  }
  const r = new UAParser(userAgent).getResult();
  let deviceType: DeviceType;
  if (BOT_RE.test(userAgent)) {
    deviceType = 'bot';
  } else if (r.device.type === 'mobile') {
    deviceType = 'mobile';
  } else if (r.device.type === 'tablet') {
    deviceType = 'tablet';
  } else if (r.device.type === undefined) {
    deviceType = 'desktop';
  } else {
    deviceType = 'unknown';
  }
  return {
    deviceType,
    browser: r.browser.name ?? null,
    os: r.os.name ?? null,
  };
}

/**
 * Best-effort geo enrichment via ip-api.com. NEVER throws — any failure
 * (timeout, network, rate limit, reserved IP) falls back to nulls so the click
 * is still recorded. Logged at debug: expected transient behaviour, not alarming.
 */
async function lookupGeo(ip: string): Promise<Geo> {
  if (!config.GEO_ENABLED) return { countryCode: null, city: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.GEO_TIMEOUT_MS);
  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode,city`,
      { signal: controller.signal }
    );
    const body = (await res.json()) as { status?: string; countryCode?: string; city?: string };
    logger.debug({ ip, body }, 'Geo lookup result from ip-api.com');
    if (body.status !== 'success') return { countryCode: null, city: null };
    return {
      countryCode: body.countryCode ?? null,
      city: body.city ?? null,
    };
  } catch (err) {
    logger.debug({ err }, 'Geo lookup failed — storing click without geo');
    return { countryCode: null, city: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Marker for Prisma known-request errors we can classify by code. */
function prismaCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Build the BullMQ processor for click jobs. `recordClick` feeds the batch
 * counter accumulator (denormalized urls.click_count, flushed elsewhere).
 *
 * Error policy (exception-handling-strategy.md):
 *   - Unknown/deleted URL  → discard (return, no retry), WARN
 *   - P2003 FK at insert   → discard (return, no retry), WARN
 *   - Infra errors (P1001/P1017/conn) → rethrow → BullMQ retries with backoff
 */
export function createClickProcessor(
  repo: ClickEventRepository,
  recordClick: (urlId: bigint) => void
) {
  return async function process(job: Job<ClickJob>): Promise<void> {
    const { shortCode, ip, userAgent, referrer } = job.data;

    const urlId = await repo.resolveUrlId(shortCode);
    if (urlId === null) {
      logger.warn({ shortCode }, 'Click for unknown/deleted URL — discarding');
      return;
    }

    const geo = await lookupGeo(ip);
    const ua = parseUserAgent(userAgent);

    // want to log the geo and ua object properties, to see in the console for debugging purposes.
    logger.debug({ shortCode, geo, ua }, 'Recording click with geo and user agent info');

    try {
      await repo.insertClick({
        urlId,
        ipHash: hashIp(ip),
        countryCode: geo.countryCode,
        city: geo.city,
        deviceType: ua.deviceType,
        browser: ua.browser,
        os: ua.os,
        referrerDomain: parseReferrerDomain(referrer),
      });
    } catch (err) {
      // URL row vanished between resolve and insert — expected race, not a bug.
      if (prismaCode(err) === 'P2003') {
        logger.warn({ shortCode, urlId: urlId.toString() }, 'URL FK gone at insert — discarding');
        return;
      }
      throw err; // infra error → let BullMQ retry
    }

    recordClick(urlId);
  };
}
