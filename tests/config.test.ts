import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/server/config";

describe("runtime configuration", () => {
  it("creates and reuses machine-local secrets without administrator defaults", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ozon-gmv-config-"));
    try {
      const first = loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir });
      const second = loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir });
      expect(first.COOKIE_SECRET).toBe(second.COOKIE_SECRET);
      expect(first.ENCRYPTION_KEY).toBe(second.ENCRYPTION_KEY);
      expect(first.ADMIN_HOST).toBe("127.0.0.1");
      expect(first.ADMIN_PORT).toBe(3001);
      expect(existsSync(join(dataDir, "config", "runtime-secrets.json"))).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid encryption key supplied by deployment configuration", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      DATA_DIR: join(tmpdir(), "ozon-gmv-invalid-config"),
      COOKIE_SECRET: "a-cookie-secret-that-is-longer-than-32-characters",
      ENCRYPTION_KEY: "not-a-key",
    })).toThrow();
  });
});
