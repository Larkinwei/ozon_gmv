import { describe, expect, it } from "vitest";

import { buildAdminApp, buildWallboardApp } from "../src/server/app";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import type { NormalizedPosting } from "../src/server/ozon/normalize";
import { OzonClient } from "../src/server/ozon/client";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { ProductImageService } from "../src/server/services/product-image-service";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { SyncService } from "../src/server/services/sync-service";
import { createTestDatabase } from "./test-context";

const STORE_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100021";
const OTHER_STORE_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100022";
const ORDER_ID_PATTERN = /^[0-9a-f-]{36}$/;

function posting(): NormalizedPosting {
  return {
    postingNumber: "24219509-8820-1",
    orderNumber: "24219509-8820",
    fulfillmentMode: "FBS",
    orderAt: new Date("2026-08-06T04:00:00.000Z"),
    status: "awaiting_packaging",
    substatus: "posting_created",
    grossAmount: "398.00",
    currency: "CNY",
    cancelledAt: null,
    items: [
      {
        sku: "1001",
        offerId: "OFFER-1001",
        name: "Спортивный костюм",
        quantity: 1,
        unitPrice: "199.00",
        currency: "CNY",
      },
      {
        sku: "1002",
        offerId: "OFFER-1002",
        name: "商品无图",
        quantity: 1,
        unitPrice: "199.00",
        currency: "CNY",
      },
    ],
  };
}

describe("order details and product image cache", () => {
  it("serves a store-isolated non-PII detail to admin and paired wallboard sessions", async () => {
    const context = createTestDatabase();
    const stores = new StoresRepository(context.database);
    await stores.create({
      id: STORE_ID,
      name: "YOGOLD",
      clientId: "client-order-detail",
      apiKeyCiphertext: "cipher",
      color: "#EC4899",
      fulfillmentModes: ["FBS"],
      apiKeyExpiresAt: null,
    });
    await stores.create({
      id: OTHER_STORE_ID,
      name: "Other store",
      clientId: "client-other",
      apiKeyCiphertext: "cipher",
      color: "#3B82F6",
      fulfillmentModes: ["FBS"],
      apiKeyExpiresAt: null,
    });
    const mutation = await new PostingsRepository(context.database).upsert(STORE_ID, posting());
    expect(mutation.id).toMatch(ORDER_ID_PATTERN);

    const fetchImplementation = (async () => new Response(JSON.stringify({
      items: [
        {
          offer_id: "OFFER-1001",
          primary_image: ["https://cdn.example.com/1001.jpg"],
          images: [],
          sources: [{ sku: 1001 }],
        },
        {
          offer_id: "OFFER-1002",
          primary_image: ["http://insecure.example.com/1002.jpg"],
          images: [],
          sources: [{ sku: 1002 }],
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const productImages = new ProductImageService(new ProductImagesRepository(context.database));
    await productImages.refreshStore(STORE_ID, new OzonClient({
      clientId: "client-order-detail",
      apiKey: "secret",
      baseUrl: context.config.OZON_API_BASE_URL,
      fetchImplementation,
      maxAttempts: 1,
    }));
    context.database.prepare(
      `INSERT INTO product_images (store_id, sku, offer_id, primary_image_url, refreshed_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(OTHER_STORE_ID, "1001", "OFFER-1001", "https://cdn.example.com/wrong-store.jpg", Date.now());
    const cachedImages = context.database.prepare(
      "SELECT sku, primary_image_url FROM product_images WHERE store_id = ? ORDER BY sku",
    ).all(STORE_ID) as Array<{ sku: string; primary_image_url: string | null }>;
    expect(cachedImages).toEqual([
      { sku: "1001", primary_image_url: "https://cdn.example.com/1001.jpg" },
      { sku: "1002", primary_image_url: null },
    ]);
    expect(new ProductImagesRepository(context.database).listStale(STORE_ID, Date.now() - 1000, 1000)).toEqual([]);

    const events = new DashboardEventBus();
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxySettings = new ProxySettingsService(context.config, settings);
    const syncService = new SyncService(
      context.config,
      stores,
      new PostingsRepository(context.database),
      new SyncCheckpointsRepository(context.database),
      events,
      proxySettings,
      productImages,
    );
    const dependencies = { config: context.config, database: context.database, events, syncService, proxySettings };
    const adminApp = await buildAdminApp(dependencies);
    const wallboardApp = await buildWallboardApp(dependencies);

    try {
      const setup = await adminApp.inject({
        method: "POST",
        url: "/api/setup/initialize",
        payload: { username: "admin", password: "correct-horse-battery-staple" },
      });
      const adminCookie = setup.cookies.find((cookie) => cookie.name === "ozon_session")?.value ?? "";
      const adminDetail = await adminApp.inject({
        method: "GET",
        url: `/api/dashboard/orders/${mutation.id}`,
        cookies: { ozon_session: adminCookie },
      });
      expect(adminDetail.statusCode).toBe(200);
      expect(adminDetail.json()).toMatchObject({
        postingNumber: "24219509-8820-1",
        amount: { amount: "398.00", currency: "CNY" },
        items: [
          {
            sku: "1001",
            imageUrl: "https://cdn.example.com/1001.jpg",
            quantity: 1,
            unitPrice: { amount: "199.00", currency: "CNY" },
            subtotal: { amount: "199.00", currency: "CNY" },
          },
          {
            sku: "1002",
            imageUrl: null,
            quantity: 1,
            subtotal: { amount: "199.00", currency: "CNY" },
          },
        ],
      });
      expect(adminDetail.body).not.toMatch(/customer|phone|address/i);

      const pairing = await adminApp.inject({
        method: "POST",
        url: "/api/wallboard/pairings",
        cookies: { ozon_session: adminCookie },
      });
      const token = new URL(pairing.json<{ links: string[] }>().links[0] as string).searchParams.get("token") ?? "";
      const connect = await wallboardApp.inject({ method: "GET", url: `/connect?token=${encodeURIComponent(token)}` });
      const wallboardCookie = connect.cookies.find((cookie) => cookie.name === "ozon_wallboard")?.value ?? "";
      const wallboardDetail = await wallboardApp.inject({
        method: "GET",
        url: `/api/wallboard/orders/${mutation.id}`,
        cookies: { ozon_wallboard: wallboardCookie },
      });
      expect(wallboardDetail.statusCode).toBe(200);

      const unauthorized = await wallboardApp.inject({ method: "GET", url: `/api/wallboard/orders/${mutation.id}` });
      expect(unauthorized.statusCode).toBe(401);
      const missing = await adminApp.inject({
        method: "GET",
        url: "/api/dashboard/orders/00000000-0000-4000-8000-000000000000",
        cookies: { ozon_session: adminCookie },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await Promise.all([adminApp.close(), wallboardApp.close()]);
      context.cleanup();
    }
  });
});
