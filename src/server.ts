import { loadEnv } from './config/env.js';
import { createContainer } from './container.js';
import { buildApp } from './http/app.js';
import { createLogger } from './lib/logger.js';
import { registerGracefulShutdown } from './lib/shutdown.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({
    name: 'flowforge-api',
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });

  const container = createContainer(env, logger);
  const app = await buildApp(container);

  registerGracefulShutdown(logger, [() => app.close(), () => container.dispose()]);

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error: unknown) => {
  // The logger may not exist yet if configuration failed to load.
  process.stderr.write(`Failed to start API: ${String(error)}\n`);
  process.exit(1);
});
