import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig } from "../config";
import { closeDatabase, openDatabase, type AppDatabase } from "./database";

interface MigrationRow {
  name: string;
}

/** Applies every pending SQLite migration exactly once in a transaction. */
export function runMigrations(database: AppDatabase, directory = resolve(process.cwd(), "migrations")): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    )
  `);

  const migrationNames = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  const findMigration = database.prepare<[string], MigrationRow>("SELECT name FROM schema_migrations WHERE name = ?");
  const recordMigration = database.prepare("INSERT INTO schema_migrations (name, applied_at_ms) VALUES (?, ?)");

  for (const name of migrationNames) {
    if (findMigration.get(name)) {
      continue;
    }
    const applyMigration = database.transaction(() => {
      database.exec(readFileSync(resolve(directory, name), "utf8"));
      recordMigration.run(name, Date.now());
    });
    applyMigration();
  }
}

function main(): void {
  const config = loadConfig();
  const database = openDatabase(join(config.DATA_DIR, "data"));
  try {
    runMigrations(database);
  } finally {
    closeDatabase(database);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
