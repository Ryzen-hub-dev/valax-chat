import { MongoClient, ServerApiVersion } from "mongodb";
import { getDatabaseConfig } from "./env.js";
import { createMemoryDatabase } from "./memory-db.js";

const cache = globalThis.__valaxMongoCache || {
  client: null,
  clientPromise: null,
  indexPromise: null,
  memoryDatabase: null,
};

globalThis.__valaxMongoCache = cache;

/**
 * 用内存替身还是真 MongoDB？
 *
 * 【默认行为】
 *   · `VALAX_DB_MODE=memory` → 强制内存
 *   · `VALAX_DB_MODE=mongo`  → 强制真库
 *   · 都没设 → **有 MONGODB_URI 就用真库，没有就回落内存**
 *
 * 【为什么默认回落而不是抛错】
 * `scripts/test-workflows.js` 之前因为缺 `MONGODB_URI` **直接抛异常**，
 * 于是「开发者本地没装 MongoDB」= **整个测试套件 0 覆盖**。
 * 回落之后 `npm test` 在任何机器上都能跑。
 *
 * ⚠️ **生产环境要注意**：真库里 `MONGODB_URI` 是必填的，
 *   万一部署时漏配，现在会**静默用内存库**（数据不持久）。
 *   所以：只有 `NODE_ENV === "production"` 时缺 URI 才继续抛错。
 */
function useMemoryDatabase() {
  const mode = (process.env.VALAX_DB_MODE || "").trim().toLowerCase();
  if (mode === "memory") return true;
  if (mode === "mongo") return false;
  if (process.env.MONGODB_URI?.trim()) return false;
  // ⚠️ 生产环境不回落 —— 静默的内存库 = 数据不持久 = 事故
  if ((process.env.NODE_ENV || "").trim() === "production") return false;
  return true;
}

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
  if (useMemoryDatabase()) {
    if (!cache.memoryDatabase) cache.memoryDatabase = createMemoryDatabase();
    return cache.memoryDatabase;
  }
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
        database.collection("dmConversations").createIndex({ userId: 1, botId: 1, guildId: 1, recipientId: 1 }, { unique: true }),
        database.collection("dmConversations").createIndex({ userId: 1, botId: 1, guildId: 1, updatedAt: -1 }),
        database.collection("savedExpressions").createIndex({ userId: 1, type: 1, expressionId: 1 }, { unique: true }),
        database.collection("savedExpressions").createIndex({ userId: 1, updatedAt: -1 }),
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
  cache.memoryDatabase = null;
}
