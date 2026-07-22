import { closeDatabase, ensureDatabaseIndexes, getDatabase } from "../lib/database.js";

try {
  await ensureDatabaseIndexes();
  const database = await getDatabase();
  await database.command({ ping: 1 });
  console.log("Valax MongoDB connection and indexes are ready.");
} catch (error) {
  console.error("Valax MongoDB initialization failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}

