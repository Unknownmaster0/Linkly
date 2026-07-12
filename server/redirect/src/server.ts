import { createApp } from './app.js';
import { config } from './config.js';
import { registerGracefulShutdown } from '@url-shortener/shared';

async function start() {
  try {
    const app = await createApp();
    const host = process.env['REDIRECT_HOST'] ?? '0.0.0.0';

    await app.listen({ port: config.PORT, host });

    // Same drain contract as the api server: app.close() cascades to the cache
    // and queue plugins' onClose hooks. The shared helper supplies the signal
    // wiring, idempotency guard, force-exit timeout, and fatal-error handlers.
    registerGracefulShutdown({
      cleanup: () => app.close(),
      logger: app.log,
      timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    });
  } catch (err) {
    console.error('Failed to start redirect server:', err);
    process.exit(1);
  }
}

start().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
