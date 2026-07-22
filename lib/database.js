import { MongoClient } from "mongodb";
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
      ]);
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

