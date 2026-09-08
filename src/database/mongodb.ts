/**
 * MongoDB connection bootstrap.
 */
import { MongoClient, type Db } from 'mongodb';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { ensureIndexes } from './indexes';

let client: MongoClient | null = null;
let db: Db | null = null;
let indexTimer: ReturnType<typeof setInterval> | null = null;

/** Re-ensure indexes periodically so a mid-run DB drop is healed automatically. */
const INDEX_MAINTENANCE_MS = 60_000;

export async function connectToDatabase(
  uri: string = env.MONGODB_URI,
  database: string = env.MONGODB_DATABASE,
): Promise<Db> {
  if (db) return db;

  logger.info(`Connecting to MongoDB (${database})...`);
  client = new MongoClient(uri, { appName: 'traderverse-subscription-service' });
  await client.connect();
  db = client.db(database);
  await ensureIndexes(db);
  logger.info('MongoDB connected and indexes ensured.');

  // Background safety net: if the database/collection is dropped while the
  // service is running, the unique indexes are recreated within a minute.
  if (indexTimer) clearInterval(indexTimer);
  indexTimer = setInterval(() => {
    if (db) {
      ensureIndexes(db).catch((error) =>
        logger.error('MongoDB index maintenance failed', error),
      );
    }
  }, INDEX_MAINTENANCE_MS);

  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('Database is not connected. Call connectToDatabase() first.');
  return db;
}

export async function disconnectDatabase(): Promise<void> {
  if (indexTimer) {
    clearInterval(indexTimer);
    indexTimer = null;
  }
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
