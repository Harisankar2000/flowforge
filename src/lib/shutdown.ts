import type { Logger } from './logger.js';

export type ShutdownHandler = () => Promise<void>;

/**
 * Runs the handlers in order on SIGINT/SIGTERM and exits.
 * A hard timeout guarantees the process never hangs during a deploy.
 */
export function registerGracefulShutdown(
  logger: Logger,
  handlers: ShutdownHandler[],
  timeoutMs = 20_000,
): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down gracefully');

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs }, 'Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    forceExit.unref();

    let exitCode = 0;
    for (const handler of handlers) {
      try {
        await handler();
      } catch (error) {
        exitCode = 1;
        logger.error({ err: error }, 'Shutdown handler failed');
      }
    }

    clearTimeout(forceExit);
    process.exit(exitCode);
  };

  process.once('SIGINT', (signal) => void shutdown(signal));
  process.once('SIGTERM', (signal) => void shutdown(signal));
}
