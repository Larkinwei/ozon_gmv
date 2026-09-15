import { describe, expect, it, vi } from "vitest";

import { buildAdminApp, buildWallboardApp } from "../src/server/app";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import type { FinanceReader } from "../src/server/finance/finance-service";
import type { FinanceOverview } from "../src/shared/contracts";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { SyncService } from "../src/server/services/sync-service";
import { UpdateService } from "../src/server/services/update-service";
import { ProductImageService } from "../src/server/services/product-image-service";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { createTestDatabase } from "./test-context";

const emptyOverview: FinanceOverview = {
  generatedAt: "2026-09-15T00:00:00.000Z",
  month: "2026-09",
  stores: [],
  skuSummaries: [],
  totalsByCurrency: [],
  sync: { id: null, state: "idle", from: null, to: null, totalDays: 0, completedDays: 0, failedDays: 0, error: null, startedAt: null, finishedAt: null },
};

describe("finance admin API", () => {
  it("protects finance endpoints and does not register them on Wallboard", async () => {
    const context = createTestDatabase();
    const events = new DashboardEventBus();
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxySettings = new ProxySettingsService(context.config, settings);
    const stores = new StoresRepository(context.database);
    const syncService = new SyncService(context.config, stores, new PostingsRepository(context.database), new SyncCheckpointsRepository(context.database), events, proxySettings, new ProductImageService(new ProductImagesRepository(context.database)));
    const finance: FinanceReader = {
      getOverview: vi.fn(async () => emptyOverview),
      getOrders: vi.fn(async () => ({ items: [], page: 1, pageSize: 20, total: 0 })),
      getOrderDetail: vi.fn(async () => null),
      getExceptions: vi.fn(async () => []),
      beginSync: vi.fn(async () => emptyOverview.sync),
      getSyncRun: vi.fn(() => null),
      start: vi.fn(),
      syncActiveStores: vi.fn(async () => undefined),
    };
    const dependencies = { config: context.config, database: context.database, events, syncService, proxySettings, updates: new UpdateService(context.config, proxySettings), finance };
    const adminApp = await buildAdminApp(dependencies);
    const wallboardApp = await buildWallboardApp(dependencies);
    try {
      expect((await adminApp.inject({ method: "GET", url: "/api/finance/overview?month=2026-09" })).statusCode).toBe(401);
      const setup = await adminApp.inject({ method: "POST", url: "/api/setup/initialize", payload: { username: "admin", password: "correct-horse-battery-staple" } });
      const cookie = setup.cookies.find((item) => item.name === "ozon_session")?.value ?? "";
      const response = await adminApp.inject({ method: "GET", url: "/api/finance/overview?month=2026-09", cookies: { ozon_session: cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(emptyOverview);
      expect(finance.getOverview).toHaveBeenCalledWith("2026-09", []);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/finance/overview?month=2026-09" })).statusCode).toBe(404);
    } finally {
      await Promise.all([adminApp.close(), wallboardApp.close()]);
      context.cleanup();
    }
  });
});
