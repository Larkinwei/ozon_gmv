import { join } from "node:path";

import { loadConfig } from "./config";
import { closeDatabase, openDatabase } from "./db/database";
import { runMigrations } from "./db/migrate";
import { BackupService } from "./services/backup-service";

/** Runs service-safe maintenance commands used by the Windows installer. */
async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "backup-upgrade" && command !== "checkpoint") {
    throw new Error("Usage: maintenance <backup-upgrade|checkpoint>");
  }
  const config = loadConfig();
  const database = openDatabase(join(config.DATA_DIR, "data"));
  try {
    runMigrations(database);
    if (command === "checkpoint") {
      database.pragma("wal_checkpoint(TRUNCATE)");
      return;
    }
    const backup = await new BackupService(database, join(config.DATA_DIR, "backups")).create("upgrade");
    process.stdout.write(backup);
  } finally {
    closeDatabase(database);
  }
}

await main();
