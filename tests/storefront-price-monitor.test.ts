import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabaseContext } from "./test-context";
import { StorefrontPriceMonitorService, parseOzonStorefrontPricePayload } from "../src/server/services/storefront-price-monitor";

const contexts: TestDatabaseContext[] = [];

function createContext(): TestDatabaseContext {
  const context = createTestDatabase();
  contexts.push(context);
  context.database.prepare(
    `INSERT INTO stores (id, name, client_id, api_key_ciphertext, webhook_token_hash, color, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("store-1", "店铺 A", "client-1", "cipher", "token-hash", "#123456", Date.now(), Date.now());
  return context;
}

afterEach(() => {
  while (contexts.length) contexts.pop()!.cleanup();
});

describe("Ozon storefront price monitor", () => {
  it("parses green/black prices only when it can verify the product SKU", () => {
    const result = parseOzonStorefrontPricePayload({
      widgetStates: {
        "webPrice-abc": JSON.stringify({ cardPrice: "1 254 ₽", price: "1 350 ₽" }),
        "webDetailSKU-abc": JSON.stringify({ copyText: "123456789" }),
      },
    });

    expect(result).toEqual({ sku: "123456789", greenPrice: "1254.00", blackPrice: "1350.00" });
  });

  it("does not invent a SKU or price when public page fields are absent", () => {
    expect(parseOzonStorefrontPricePayload({ widgetStates: {} })).toEqual({ sku: null, greenPrice: null, blackPrice: null });
  });

  it("parses the compact result returned by the browser collector", () => {
    expect(parseOzonStorefrontPricePayload({ sku: "123456789", greenPrice: "1 254,00 ₽", blackPrice: 1350 }))
      .toEqual({ sku: "123456789", greenPrice: "1254.00", blackPrice: "1350.00" });
  });

  it("returns paged job items and requeues interrupted work on service restart", async () => {
    const context = createContext();
    const service = new StorefrontPriceMonitorService(context.database);
    const job = service.createJob({ id: "store-1", name: "店铺 A" }, [1, 2, 3].map((sku) => ({
      productId: `product-${sku}`,
      sku: String(sku),
      offerId: `offer-${sku}`,
      productName: `商品 ${sku}`,
      imageUrl: null,
      backendPrice: "100.00",
      currencyCode: "RUB",
    })));
    service.setJobState(job.id, "pause");

    expect(service.getJob(job.id, 2, 1)?.items.map((item) => item.sku)).toEqual(["2"]);
    context.database.prepare("UPDATE storefront_price_jobs SET status = 'running' WHERE id = ?").run(job.id);
    context.database.prepare("UPDATE storefront_price_job_items SET status = 'running' WHERE job_id = ? AND sku = '2'").run(job.id);
    const restartedService = new StorefrontPriceMonitorService(context.database);
    const recovered = restartedService.getJob(job.id, 1, 3);

    expect(recovered?.status).toBe("queued");
    expect(recovered?.items.find((item) => item.sku === "2")?.status).toBe("queued");
    await service.stop();
    await restartedService.stop();
  });

  it("records SKU-bound browser prices and persists a history snapshot", () => {
    const context = createContext();
    const service = new StorefrontPriceMonitorService(context.database);
    const job = service.createJob({ id: "store-1", name: "店铺 A" }, [{
      productId: "product-1",
      sku: "123456789",
      offerId: "offer-1",
      productName: "商品 1",
      imageUrl: null,
      backendPrice: "1400.00",
      currencyCode: "RUB",
    }]);
    const itemId = job.items[0]!.id;

    expect(service.recordBrowserResult(job.id, itemId, { sku: "123456789", greenPrice: "1254", blackPrice: "1350" }, null)).toBe(true);
    expect(service.getJob(job.id)?.items[0]).toMatchObject({ status: "success", greenPrice: "1254.00", blackPrice: "1350.00" });
    expect(service.listHistory("store-1", "product-1")).toHaveLength(1);
    expect(service.listLatest({ storeId: "store-1", search: "", page: 1, pageSize: 20 }).items[0])
      .toMatchObject({ sku: "123456789", greenPrice: "1254.00", blackPrice: "1350.00" });
  });

  it("allows failed items to be retried or deleted without touching successful rows", () => {
    const context = createContext();
    const service = new StorefrontPriceMonitorService(context.database);
    const job = service.createJob({ id: "store-1", name: "店铺 A" }, ["123456789", "987654321"].map((sku, index) => ({
      productId: `product-${index}`,
      sku,
      offerId: `offer-${index}`,
      productName: `商品 ${index}`,
      imageUrl: null,
      backendPrice: "100.00",
      currencyCode: "RUB",
    })));
    const first = job.items[0]!;
    const second = job.items[1]!;
    service.recordBrowserResult(job.id, first.id, null, "Ozon 前台请求失败（HTTP 403）");
    service.recordBrowserResult(job.id, second.id, { sku: "987654321", greenPrice: null, blackPrice: null }, null);

    const retried = service.retryItem(job.id, first.id);
    expect(retried?.item).toEqual({ id: first.id, sku: "123456789" });
    expect(service.listQueuedItems(job.id)).toEqual([{ id: first.id, sku: "123456789" }]);
    expect(service.deleteFailedItem(job.id, second.id)?.totalCount).toBe(1);
    expect(service.getJob(job.id)?.items[0]).toMatchObject({ id: first.id, status: "queued" });
  });
});
