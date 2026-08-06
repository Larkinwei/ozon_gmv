import { describe, expect, it } from "vitest";

import { DashboardRepository } from "../src/server/db/dashboard-repository";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import type { NormalizedPosting } from "../src/server/ozon/normalize";
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
});
