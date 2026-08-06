import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildAdminApp } from "../src/server/app";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { ProductImageService } from "../src/server/services/product-image-service";
import { SyncService } from "../src/server/services/sync-service";
import { createTestDatabase } from "./test-context";

describe("administrator setup and session API", () => {
  it("initializes once, creates a signed session, and protects management routes", async () => {
    const context = createTestDatabase();
    const events = new DashboardEventBus();
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxySettings = new ProxySettingsService(context.config, settings);
    const syncService = new SyncService(
      context.config,
      new StoresRepository(context.database),
      new PostingsRepository(context.database),
      new SyncCheckpointsRepository(context.database),
      events,
      proxySettings,
      new ProductImageService(new ProductImagesRepository(context.database)),
    );
    const app = await buildAdminApp({
      config: context.config,
      database: context.database,
      events,
      syncService,
      proxySettings,
    });

    try {
      const builtHtml = readFileSync("dist/web/index.html", "utf8");
      const modulePath = builtHtml.match(/src="([^"]+\.js)"/)?.[1] ?? "";
      const moduleResponse = await app.inject({ method: "GET", url: modulePath });
      expect(moduleResponse.statusCode).toBe(200);
      expect(moduleResponse.headers["content-type"]).toMatch(/javascript/);
      expect(moduleResponse.headers["cache-control"]).toContain("immutable");

      const missingAsset = await app.inject({ method: "GET", url: "/assets/missing-module.js" });
      expect(missingAsset.statusCode).toBe(404);
      expect(missingAsset.json()).toMatchObject({ error: "ASSET_NOT_FOUND" });

      const loginPage = await app.inject({ method: "GET", url: "/login" });
      expect(loginPage.statusCode).toBe(200);
      expect(loginPage.headers["content-type"]).toContain("text/html");
      expect(loginPage.headers["cache-control"]).toBe("no-store");

      const status = await app.inject({ method: "GET", url: "/api/auth/session" });
      expect(status.json()).toEqual({ authenticated: false, setupRequired: true });
      const unauthorized = await app.inject({ method: "GET", url: "/api/dashboard/overview" });
      expect(unauthorized.statusCode).toBe(401);

      const setupResponse = await app.inject({
        method: "POST",
        url: "/api/setup/initialize",
        payload: { username: "admin", password: "correct-horse-battery-staple" },
      });
      expect(setupResponse.statusCode).toBe(201);
      const cookie = setupResponse.cookies.find((item) => item.name === "ozon_session");
      expect(cookie?.httpOnly).toBe(true);
      expect(cookie?.sameSite).toBe("Strict");

      const duplicateSetup = await app.inject({
        method: "POST",
        url: "/api/setup/initialize",
        payload: { username: "another", password: "another-secure-password" },
      });
      expect(duplicateSetup.statusCode).toBe(409);

      const sessionResponse = await app.inject({
        method: "GET",
        url: "/api/auth/session",
        cookies: { ozon_session: cookie?.value ?? "" },
      });
      expect(sessionResponse.json()).toEqual({ authenticated: true, username: "admin", setupRequired: false });
    } finally {
      await app.close();
      context.cleanup();
    }
  });
});
