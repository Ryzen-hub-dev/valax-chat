import { MongoClient, ServerApiVersion } from "mongodb";
import { getDatabaseConfig } from "./env.js";

const cache = globalThis.__valaxMongoCache || {
  client: null,
  clientPromise: null,
  indexPromise: null,
};

globalThis.__valaxMongoCache = cache;

async function getClient() {
  if (!cache.clientPromise) {
    const { uri } = getDatabaseConfig();
    cache.client = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 8_000,
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });
    cache.clientPromise = cache.client.connect().catch((error) => {
      cache.client = null;
      cache.clientPromise = null;
      throw error;
    });
  }

  return cache.clientPromise;
}

export async function getDatabase() {
  const client = await getClient();
  const { databaseName } = getDatabaseConfig();
  return client.db(databaseName);
}

export async function ensureDatabaseIndexes() {
  if (!cache.indexPromise) {
    cache.indexPromise = (async () => {
      const database = await getDatabase();
      await Promise.all([
        database.collection("users").createIndex({ discordId: 1 }, { unique: true }),
        database.collection("sessions").createIndex({ tokenHash: 1 }, { unique: true }),
        database.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        database.collection("sessions").createIndex({ userId: 1 }),
        database.collection("botConnections").createIndex({ userId: 1, botId: 1 }, { unique: true }),
        database.collection("botConnections").createIndex({ userId: 1, updatedAt: -1 }),
        database.collection("botConnections").createIndex({ botId: 1 }),
        database.collection("guildChecks").createIndex({ userId: 1, botId: 1, guildId: 1 }, { unique: true }),
        database.collection("guildChecks").createIndex({ userId: 1, botId: 1, available: 1 }),
        database.collection("messageLogs").createIndex({ userId: 1, botId: 1, channelId: 1, createdAt: -1 }),
        database.collection("messageLogs").createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
        database.collection("notificationSettings").createIndex({ userId: 1, botId: 1, guildId: 1 }, { unique: true }),
        database.collection("dmCampaigns").createIndex({ userId: 1, botId: 1, guildId: 1, createdAt: -1 }),
        database.collection("dmCampaigns").createIndex({ status: 1, nextAttemptAt: 1 }),
        database.collection("dmDeliveryLogs").createIndex({ userId: 1, botId: 1, guildId: 1, recipientId: 1, createdAt: -1 }),
        database.collection("dmDeliveryLogs").createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
      ]);
      // The first release used a unique userId-only index. Remove it so one
      // account can own several independent bot connections.
      await database.collection("botConnections").dropIndex("userId_1").catch(() => {});
      await database.collection("guildChecks").dropIndex("userId_1_guildId_1").catch(() => {});
      await database.collection("messageLogs").dropIndex("userId_1_channelId_1_createdAt_-1").catch(() => {});
    })().catch((error) => {
      cache.indexPromise = null;
      throw error;
    });
  }

  return cache.indexPromise;
}

export async function closeDatabase() {
  if (cache.clientPromise) await cache.clientPromise;
  if (cache.client) await cache.client.close();
  cache.client = null;
  cache.clientPromise = null;
  cache.indexPromise = null;
}
