import { describe, expect, it, vi } from "vitest";

import { MarketplaceRepository } from "../src/server/db/marketplace-repository";
import { MarketplaceSyncCheckpointsRepository } from "../src/server/db/marketplace-sync-checkpoints-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { encryptSecret } from "../src/server/security/encryption";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { ProductImageService } from "../src/server/services/product-image-service";
import { SyncService } from "../src/server/services/sync-service";
import { createTestDatabase } from "./test-context";

const STORE_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100061";

describe("Wildberries synchronization", () => {
  it("stores orders and sales, notifies incremental orders once, and suppresses backfill", async () => {
    const context = createTestDatabase();
    const stores = new StoresRepository(context.database);
    await stores.create({
      id: STORE_ID,
      name: "WB 测试店铺",
      platform: "wildberries",
      credentialType: "wildberries_api_token",
      clientId: "",
      apiKeyCiphertext: encryptSecret("wb-token", context.config.ENCRYPTION_KEY),
      color: "#F59E0B",
      fulfillmentModes: [],
      apiKeyExpiresAt: null,
    });
    const settings = new (await import("../src/server/db/settings-repository")).SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("account/balance")) {
        return new Response(JSON.stringify({ currency: "RUB", current: "500.00", for_withdraw: "300.00" }), { status: 200 });
      }
      if (url.includes("/sales")) {
        return new Response(JSON.stringify([
          { saleID: "sale-1", srid: "order-1", date: "2026-08-18T10:00:00Z", forPay: 100, barcode: "111", supplierArticle: "A", subject: "商品 A" },
          { saleID: "return-1", srid: "order-1", date: "2026-08-18T11:00:00Z", forPay: 20, isStorno: true, barcode: "111", supplierArticle: "A", subject: "商品 A" },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([
        { srid: "older-order", odid: "WB-OLD", date: "2026-08-18T08:30:00Z", totalPrice: 75, barcode: "000", supplierArticle: "OLD", subject: "当天较早订单" },
        { srid: "order-1", odid: "WB-1", date: "2026-08-18T10:00:00Z", totalPrice: 100, barcode: "111", supplierArticle: "A", subject: "商品 A" },
        { srid: "order-1", odid: "WB-1", date: "2026-08-18T10:00:00Z", totalPrice: 50, barcode: "222", supplierArticle: "B", subject: "商品 B" },
      ]), { status: 200 });
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const events = new DashboardEventBus();
    const received: unknown[] = [];
    events.subscribe((event) => { if (event.type === "posting.created") received.push(event); });
    const syncService = new SyncService(
      context.config,
      stores,
      // WB uses its own fact tables; the Ozon repository remains available for existing stores.
      new (await import("../src/server/db/postings-repository")).PostingsRepository(context.database),
      new (await import("../src/server/db/sync-checkpoints-repository")).SyncCheckpointsRepository(context.database),
      events,
      new ProxySettingsService(context.config, settings),
      new ProductImageService(new ProductImagesRepository(context.database)),
      new MarketplaceRepository(context.database),
      new MarketplaceSyncCheckpointsRepository(context.database),
    );
    const from = new Date("2026-08-18T09:00:00Z");
    const to = new Date("2026-08-18T11:59:59Z");
    try {
      await syncService.syncStore(STORE_ID, from, to);
      expect(received).toHaveLength(1);
      expect(context.database.prepare("SELECT COUNT(*) AS count FROM marketplace_orders").get()).toMatchObject({ count: 2 });
      expect(context.database.prepare("SELECT COUNT(*) AS count FROM marketplace_sales").get()).toMatchObject({ count: 2 });

      await syncService.syncStore(STORE_ID, from, to);
      expect(received).toHaveLength(1);

      await syncService.syncStore(STORE_ID, new Date("2026-08-01T00:00:00Z"), to);
      expect(received).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      context.cleanup();
    }
  });
});
