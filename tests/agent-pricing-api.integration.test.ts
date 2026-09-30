import { describe, expect, it } from "vitest";

import { buildAdminApp, buildWallboardApp } from "../src/server/app";
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

async function createApps(withExchangeRate = true) {
  const context = createTestDatabase();
  const settings = new SettingsRepository(context.database);
  settings.set("network.proxy_mode", "direct");
  if (withExchangeRate) {
    settings.set("tools.exchange_rate.cny_rub", JSON.stringify({
      available: true,
      rate: "10",
      fromCurrency: "CNY",
      toCurrency: "RUB",
      source: "测试汇率",
      effectiveDate: "2026-09-21",
      checkedAt: "2026-09-21T00:00:00.000Z",
      fetchedAt: "2026-09-21T00:00:00.000Z",
      error: null,
    }));
  }
  const proxySettings = new ProxySettingsService(context.config, settings);
  const events = new DashboardEventBus();
  const stores = new StoresRepository(context.database);
  const syncService = new SyncService(
    context.config,
    stores,
    new PostingsRepository(context.database),
    new SyncCheckpointsRepository(context.database),
    events,
    proxySettings,
    new ProductImageService(new ProductImagesRepository(context.database)),
  );
  const dependencies = {
    config: context.config,
    database: context.database,
    events,
    syncService,
    proxySettings,
    updates: new UpdateService(context.config, proxySettings),
    exchangeRate: new ExchangeRateService(settings, async () => new Response("")),
  };
  const adminApp = await buildAdminApp(dependencies);
  const wallboardApp = await buildWallboardApp(dependencies);
  return {
    adminApp,
    wallboardApp,
    cleanup: async () => {
      await Promise.all([adminApp.close(), wallboardApp.close()]);
      context.cleanup();
    },
  };
}

describe("local Agent pricing APIs", () => {
  it("calculates workbook pricing and shipping results with cached rate metadata", async () => {
    const apps = await createApps();
    try {
      const target = await apps.adminApp.inject({
        method: "POST",
        url: "/api/agent/v1/pricing/target-price",
        payload: { weightKg: "2.5", procurementCostCny: "54.21", otherCostCny: "0", targetProfitCny: "55" },
      });
      expect(target.statusCode).toBe(200);
      expect(Number(target.json().result.suggestedPriceCny)).toBeCloseTo(295.508982, 5);
      expect(target.json().result.shippingCostCny).toBe("88.19");
      expect(target.json().result.platformReceivableCny).toBeUndefined();
      expect(target.json().exchangeRate.rate).toBe("10");
      expect(target.json().rules.pricingFormulaVersion).toBe("Pricing Formula V1");

      const overriddenFee = await apps.adminApp.inject({
        method: "POST",
        url: "/api/agent/v1/pricing/profit",
        payload: { salePriceCny: "160", weightKg: "2.5", procurementCostCny: "54.21", otherCostCny: "0", feeRates: { tax: "0" } },
      });
      expect(overriddenFee.statusCode).toBe(200);
      expect(overriddenFee.json().result.feeLines.find((line: { key: string }) => line.key === "tax").rate).toBe("0");
      expect(overriddenFee.json().result.feeLines.find((line: { key: string }) => line.key === "commission").rate).toBe("15");

      const profit = await apps.adminApp.inject({
        method: "POST",
        url: "/api/agent/v1/pricing/profit",
        payload: { salePriceCny: "160", weightKg: "2.5", procurementCostCny: "54.21", otherCostCny: "0" },
      });
      expect(profit.statusCode).toBe(200);
      expect(profit.json().result.mode).toBe("existing-price");
      expect(profit.json().result.actualSalePriceRub).toBe("1600.00");
      expect(profit.json().result.platformReceivableCny).toBeUndefined();

      const shipping = await apps.adminApp.inject({
        method: "POST",
        url: "/api/agent/v1/shipping/calculate",
        payload: { salePriceCny: "150", weightKg: "0.5", lengthCm: "10", widthCm: "10", heightCm: "10" },
      });
      expect(shipping.statusCode).toBe(200);
      expect(shipping.json().result.channels.find((channel: { id: string }) => channel.id === "extra-small-standard").feeCny).toBe("23.02");
      expect(shipping.json().result.channels.find((channel: { id: string }) => channel.id === "big-economy").reason).toContain("货值需在");
      expect(shipping.json().rules.shippingTariffVersion).toBe("CEL OZON-rFBS V7.24");

      const docs = await apps.adminApp.inject({ method: "GET", url: "/api/agent/v1/openapi.json" });
      expect(docs.statusCode).toBe(200);
      expect(docs.json().paths["/api/agent/v1/pricing/target-price"]).toBeDefined();
      expect(docs.body).toContain("国内税费估算");
      expect((await apps.wallboardApp.inject({ method: "GET", url: "/api/agent/v1/openapi.json" })).statusCode).toBe(404);
      expect((await apps.wallboardApp.inject({ method: "POST", url: "/api/agent/v1/shipping/calculate", payload: {} })).statusCode).toBe(404);
    } finally {
      await apps.cleanup();
    }
  });

  it("validates input, requires a cached rate, and rejects browser or non-loopback callers", async () => {
    const apps = await createApps(false);
    try {
      const validBody = { weightKg: "1", procurementCostCny: "10", otherCostCny: "0", targetProfitCny: "5" };
      const invalid = await apps.adminApp.inject({ method: "POST", url: "/api/agent/v1/pricing/target-price", payload: { ...validBody, weightKg: "-1" } });
      expect(invalid.statusCode, invalid.body).toBe(400);

      const missingRate = await apps.adminApp.inject({ method: "POST", url: "/api/agent/v1/pricing/target-price", payload: validBody });
      expect(missingRate.statusCode).toBe(503);
      expect(missingRate.json().error).toBe("EXCHANGE_RATE_UNAVAILABLE");

      const browserRequest = await apps.adminApp.inject({ method: "GET", url: "/api/agent/v1/openapi.json", headers: { origin: "https://example.com" } });
      expect(browserRequest.statusCode).toBe(403);

      const remoteRequest = await apps.adminApp.inject({ method: "GET", url: "/api/agent/v1/openapi.json", remoteAddress: "192.168.1.20" });
      expect(remoteRequest.statusCode).toBe(403);
    } finally {
      await apps.cleanup();
    }
  });
});
