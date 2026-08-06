import { mkdirSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3, { type Database } from "better-sqlite3";

export type AppDatabase = Database;

/** Opens the single local database and applies the durability settings used by every runtime. */
export function openDatabase(dataDir: string): AppDatabase {
  mkdirSync(dataDir, { recursive: true });
  const database = new BetterSqlite3(join(dataDir, "ozon-gmv.db"));
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 5000");

  const integrity = database.pragma("quick_check", { simple: true });
  if (integrity !== "ok") {
    database.close();
    throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
  }
  return database;
}

/** Closes SQLite after flushing its write-ahead log into the main database file. */
export function closeDatabase(database: AppDatabase): void {
  database.pragma("wal_checkpoint(TRUNCATE)");
  database.close();
}
