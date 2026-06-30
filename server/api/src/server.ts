import { createApp } from './app';
import { config } from './config';
import { registerGracefulShutdown } from '@url-shortener/shared';

async function start() {
  try {
    const app = await createApp();
    const port = parseInt(process.env['PORT'] || '3000', 10);
    const host = process.env['API_HOST'] || '0.0.0.0';

    await app.listen({ port, host });

    // Graceful shutdown: app.close() stops accepting new connections, drains
    // in-flight requests, then runs every plugin's onClose hook (Prisma pool,
    // Valkey cache). The shared helper adds the SIGTERM/SIGINT wiring, an
    // idempotency guard, a force-exit timeout, and unhandledRejection /
    // uncaughtException handlers.
    registerGracefulShutdown({
      cleanup: () => app.close(),
      logger: app.log,
      timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
