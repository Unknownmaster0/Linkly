import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Load this package's own .env by absolute path, so env-loading is independent
// of the directory the process is launched from (e.g. `server/` vs `server/api/`).
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env') });

import { getCommonConfig } from '@url-shortener/shared';

const common = getCommonConfig();

export const config = {
  ...common,
  JWT_SECRET:              process.env['JWT_SECRET']              ?? 'default_jwt_secret',
  JWT_REFRESH_SECRET:      process.env['JWT_REFRESH_SECRET']      ?? 'default_jwt_refresh_secret',
  BASE_URL:                process.env['BASE_URL']                ?? 'http://localhost:3000',
  REDIRECT_URL:            process.env['REDIRECT_URL']            ?? 'http://localhost:3001',
  // Comma-separated allow-list of browser origins permitted by CORS. Never '*'
  // because the API sends credentials (httpOnly refresh cookie + Authorization).
  CLIENT_ORIGINS:          (process.env['CLIENT_ORIGINS']         ?? 'http://localhost:3002')
                             .split(',')
                             .map((o) => o.trim())
                             .filter((o) => o.length > 0),
  PORT:                    parseInt(process.env['PORT']           ?? '3000', 10),
  DEFAULT_URL_TTL_DAYS:    parseInt(process.env['DEFAULT_URL_TTL_DAYS'] ?? '7', 10),
  RATE_LIMIT_CREATE_LIMIT: parseInt(process.env['RATE_LIMIT_CREATE_LIMIT'] ?? '10', 10),
  RATE_LIMIT_WINDOW_SECS:  parseInt(process.env['RATE_LIMIT_WINDOW_SECS']  ?? '60',  10),
};
