/**
 * Service entrypoint.
 */
import { createApp } from './app';
import { env } from './config/env';
import { connectToDatabase, disconnectDatabase } from './database/mongodb';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const db = await connectToDatabase();
  const app = createApp(db);

  const server = Bun.serve({
    port: env.PORT,
    fetch: (request) => app.fetch(request),
  });

  logger.info(`Subscription service listening on http://localhost:${server.port}`);

  const shutdown = async (signal: string, exitCode = 0) => {
    logger.info(`Received ${signal}; shutting down...`);
    server.stop(true);
    await disconnectDatabase();
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Catch runaway async/event-loop errors so nothing crashes silently.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', reason);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception — shutting down', error);
    void shutdown('uncaughtException', 1);
  });
}

main().catch((error) => {
  logger.error('Fatal error during startup', error);
  process.exit(1);
});
