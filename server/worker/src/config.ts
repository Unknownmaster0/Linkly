import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load this package's own .env by absolute path, so env-loading is independent
// of the directory the process is launched from (e.g. `server/` vs `server/worker/`).
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

import { getCommonConfig } from '@url-shortener/shared';

const common = getCommonConfig();

export const config = {
  ...common,
  // Geo enrichment (ip-api.com) — per-request timeout; failures fall back to null.
  GEO_ENABLED:      (process.env['GEO_ENABLED'] ?? 'true') !== 'false',
  GEO_TIMEOUT_MS:   parseInt(process.env['GEO_TIMEOUT_MS']   ?? '2000', 10),
  // Denormalized click_count batching: flush on size OR interval, whichever first.
  CLICK_BATCH_SIZE: parseInt(process.env['CLICK_BATCH_SIZE'] ?? '100',  10),
  CLICK_FLUSH_MS:   parseInt(process.env['CLICK_FLUSH_MS']   ?? '5000',  10),
  // BullMQ worker concurrency.
  WORKER_CONCURRENCY: parseInt(process.env['WORKER_CONCURRENCY'] ?? '10', 10),
  // Secret mixed into the daily IP-hash salt. Plain SHA-256(ip) is reversible
  // (IPv4 space is tiny); a rotating daily salt makes ip_hash non-reversible
  // while keeping same-IP-same-day hashes stable for unique-visitor counting.
  IP_HASH_SECRET: process.env['IP_HASH_SECRET'] ?? 'dev_ip_hash_secret_change_me',
};
