import { describe, expect, it, vi } from "vitest";

import { buildAdminApp } from "../src/server/app";
import { MarketplaceRepository } from "../src/server/db/marketplace-repository";
import { MarketplaceSyncCheckpointsRepository } from "../src/server/db/marketplace-sync-checkpoints-repository";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { ProductImageService } from "../src/server/services/product-image-service";
import { SyncService } from "../src/server/services/sync-service";
import { UpdateService } from "../src/server/services/update-service";
import { createTestDatabase } from "./test-context";

describe("Wildberries store API", () => {
  it("validates and encrypts a WB token without returning it", async () => {
    const context = createTestDatabase();
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    vi.stubGlobal("fetch", (async (input: URL | RequestInfo) => {
      if (String(input).includes("account/balance")) {
        return new Response(JSON.stringify({ currency: "RUB", current: "100.00", for_withdraw: "50.00" }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch);
    const events = new DashboardEventBus();
    const stores = new StoresRepository(context.database);
    const proxySettings = new ProxySettingsService(context.config, settings);
    const syncService = new SyncService(
      context.config,
      stores,
      new PostingsRepository(context.database),
      new SyncCheckpointsRepository(context.database),
      events,
      proxySettings,
      new ProductImageService(new ProductImagesRepository(context.database)),
      new MarketplaceRepository(context.database),
      new MarketplaceSyncCheckpointsRepository(context.database),
    );
    const app = await buildAdminApp({
      config: context.config,
      database: context.database,
      events,
      syncService,
      proxySettings,
      updates: new UpdateService(context.config, proxySettings),
    });
    const proxyFactory = vi.spyOn(proxySettings, "createFetch").mockImplementation(() => {
      throw new Error("Wildberries requests must not use the Ozon proxy");
    });
    try {
      const setup = await app.inject({
        method: "POST",
        url: "/api/setup/initialize",
        payload: { username: "admin", password: "correct-horse-battery-staple" },
      });
      const cookie = setup.cookies.find((item) => item.name === "ozon_session")?.value ?? "";
      const response = await app.inject({
        method: "POST",
        url: "/api/stores",
        cookies: { ozon_session: cookie },
        payload: { platform: "wildberries", name: "WB 测试店铺", apiToken: "wildberries-secret-token", color: "#F59E0B" },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ store: { platform: "wildberries", name: "WB 测试店铺" }, backfillDays: 90, pollIntervalSeconds: 300 });
      expect(response.body).not.toContain("wildberries-secret-token");
      expect(context.database.prepare("SELECT credential_type FROM store_credentials").get()).toEqual({ credential_type: "wildberries_api_token" });
      expect(context.database.prepare("SELECT password_hash FROM administrators").get()).toBeTruthy();
    } finally {
      proxyFactory.mockRestore();
      vi.unstubAllGlobals();
      await app.close();
      context.cleanup();
    }
  });
});
