// ── Process-level graceful shutdown ─────────────────────────────────────────
// One implementation shared by every long-running process (the api + redirect
// Fastify servers and the BullMQ worker). The section-7 plan sketched this
// per-service with inline `process.on('SIGTERM', ...)` blocks; centralising it
// here guarantees all three processes drain identically and removes the copy-paste
// drift that bit the original servers (no timeout backstop, no fatal handlers).
//
// What every process needs, regardless of what it is shutting down:
//   1. Catch SIGTERM (orchestrator/PM2 termination) and SIGINT (Ctrl-C in dev).
//   2. Idempotency — a second signal mid-drain is ignored, not raced.
//   3. Timeout safety — if cleanup hangs, force-exit before the orchestrator's
//      own SIGKILL window closes, so a stuck pool can never wedge the pod.
//   4. Fatal handlers — unhandledRejection / uncaughtException are logged loudly
//      and drive the same drain with a non-zero exit so the supervisor restarts
//      a clean instance (per exception-handling-strategy.md: "log full error,
//      exit cleanly, PM2 restarts").
//
// The ONLY per-process difference is `cleanup`: a Fastify server passes
// `() => app.close()` (which cascades to every plugin's onClose hook — Prisma,
// cache, queue), while the worker passes its own ordered teardown.

// Minimal logger contract satisfied by both Fastify's `app.log` and a bare pino
// instance — `(mergeObject, message)`. Avoids depending on the pino type here.
export interface ShutdownLogger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface GracefulShutdownOptions {
  /** Drains/closes everything this process owns. Must resolve when done. */
  cleanup: () => Promise<void>;
  /** Where lifecycle events are logged (Fastify `app.log` or a pino instance). */
  logger: ShutdownLogger;
  /** Force-exit ceiling in ms if `cleanup` hangs. Default 30 000. */
  timeoutMs?: number;
}

/**
 * Wire SIGTERM/SIGINT + fatal-error handlers to a single drain routine.
 * Call once, after the server is listening (or the worker is constructed).
 */
export function registerGracefulShutdown(options: GracefulShutdownOptions): void {
  const { cleanup, logger, timeoutMs = 30_000 } = options;

  // Idempotency guard — without it, two fast SIGTERMs (or a signal arriving while
  // a fatal handler is already draining) would run cleanup twice and race the
  // exit. The first trigger wins; the rest are logged and dropped.
  let shuttingDown = false;

  async function drain(trigger: string, exitCode: number): Promise<void> {
    if (shuttingDown) {
      logger.info({ trigger }, 'Shutdown already in progress — ignoring');
      return;
    }
    shuttingDown = true;
    logger.info({ trigger }, 'Graceful shutdown started');

    // Backstop: if cleanup() never resolves (a stuck DB pool, an undrained
    // socket), force a hard exit so we never hang past the orchestrator's kill
    // window. unref() so this timer itself never keeps the event loop alive once
    // cleanup has finished.
    const killTimer = setTimeout(() => {
      logger.error({ timeoutMs }, 'Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, timeoutMs);
    killTimer.unref();

    try {
      await cleanup();
      clearTimeout(killTimer);
      logger.info({ trigger }, 'Graceful shutdown complete');
      process.exit(exitCode);
    } catch (err) {
      clearTimeout(killTimer);
      logger.error({ err, trigger }, 'Error during graceful shutdown');
      process.exit(1);
    }
  }

  // Signals are a clean, expected exit → code 0.
  process.on('SIGTERM', () => void drain('SIGTERM', 0));
  process.on('SIGINT', () => void drain('SIGINT', 0));

  // A rejected promise or thrown error that escaped every other handler leaves
  // the process in an undefined state. Log it, then drain with a non-zero exit so
  // the supervisor (PM2 / k8s) replaces this instance rather than leaving it
  // running in a half-broken state.
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection — shutting down');
    void drain('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception — shutting down');
    void drain('uncaughtException', 1);
  });
}
