import { describe, expect, it } from "vitest";

import { buildAdminApp, buildWallboardApp } from "../src/server/app";
import { PricingScenariosRepository } from "../src/server/db/pricing-scenarios-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { ExchangeRateService } from "../src/server/services/exchange-rate-service";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { SyncService } from "../src/server/services/sync-service";
import { UpdateService } from "../src/server/services/update-service";
import { ProductImageService } from "../src/server/services/product-image-service";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { createTestDatabase } from "./test-context";

describe("pricing scenario API", () => {
  it("protects snapshots, keeps them immutable, and does not register them on Wallboard", async () => {
    const context = createTestDatabase();
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxySettings = new ProxySettingsService(context.config, settings);
    const events = new DashboardEventBus();
    const stores = new StoresRepository(context.database);
    const syncService = new SyncService(context.config, stores, new PostingsRepository(context.database), new SyncCheckpointsRepository(context.database), events, proxySettings, new ProductImageService(new ProductImagesRepository(context.database)));
    const exchangeRate = new ExchangeRateService(settings, async () => new Response(""));
    const pricingScenarios = new PricingScenariosRepository(context.database);
    const dependencies = { config: context.config, database: context.database, events, syncService, proxySettings, updates: new UpdateService(context.config, proxySettings), exchangeRate, pricingScenarios };
    const adminApp = await buildAdminApp(dependencies);
    const wallboardApp = await buildWallboardApp(dependencies);
    try {
      expect((await adminApp.inject({ method: "GET", url: "/api/tools/pricing/scenarios" })).statusCode).toBe(401);
      const setup = await adminApp.inject({ method: "POST", url: "/api/setup/initialize", payload: { username: "admin", password: "correct-horse-battery-staple" } });
      const cookie = setup.cookies.find((item) => item.name === "ozon_session")?.value ?? "";
      const payload = { name: "测试方案", sku: "SKU-1", mode: "target-price", inputs: { weightKg: "1" }, feeRates: { commission: "15" }, exchangeRate: "10", ruleVersion: "test", result: { suggestedPriceCny: "100" }, risk: { level: "safe" } };
      const created = await adminApp.inject({ method: "POST", url: "/api/tools/pricing/scenarios", cookies: { ozon_session: cookie }, payload });
      expect(created.statusCode).toBe(200);
      const id = created.json().id as string;
      expect((await adminApp.inject({ method: "GET", url: "/api/tools/pricing/scenarios", cookies: { ozon_session: cookie } })).json()[0].name).toBe("测试方案");
      expect((await adminApp.inject({ method: "GET", url: `/api/tools/pricing/scenarios/${id}`, cookies: { ozon_session: cookie } })).json().result).toEqual({ suggestedPriceCny: "100" });
      expect((await wallboardApp.inject({ method: "GET", url: "/api/tools/pricing/scenarios" })).statusCode).toBe(404);
      expect((await adminApp.inject({ method: "DELETE", url: `/api/tools/pricing/scenarios/${id}`, cookies: { ozon_session: cookie } })).statusCode).toBe(204);
    } finally {
      await Promise.all([adminApp.close(), wallboardApp.close()]);
      context.cleanup();
    }
  });
});
