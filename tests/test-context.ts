import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppConfig } from "../src/server/config";
import { closeDatabase, openDatabase, type AppDatabase } from "../src/server/db/database";
import { runMigrations } from "../src/server/db/migrate";

export interface TestDatabaseContext {
  config: AppConfig;
  database: AppDatabase;
  cleanup: () => void;
}

/** Creates a real disposable SQLite database so integration tests exercise production SQL. */
export function createTestDatabase(): TestDatabaseContext {
  const root = mkdtempSync(join(tmpdir(), "ozon-gmv-test-"));
  const database = openDatabase(join(root, "data"));
  runMigrations(database);
  return {
    database,
    config: {
      NODE_ENV: "test",
      DATA_DIR: root,
      ADMIN_PORT: 3001,
      WALLBOARD_PORT: 3002,
      ADMIN_HOST: "127.0.0.1",
      WALLBOARD_HOST: "0.0.0.0",
      COOKIE_SECRET: "a-cookie-secret-that-is-longer-than-32-characters",
      ENCRYPTION_KEY: "1".repeat(64),
      PUBLIC_BASE_URL: "http://127.0.0.1:3001",
      OZON_API_BASE_URL: "https://api-seller.ozon.ru",
      LOCAL_MODE: true,
      APP_VERSION: "1.4.0",
      UPDATE_ENABLED: false,
      UPDATE_PRIMARY_MANIFEST_URL: "https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/ozon-gmv/releases/latest.json",
      UPDATE_FALLBACK_MANIFEST_URL: "https://github.com/Larkinwei/ozon_gmv/releases/latest/download/latest.json",
      CATEGORY_CLOUD_BASE_URL: "https://categories.example.com",
      LOG_LEVEL: "silent",
      COOKIE_SECURE: false,
    },
    cleanup: () => {
      closeDatabase(database);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
