import argon2 from "argon2";
import { describe, expect, it, vi } from "vitest";

import { buildAdminApp } from "../src/server/app";
import { AdminRepository } from "../src/server/db/admin-repository";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { encryptSecret } from "../src/server/security/encryption";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { ProductImageService } from "../src/server/services/product-image-service";
import { SyncService } from "../src/server/services/sync-service";
import { UpdateService } from "../src/server/services/update-service";
import { createTestDatabase } from "./test-context";

const STORE_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100001";
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

async function waitForSync(app: Awaited<ReturnType<typeof buildAdminApp>>, cookieValue: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/api/stores", cookies: { ozon_session: cookieValue } });
    const stores = response.json<Array<{ lastSyncFinishedAt: string | null }>>();
    if (stores[0]?.lastSyncFinishedAt) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Store synchronization did not finish in time");
}

describe("store synchronization API", () => {
  it("synchronizes the requested recent-day range with the SQLite store", async () => {
    const context = createTestDatabase();
    const requestBodies: Array<{ filter: { since: string; to: string } }> = [];
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as { filter: { since: string; to: string } });
      return new Response(JSON.stringify({ postings: [], cursor: null, has_next: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const stores = new StoresRepository(context.database);
    await stores.create({
      id: STORE_ID,
      name: "Test store",
      clientId: "client",
      apiKeyCiphertext: encryptSecret("seller-api-key", context.config.ENCRYPTION_KEY),
      color: "#3B82F6",
      fulfillmentModes: ["FBS"],
      apiKeyExpiresAt: null,
    });
    new AdminRepository(context.database).create("admin", await argon2.hash("correct-horse-battery-staple"));
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxySettings = new ProxySettingsService(context.config, settings);
    const events = new DashboardEventBus();
    const syncService = new SyncService(
      context.config,
      stores,
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
      updates: new UpdateService(context.config, proxySettings),
    });

    try {
      const loginResponse = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "correct-horse-battery-staple" },
      });
      const cookieValue = loginResponse.cookies.find((cookie) => cookie.name === "ozon_session")?.value ?? "";
      const syncResponse = await app.inject({
        method: "POST",
        url: `/api/stores/${STORE_ID}/sync`,
        cookies: { ozon_session: cookieValue },
        payload: { days: 30 },
      });
      await waitForSync(app, cookieValue);

      expect(syncResponse.statusCode).toBe(202);
      expect(syncResponse.json()).toEqual({ accepted: true, days: 30 });
      expect(requestBodies).toHaveLength(5);
      const firstSince = new Date(requestBodies[0]?.filter.since ?? "");
      const lastTo = new Date(requestBodies.at(-1)?.filter.to ?? "");
      expect(Math.round((lastTo.getTime() - firstSince.getTime()) / DAY_MILLISECONDS)).toBe(30);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
      context.cleanup();
    }
  });
});
