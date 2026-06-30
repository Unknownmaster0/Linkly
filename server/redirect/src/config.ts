import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load this package's own .env by absolute path, so env-loading is independent
// of the directory the process is launched from (e.g. `server/` vs `server/redirect/`).
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

import { getCommonConfig } from '@url-shortener/shared';

const common = getCommonConfig();

export const config = {
  ...common,
  PORT:                      parseInt(process.env['PORT']                      ?? '3001', 10),
  RATE_LIMIT_REDIRECT_LIMIT: parseInt(process.env['RATE_LIMIT_REDIRECT_LIMIT'] ?? '100',  10),
  RATE_LIMIT_WINDOW_SECS:    parseInt(process.env['RATE_LIMIT_WINDOW_SECS']    ?? '60',   10),
};
