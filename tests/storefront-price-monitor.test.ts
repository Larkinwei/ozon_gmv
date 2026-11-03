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

    expect(result).toEqual({ sku: "123456789", greenPrice: "1254.00", blackPrice: "1350.00", frontCurrencyCode: "RUB" });
  });

  it("does not invent a SKU or price when public page fields are absent", () => {
    expect(parseOzonStorefrontPricePayload({ widgetStates: {} })).toEqual({ sku: null, greenPrice: null, blackPrice: null, frontCurrencyCode: null });
  });

  it("parses the compact result returned by the browser collector", () => {
    expect(parseOzonStorefrontPricePayload({ sku: "123456789", greenPrice: "1 254,00 ₽", blackPrice: 1350 }))
      .toEqual({ sku: "123456789", greenPrice: "1254.00", blackPrice: "1350.00", frontCurrencyCode: "RUB" });
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
    expect(service.listLatest({ storeId: "store-1", search: "", page: 1, pageSize: 20, frontPrice: "all", difference: "all", sort: "latest", rubPerCny: 100 }).items[0])
      .toMatchObject({ sku: "123456789", greenPrice: "1254.00", blackPrice: "1350.00" });
  });

  it("filters and sorts latest snapshots by normalized front-price difference", () => {
    const context = createContext();
    const service = new StorefrontPriceMonitorService(context.database);
    const records = [
      { sku: "100000001", label: "sku-low", green: "90", backend: "100" },
      { sku: "100000002", label: "sku-high", green: "120", backend: "100" },
      { sku: "100000003", label: "sku-equal", green: "100", backend: "100" },
    ];

    records.forEach((record, index) => {
      const job = service.createJob({ id: "store-1", name: "店铺 A" }, [{
        productId: `product-${index}`,
        sku: record.sku,
        offerId: `offer-${index}`,
        productName: `商品 ${index}`,
        imageUrl: null,
        backendPrice: record.backend,
        currencyCode: "RUB",
      }]);
      service.recordBrowserResult(job.id, job.items[0]!.id, {
        sku: record.sku,
        greenPrice: record.green,
        blackPrice: record.green,
        currencyCode: "RUB",
      }, null);
    });

    const common = { storeId: "store-1", search: "", page: 1, pageSize: 20, frontPrice: "all" as const, rubPerCny: 100 };
    expect(service.listLatest({ ...common, difference: "higher", sort: "latest" }).items.map((item) => item.sku)).toEqual(["100000002"]);
    expect(service.listLatest({ ...common, difference: "all", sort: "differenceAsc" }).items.map((item) => item.sku)).toEqual(["100000003", "100000001", "100000002"]);
    expect(service.listLatest({ ...common, difference: "all", sort: "differenceDesc" }).items.map((item) => item.sku)).toEqual(["100000002", "100000001", "100000003"]);
    expect(service.listLatest({ ...common, difference: "all", sort: "discountDesc" }).items.map((item) => item.sku)).toEqual(["100000002", "100000001", "100000003"]);
    expect(service.listLatest({ ...common, difference: "all", sort: "discountAsc" }).items.map((item) => item.sku)).toEqual(["100000003", "100000001", "100000002"]);
    expect(service.listLatest({ ...common, difference: "all", sort: "discountDesc" }).items.map((item) => item.discountRate)).toEqual([20, 10, 0]);
    expect(service.listLatest({ ...common, difference: "all", sort: "greenDesc" }).items.map((item) => item.sku)).toEqual(["100000002", "100000003", "100000001"]);
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

  it("retries every failed or empty-price item in one job", () => {
    const context = createContext();
    const service = new StorefrontPriceMonitorService(context.database);
    const job = service.createJob({ id: "store-1", name: "店铺 A" }, ["123456789", "987654321", "456789123"].map((sku, index) => ({
      productId: `product-${index}`,
      sku,
      offerId: `offer-${index}`,
      productName: `商品 ${index}`,
      imageUrl: null,
      backendPrice: "100.00",
      currencyCode: "RUB",
    })));
    service.recordBrowserResult(job.id, job.items[0]!.id, null, "OpenCLI 采集失败");
    service.recordBrowserResult(job.id, job.items[1]!.id, { sku: "987654321", greenPrice: null, blackPrice: null }, null);
    service.recordBrowserResult(job.id, job.items[2]!.id, { sku: "456789123", greenPrice: "90.00", blackPrice: "100.00", currencyCode: "RUB" }, null);

    const retried = service.retryFailedItems(job.id);

    expect(retried?.retriedCount).toBe(2);
    expect(service.listQueuedItems(job.id)).toEqual([
      { id: job.items[0]!.id, sku: "123456789" },
      { id: job.items[1]!.id, sku: "987654321" },
    ]);
    expect(service.getJob(job.id)?.items.find((item) => item.id === job.items[2]!.id)?.status).toBe("success");
  });
});
