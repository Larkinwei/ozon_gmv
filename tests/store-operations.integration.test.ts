import { describe, expect, it, vi } from "vitest";

import { buildAdminApp, buildWallboardApp } from "../src/server/app";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { ProductImageService } from "../src/server/services/product-image-service";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import type { StoreOperationsReader } from "../src/server/services/store-operations-service";
import { SyncService } from "../src/server/services/sync-service";
import { UpdateService } from "../src/server/services/update-service";
import type { StoreOperationsSnapshot } from "../src/shared/contracts";
import { createTestDatabase } from "./test-context";

const STORE_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100041";

describe("store operations API", () => {
  it("protects the admin overview and keeps operations off the wallboard app", async () => {
    const context = createTestDatabase();
    const events = new DashboardEventBus();
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxySettings = new ProxySettingsService(context.config, settings);
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
    const snapshot: StoreOperationsSnapshot = { generatedAt: "2026-08-31T12:00:00.000Z", stores: [] };
    const operations: StoreOperationsReader = {
      getOverview: vi.fn(async () => snapshot),
      getQuestionDetail: vi.fn(async () => null),
    };
    const dependencies = {
      config: context.config,
      database: context.database,
      events,
      syncService,
      proxySettings,
      updates: new UpdateService(context.config, proxySettings),
      storeOperations: operations,
    };
    const adminApp = await buildAdminApp(dependencies);
    const wallboardApp = await buildWallboardApp(dependencies);

    try {
      const unauthorized = await adminApp.inject({ method: "GET", url: "/api/store-operations/overview" });
      expect(unauthorized.statusCode).toBe(401);

      const setup = await adminApp.inject({
        method: "POST",
        url: "/api/setup/initialize",
        payload: { username: "admin", password: "correct-horse-battery-staple" },
      });
      const cookie = setup.cookies.find((item) => item.name === "ozon_session")?.value ?? "";
      const overview = await adminApp.inject({
        method: "GET",
        url: `/api/store-operations/overview?storeIds=${STORE_ID}`,
        cookies: { ozon_session: cookie },
      });
      expect(overview.statusCode).toBe(200);
      expect(overview.json()).toEqual(snapshot);
      expect(operations.getOverview).toHaveBeenCalledWith([STORE_ID]);

      const detail = await adminApp.inject({
        method: "GET",
        url: `/api/store-operations/questions/${STORE_ID}/question-1`,
        cookies: { ozon_session: cookie },
      });
      expect(detail.statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/store-operations/overview" })).statusCode).toBe(404);
    } finally {
      await Promise.all([adminApp.close(), wallboardApp.close()]);
      context.cleanup();
    }
  });
});
