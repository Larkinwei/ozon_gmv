import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { StoresRepository } from "../src/server/db/stores-repository";
import { BackupService } from "../src/server/services/backup-service";
import { createTestDatabase } from "./test-context";

describe("SQLite online backup", () => {
  it("creates a readable standalone database with the committed rows", async () => {
    const context = createTestDatabase();
    const backupDir = mkdtempSync(join(tmpdir(), "ozon-gmv-backups-"));
    try {
      await new StoresRepository(context.database).create({
        id: "8f9dc7d2-35a8-45d5-b199-c39c5a100001",
        name: "Backup store",
        clientId: "backup-client",
        apiKeyCiphertext: "ciphertext",
        color: "#3B82F6",
        fulfillmentModes: ["FBO"],
        apiKeyExpiresAt: null,
      });
      const path = await new BackupService(context.database, backupDir).create("upgrade");
      expect(existsSync(path)).toBe(true);
      const restored = new BetterSqlite3(path, { readonly: true });
      try {
        expect((restored.prepare("SELECT COUNT(*) AS count FROM stores").get() as { count: number }).count).toBe(1);
        expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
      } finally {
        restored.close();
      }
    } finally {
      context.cleanup();
      rmSync(backupDir, { recursive: true, force: true });
    }
  });
});
