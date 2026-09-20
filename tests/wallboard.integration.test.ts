import { describe, expect, it } from "vitest";

import { buildAdminApp, buildWallboardApp } from "../src/server/app";
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

describe("LAN wallboard isolation", () => {
  it("keeps a private wallboard link stable while exposing no management routes", async () => {
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
    const dependencies = {
      config: context.config,
      database: context.database,
      events,
      syncService,
      proxySettings,
      updates: new UpdateService(context.config, proxySettings),
    };
    const adminApp = await buildAdminApp(dependencies);
    const wallboardApp = await buildWallboardApp(dependencies);

    try {
      const setup = await adminApp.inject({
        method: "POST",
        url: "/api/setup/initialize",
        payload: { username: "admin", password: "correct-horse-battery-staple" },
      });
      const adminCookie = setup.cookies.find((cookie) => cookie.name === "ozon_session")?.value ?? "";
      const pairing = await adminApp.inject({
        method: "POST",
        url: "/api/wallboard/pairings",
        cookies: { ozon_session: adminCookie },
      });
      const link = pairing.json<{ links: Array<{ url: string }> }>().links[0]?.url as string;
      const secondPairing = await adminApp.inject({
        method: "POST",
        url: "/api/wallboard/pairings",
        cookies: { ozon_session: adminCookie },
      });
      expect(secondPairing.json<{ links: Array<{ url: string }> }>().links[0]?.url).toBe(link);
      const token = new URL(link).searchParams.get("access_token") ?? "";

      expect((await wallboardApp.inject({ method: "GET", url: "/api/wallboard/store-options" })).statusCode).toBe(401);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/wallboard/store-balances/overview" })).statusCode).toBe(401);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/wallboard/orders/search" })).statusCode).toBe(401);

      const connect = await wallboardApp.inject({ method: "GET", url: `/connect?access_token=${encodeURIComponent(token)}` });
      expect(connect.statusCode).toBe(302);
      const wallboardCookie = connect.cookies.find((cookie) => cookie.name === "ozon_wallboard")?.value ?? "";
      const reused = await wallboardApp.inject({ method: "GET", url: `/connect?access_token=${encodeURIComponent(token)}` });
      expect(reused.statusCode).toBe(302);

      const overview = await wallboardApp.inject({
        method: "GET",
        url: "/api/wallboard/overview?range=today",
        cookies: { ozon_wallboard: wallboardCookie },
      });
      expect(overview.statusCode).toBe(200);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/wallboard/store-options", cookies: { ozon_wallboard: wallboardCookie } })).json()).toEqual([]);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/wallboard/store-balances/overview", cookies: { ozon_wallboard: wallboardCookie } })).json()).toMatchObject({ stores: [] });
      expect((await wallboardApp.inject({ method: "GET", url: "/api/wallboard/orders/search", cookies: { ozon_wallboard: wallboardCookie } })).json()).toMatchObject({ items: [], total: 0 });
      expect((await wallboardApp.inject({ method: "GET", url: "/api/stores" })).statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/settings/network" })).statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/settings/update" })).statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/settings/notifications" })).statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/orders/search" })).statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/internal/notifications/stream" })).statusCode).toBe(404);

      await adminApp.inject({
        method: "POST",
        url: "/api/wallboard/revoke",
        cookies: { ozon_session: adminCookie },
      });
      const revoked = await wallboardApp.inject({
        method: "GET",
        url: "/api/wallboard/overview?range=today",
        cookies: { ozon_wallboard: wallboardCookie },
      });
      expect(revoked.statusCode).toBe(401);
      const revokedLink = await wallboardApp.inject({ method: "GET", url: `/connect?access_token=${encodeURIComponent(token)}` });
      expect(revokedLink.statusCode).toBe(410);
    } finally {
      await Promise.all([adminApp.close(), wallboardApp.close()]);
      context.cleanup();
    }
  });
});
