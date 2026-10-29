import { describe, expect, it } from "vitest";

import { StoresRepository } from "../src/server/db/stores-repository";
import { ResellModule } from "../src/server/selection/resell-module";
import { MyDataModule } from "../src/server/selection/my-data-module";
import { ResellImageService } from "../src/server/selection/resell-image-service";
import { encryptSecret } from "../src/server/security/encryption";
import { createTestDatabase } from "./test-context";

describe("online product list", () => {
  it("excludes archived products and reports locally synced recent units", async () => {
    const context = createTestDatabase();
    const storeId = "88888888-8888-4888-8888-888888888888";
    const stores = new StoresRepository(context.database);
    await stores.create({
      id: storeId,
      name: "在线商品测试店铺",
      clientId: "client",
      apiKeyCiphertext: encryptSecret("secret", context.config.ENCRYPTION_KEY),
      color: "#3B82F6",
      fulfillmentModes: ["FBS"],
      apiKeyExpiresAt: null,
    });

    const now = Date.now();
    context.database.prepare(`INSERT INTO postings
      (id, store_id, posting_number, order_number, fulfillment_mode, order_at_ms, status, substatus,
       gross_amount_minor, currency, cancelled_at_ms, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, 'FBS', ?, 'delivered', NULL, 1000, 'RUB', NULL, ?, ?)`).run(
      "posting-online-product-test", storeId, "posting-online-product-test", "order-test", now, now, now,
    );
    context.database.prepare(`INSERT INTO posting_items
      (id, posting_id, sku, offer_id, name, quantity, unit_price_minor, currency)
      VALUES (?, ?, ?, ?, ?, ?, 500, 'RUB')`).run(
      "item-online-product-test", "posting-online-product-test", "sku-visible", "offer-visible", "商品", 3,
    );

    const fetchImplementation: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v3/product/list") {
        return new Response(JSON.stringify({ result: {
          items: [
            { product_id: "product-visible", offer_id: "offer-visible", archived: false },
            { product_id: "product-archived", offer_id: "offer-archived", archived: true },
          ],
          last_id: "",
          has_next: false,
        } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname === "/v3/product/info/list") {
        return new Response(JSON.stringify({ items: [
          { product_id: "product-visible", offer_id: "offer-visible", sku: "sku-visible", product_name: "在线商品", is_archived: false, created_at: "2026-10-20T12:00:00Z" },
          { product_id: "product-archived", offer_id: "offer-archived", sku: "sku-archived", product_name: "归档商品", is_archived: true, created_at: "2026-10-21T12:00:00Z" },
        ] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected Ozon API request: ${url.pathname}`);
    };
    const images = new ResellImageService(context.database, { putObject: async () => ({ objectKey: "unused", publicUrl: "https://example.com/image.jpg" }) } as never);
    const module = new ResellModule(context.config, context.database, stores, new MyDataModule(context.database), images, { fetchImplementation });

    try {
      const products = await module.listOnlineProducts({ storeId, visibility: "VISIBLE" });
      expect(products).toHaveLength(1);
      expect(products[0]).toMatchObject({
        productId: "product-visible",
        sku: "sku-visible",
        sales30d: 3,
        createdAt: "2026-10-20T12:00:00Z",
      });
    } finally {
      context.cleanup();
    }
  });
});
