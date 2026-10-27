import { describe, expect, it, vi } from "vitest";

import { DashboardRepository } from "../src/server/db/dashboard-repository";
import { MarketplaceRepository } from "../src/server/db/marketplace-repository";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import type { NormalizedPosting } from "../src/server/ozon/normalize";
import type { WildberriesOrder, WildberriesSale } from "../src/server/wildberries/normalize";
import { createTestDatabase } from "./test-context";

const STORE_A_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100011";
const STORE_B_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100012";

function posting(number: string, orderAt: string, amount: string, currency: string): NormalizedPosting {
  return {
    postingNumber: number,
    orderNumber: number.slice(0, number.lastIndexOf("-")),
    fulfillmentMode: "FBS",
    orderAt: new Date(orderAt),
    status: "awaiting_packaging",
    substatus: null,
    grossAmount: amount,
    currency,
    cancelledAt: null,
    shipmentDeadlineAt: null,
    shipmentDeadlineSource: "missing",
    items: [{
      sku: `sku-${number}`,
      offerId: `offer-${number}`,
      name: `商品 ${number}`,
      quantity: 1,
      unitPrice: amount,
      currency,
    }],
  };
}

describe("Dashboard store time series", () => {
  it("compares today with the same Beijing-time window and scopes status counts to the selected range", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-02T04:00:00.000Z")); // Beijing noon.
    const context = createTestDatabase();
    try {
      await new StoresRepository(context.database).create({
        id: STORE_A_ID,
        name: "店铺 A",
        clientId: "client-a",
        apiKeyCiphertext: "cipher-a",
        color: "#3B82F6",
        fulfillmentModes: ["FBS"],
        apiKeyExpiresAt: null,
      });

      const current = posting("today-current", "2026-08-02T03:00:00.000Z", "100.00", "RUB");
      current.items[0]!.sku = "popular-sku";
      current.items[0]!.offerId = "offer-today";
      current.items[0]!.quantity = 2;
      const sameYesterdayWindow = posting("yesterday-same", "2026-08-01T03:00:00.000Z", "90.00", "RUB");
      sameYesterdayWindow.items[0]!.sku = "popular-sku";
      sameYesterdayWindow.items[0]!.offerId = "offer-yesterday";
      sameYesterdayWindow.items[0]!.quantity = 3;
      const currentSecondOffer = posting("today-second-offer", "2026-08-02T03:30:00.000Z", "95.00", "RUB");
      currentSecondOffer.items[0]!.sku = "popular-sku";
      currentSecondOffer.items[0]!.offerId = "offer-today-second";
      currentSecondOffer.items[0]!.quantity = 3;
      const wrongYesterdayWindow = posting("yesterday-other", "2026-08-01T10:00:00.000Z", "80.00", "RUB");
      const overdue = posting("overdue", "2026-07-20T03:00:00.000Z", "70.00", "RUB");
      overdue.shipmentDeadlineAt = new Date("2026-07-20T04:00:00.000Z");
      overdue.shipmentDeadlineSource = "shipment_date";
      const futureDeadline = posting("future-deadline", "2026-07-21T03:00:00.000Z", "60.00", "RUB");
      futureDeadline.shipmentDeadlineAt = new Date("2026-08-03T00:00:00.000Z");
      futureDeadline.shipmentDeadlineSource = "shipment_date";
      const missingDeadline = posting("missing-deadline", "2026-07-22T03:00:00.000Z", "50.00", "RUB");
      const olderThanThirtyDays = posting("old-order", "2026-06-01T03:00:00.000Z", "40.00", "RUB");

      const postings = new PostingsRepository(context.database);
      for (const item of [current, sameYesterdayWindow, currentSecondOffer, wrongYesterdayWindow, overdue, futureDeadline, missingDeadline, olderThanThirtyDays]) {
        await postings.upsert(STORE_A_ID, item);
      }
      new ProductImagesRepository(context.database).saveBatch(STORE_A_ID, [{
        sku: "popular-sku",
        offerId: "offer-today",
        imageUrl: "https://cdn.example.com/popular.jpg",
      }], Date.now());

      const snapshot = await new DashboardRepository(context.database).getSnapshot("today", {
        from: new Date("2026-08-01T16:00:00.000Z"),
        to: new Date("2026-08-02T04:00:00.000Z"),
        granularity: "15m",
      }, []);

      expect(snapshot.kpis.orders).toBe(2);
      expect(snapshot.comparison).toMatchObject({ label: "较昨日同期", previousOrders: 1 });
      expect(snapshot.statusRange).toMatchObject({
        from: "2026-08-01T16:00:00.000Z",
        to: "2026-08-02T04:00:00.000Z",
        label: "今天",
      });
      expect(snapshot.orderStatuses.reduce((total, row) => total + row.count, 0)).toBe(2);
      expect(snapshot.timeDistributionMode).toBe("hourly");
      expect(snapshot.dailyOrders).toEqual([]);
      expect(snapshot.topProducts[0]).toMatchObject({
        sku: "popular-sku",
        imageUrl: "https://cdn.example.com/popular.jpg",
        quantity: 5,
      });
      expect(snapshot.topProducts[0]?.offerIds).toEqual(expect.arrayContaining(["offer-today", "offer-today-second"]));
    } finally {
      context.cleanup();
      vi.useRealTimers();
    }
  });

  it("returns one total-order bar per Beijing date for a multi-day range", async () => {
    const context = createTestDatabase();
    try {
      await new StoresRepository(context.database).create({
        id: STORE_A_ID,
        name: "店铺 A",
        clientId: "client-a",
        apiKeyCiphertext: "cipher-a",
        color: "#3B82F6",
        fulfillmentModes: ["FBS"],
        apiKeyExpiresAt: null,
      });
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_A_ID, posting("monday-order", "2026-08-03T02:00:00.000Z", "10.00", "RUB"));
      await postings.upsert(STORE_A_ID, posting("tuesday-order", "2026-08-04T03:00:00.000Z", "12.00", "RUB"));

      const snapshot = await new DashboardRepository(context.database).getSnapshot("custom", {
        from: new Date("2026-08-02T16:00:00.000Z"),
        to: new Date("2026-08-05T16:00:00.000Z"),
        granularity: "day",
      }, []);

      expect(snapshot.timeDistributionMode).toBe("daily");
      expect(snapshot.dailyOrders).toEqual([
        { day: "2026-08-03", orders: 1 },
        { day: "2026-08-04", orders: 1 },
        { day: "2026-08-05", orders: 0 },
      ]);
    } finally {
      context.cleanup();
    }
  });

  it("searches local Ozon orders by order number, product name, SKU, and date", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({
        id: STORE_A_ID,
        name: "Ozon 店铺",
        clientId: "client-ozon",
        apiKeyCiphertext: "cipher-ozon",
        color: "#3B82F6",
        fulfillmentModes: ["FBS"],
        apiKeyExpiresAt: null,
      });
      await stores.create({
        id: STORE_B_ID,
        name: "WB 店铺",
        platform: "wildberries",
        clientId: "",
        apiKeyCiphertext: "cipher-wb",
        color: "#F59E0B",
        fulfillmentModes: [],
        apiKeyExpiresAt: null,
      });

      const target = posting("100-0001-1", "2026-08-02T10:00:00.000Z", "100.50", "RUB");
      target.orderNumber = "buyer-order-42";
      target.items[0]!.name = "蓝色旅行收纳包";
      target.items[0]!.sku = "sku-blue-42";
      target.items[0]!.offerId = "offer-blue-42";
      const older = posting("100-0002-1", "2026-06-01T10:00:00.000Z", "200.25", "RUB");
      const wildberriesPosting = posting("200-0001-1", "2026-08-02T11:00:00.000Z", "300.00", "RUB");
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_A_ID, target);
      await postings.upsert(STORE_A_ID, older);
      await postings.upsert(STORE_B_ID, wildberriesPosting);
      new ProductImagesRepository(context.database).saveBatch(STORE_A_ID, [{ sku: "sku-blue-42", offerId: "offer-blue-42", imageUrl: "https://cdn.example.com/blue.jpg" }], Date.now());

      const repository = new DashboardRepository(context.database);
      const window = { from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-03T00:00:00.000Z") };
      const byOrderNumber = repository.searchOzonOrders({ ...window, q: "buyer-order-42", page: 1, pageSize: 20 });
      expect(byOrderNumber.total).toBe(1);
      expect(byOrderNumber.items[0]).toMatchObject({ postingNumber: "100-0001-1", orderNumber: "buyer-order-42", platform: "ozon" });
      expect(byOrderNumber.items[0]?.imageUrl).toBe("https://cdn.example.com/blue.jpg");

      const byProduct = repository.searchOzonOrders({ ...window, q: "蓝色旅行", page: 1, pageSize: 20 });
      expect(byProduct.items).toHaveLength(1);
      const bySku = repository.searchOzonOrders({ ...window, q: "sku-blue-42", page: 1, pageSize: 20 });
      expect(bySku.items[0]?.skus).toEqual(["sku-blue-42"]);
      const byOfferId = repository.searchOzonOrders({ ...window, q: "offer-blue-42", page: 1, pageSize: 20 });
      expect(byOfferId.items[0]?.offerIds).toEqual(["offer-blue-42"]);

      const page = repository.searchOzonOrders({ from: new Date("2026-05-01T00:00:00.000Z"), to: new Date("2026-09-01T00:00:00.000Z"), page: 1, pageSize: 1 });
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.postingNumber).toBe("100-0001-1");
    } finally {
      context.cleanup();
    }
  });

  it("groups each bucket by store and keeps store filters exact", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({
        id: STORE_A_ID,
        name: "店铺 A",
        clientId: "client-a",
        apiKeyCiphertext: "cipher-a",
        color: "#3B82F6",
        fulfillmentModes: ["FBS"],
        apiKeyExpiresAt: null,
      });
      await stores.create({
        id: STORE_B_ID,
        name: "店铺 B",
        clientId: "client-b",
        apiKeyCiphertext: "cipher-b",
        color: "#22C55E",
        fulfillmentModes: ["FBS"],
        apiKeyExpiresAt: null,
      });

      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_A_ID, posting("100-0001-1", "2026-08-02T10:00:00.000Z", "100.50", "RUB"));
      await postings.upsert(STORE_B_ID, posting("200-0001-1", "2026-08-02T11:00:00.000Z", "200.25", "RUB"));
      await postings.upsert(STORE_B_ID, posting("200-0002-1", "2026-08-03T11:00:00.000Z", "42.00", "CNY"));

      const repository = new DashboardRepository(context.database);
      const window = {
        from: new Date("2026-08-01T16:00:00.000Z"),
        to: new Date("2026-08-04T16:00:00.000Z"),
        granularity: "day" as const,
      };
      const allStores = await repository.getSnapshot("custom", window, []);
      expect(allStores.timeSeries[0]).toMatchObject({
        label: "08-02",
        orders: 2,
        gmv: [
          { amount: "0.00", currency: "CNY" },
          { amount: "300.75", currency: "RUB" },
        ],
      });
      expect(allStores.timeSeries[0]?.stores.map((store) => ({
        name: store.storeName,
        orders: store.orders,
        rub: store.gmv.find((money) => money.currency === "RUB")?.amount,
      }))).toEqual([
        { name: "店铺 A", orders: 1, rub: "100.50" },
        { name: "店铺 B", orders: 1, rub: "200.25" },
      ]);

      const storeA = await repository.getSnapshot("custom", window, [STORE_A_ID]);
      expect(storeA.kpis.orders).toBe(1);
      expect(storeA.timeSeries.every((point) => point.stores.length === 1)).toBe(true);
      expect(storeA.timeSeries[0]?.stores[0]).toMatchObject({ storeId: STORE_A_ID, orders: 1 });
    } finally {
      context.cleanup();
    }
  });

  it("combines Ozon and WB while keeping sales GMV separate from order counts", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({
        id: STORE_A_ID,
        name: "Ozon 店铺",
        clientId: "client-ozon",
        apiKeyCiphertext: "cipher-ozon",
        color: "#3B82F6",
        fulfillmentModes: ["FBS"],
        apiKeyExpiresAt: null,
      });
      await stores.create({
        id: STORE_B_ID,
        name: "WB 店铺",
        platform: "wildberries",
        clientId: "",
        apiKeyCiphertext: "cipher-wb",
        color: "#F59E0B",
        fulfillmentModes: [],
        apiKeyExpiresAt: null,
      });
      await new PostingsRepository(context.database).upsert(STORE_A_ID, posting("ozon-1", "2026-08-02T10:00:00.000Z", "100.00", "RUB"));
      const marketplace = new MarketplaceRepository(context.database);
      const wbOrder: WildberriesOrder = {
        externalOrderId: "wb-order-1",
        orderNumber: "wb-order-1",
        fulfillmentMode: "WB",
        orderAt: new Date("2026-08-02T11:00:00.000Z"),
        status: "ORDERED",
        substatus: null,
        grossAmount: "150.00",
        currency: "RUB",
        cancelledAt: null,
        items: [{ sku: "111", offerId: "WB-A", name: "WB 商品", quantity: 1, unitPrice: "150.00", currency: "RUB" }],
        rawJson: "{}",
      };
      const wbSale: WildberriesSale = {
        externalSaleId: "wb-sale-1",
        sourceOrderId: "wb-order-1",
        saleAt: new Date("2026-08-02T11:00:00.000Z"),
        factType: "sale",
        amount: "130.00",
        currency: "RUB",
        sku: "111",
        offerId: "WB-A",
        name: "WB 商品",
        quantity: 1,
        rawJson: "{}",
      };
      await marketplace.upsertOrder(STORE_B_ID, wbOrder);
      await marketplace.upsertSale(STORE_B_ID, wbSale);

      const snapshot = await new DashboardRepository(context.database).getSnapshot("custom", {
        from: new Date("2026-08-01T16:00:00.000Z"),
        to: new Date("2026-08-03T16:00:00.000Z"),
        granularity: "day",
      }, []);
      expect(snapshot.kpis.orders).toBe(2);
      expect(snapshot.kpis.gmv).toEqual([{ amount: "230.00", currency: "RUB" }]);
      expect(snapshot.platforms).toEqual([
        { platform: "ozon", orders: 1, gmv: [{ amount: "100.00", currency: "RUB" }] },
        { platform: "wildberries", orders: 1, gmv: [{ amount: "130.00", currency: "RUB" }] },
      ]);
      expect(snapshot.recentOrders.map((order) => order.platform)).toEqual(["wildberries", "ozon"]);
    } finally {
      context.cleanup();
    }
  });
});
