import { describe, expect, it } from "vitest";

import { buildDashboardSeries } from "../src/server/domain/dashboard-series";
import { calculatePostingGmv } from "../src/server/domain/money";
import { resolveDashboardWindow, splitIntoSyncWindows } from "../src/server/domain/time-range";
import { normalizePosting } from "../src/server/ozon/normalize";
import { decryptSecret, encryptSecret } from "../src/server/security/encryption";
import { millisecondsUntilNextNightlyRun } from "../src/server/services/scheduler";

describe("GMV domain behavior", () => {
  it("calculates order GMV with exact decimal arithmetic", () => {
    const result = calculatePostingGmv([
      { price: "1299.90", quantity: 2, currency: "RUB" },
      { price: "350.10", quantity: 1, currency: "RUB" },
    ]);

    expect(result).toEqual({ amount: "2949.90", currency: "RUB" });
  });

  it("starts today at Beijing midnight while storing UTC", () => {
    const now = new Date("2026-08-05T16:30:00.000Z");
    const window = resolveDashboardWindow("today", now);

    expect(window.from.toISOString()).toBe("2026-08-05T16:00:00.000Z");
    expect(window.to.toISOString()).toBe("2026-08-05T16:30:00.000Z");
    expect(window.granularity).toBe("15m");
  });

  it("fills every daily bucket in a 30-day dashboard series", () => {
    const window = resolveDashboardWindow("30d", new Date("2026-08-05T06:00:00.000Z"));
    const series = buildDashboardSeries(
      [
        {
          bucket: new Date("2026-07-08T16:00:00.000Z"),
          storeId: "store-a",
          storeName: "店铺 A",
          storeColor: "#3B82F6",
          currency: "CNY",
          orders: 1,
          gmv: "42.00",
        },
        {
          bucket: new Date("2026-08-03T16:00:00.000Z"),
          storeId: "store-a",
          storeName: "店铺 A",
          storeColor: "#3B82F6",
          currency: "CNY",
          orders: 2,
          gmv: "84.00",
        },
      ],
      window,
    );

    expect(series).toHaveLength(30);
    expect(series[0]).toMatchObject({ bucket: "2026-07-06T16:00:00.000Z", label: "07-07", orders: 0 });
    expect(series.find((point) => point.label === "07-10")).toMatchObject({
      orders: 0,
      gmv: [{ amount: "0.00", currency: "CNY" }],
    });
    expect(series.at(-1)).toMatchObject({ bucket: "2026-08-04T16:00:00.000Z", label: "08-05", orders: 0 });
  });

  it("keeps per-store totals, zero buckets, and currencies isolated", () => {
    const window = {
      from: new Date("2026-08-01T16:00:00.000Z"),
      to: new Date("2026-08-04T16:00:00.000Z"),
      granularity: "day" as const,
    };
    const series = buildDashboardSeries(
      [
        {
          bucket: new Date("2026-08-01T16:00:00.000Z"),
          storeId: "store-a",
          storeName: "店铺 A",
          storeColor: "#3B82F6",
          currency: "RUB",
          orders: 2,
          gmv: "120.50",
        },
        {
          bucket: new Date("2026-08-01T16:00:00.000Z"),
          storeId: "store-b",
          storeName: "店铺 B",
          storeColor: "#22C55E",
          currency: "RUB",
          orders: 3,
          gmv: "250.25",
        },
        {
          bucket: new Date("2026-08-03T16:00:00.000Z"),
          storeId: "store-b",
          storeName: "店铺 B",
          storeColor: "#22C55E",
          currency: "CNY",
          orders: 1,
          gmv: "42.00",
        },
      ],
      window,
    );

    expect(series).toHaveLength(3);
    expect(series[0]).toMatchObject({
      orders: 5,
      gmv: [
        { amount: "0.00", currency: "CNY" },
        { amount: "370.75", currency: "RUB" },
      ],
    });
    expect(series[0]?.stores).toEqual([
      {
        storeId: "store-a",
        storeName: "店铺 A",
        color: "#3B82F6",
        orders: 2,
        gmv: [
          { amount: "0.00", currency: "CNY" },
          { amount: "120.50", currency: "RUB" },
        ],
      },
      {
        storeId: "store-b",
        storeName: "店铺 B",
        color: "#22C55E",
        orders: 3,
        gmv: [
          { amount: "0.00", currency: "CNY" },
          { amount: "250.25", currency: "RUB" },
        ],
      },
    ]);
    expect(series[1]).toMatchObject({ orders: 0 });
    expect(series[1]?.stores.every((store) => store.orders === 0)).toBe(true);
    expect(series[2]).toMatchObject({
      orders: 1,
      gmv: [
        { amount: "42.00", currency: "CNY" },
        { amount: "0.00", currency: "RUB" },
      ],
    });
  });

  it("splits a 15 day backfill into bounded seven-day windows", () => {
    const windows = splitIntoSyncWindows(
      new Date("2026-07-01T00:00:00.000Z"),
      new Date("2026-07-16T00:00:00.000Z"),
    );

    expect(windows.map((window) => [window.from.toISOString(), window.to.toISOString()])).toEqual([
      ["2026-07-01T00:00:00.000Z", "2026-07-08T00:00:00.000Z"],
      ["2026-07-08T00:00:00.000Z", "2026-07-15T00:00:00.000Z"],
      ["2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z"],
    ]);
  });

  it("normalizes FBS v4 money and does not retain buyer fields", () => {
    const posting = normalizePosting(
      {
        posting_number: "24219509-0020-1",
        order_number: "24219509-0020",
        in_process_at: "2026-08-05T10:00:00.000Z",
        status: "awaiting_packaging",
        delivery_schema: "FBS",
        products: [
          {
            sku: 147451959,
            offer_id: "BAG-01",
            name: "Travel bag",
            quantity: 2,
            price: { amount: "1499.95", currency: "RUB" },
          },
        ],
      },
      "FBS",
    );

    expect(posting.grossAmount).toBe("2999.90");
    expect(posting.fulfillmentMode).toBe("FBS");
    expect(posting).not.toHaveProperty("customer");
    expect(posting).not.toHaveProperty("analytics_data");
  });

  it("round-trips an API key through AES-256-GCM without exposing plaintext", () => {
    const key = "a".repeat(64);
    const plaintext = "seller-api-secret";
    const encrypted = encryptSecret(plaintext, key);

    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted, key)).toBe(plaintext);
  });

  it("schedules the nightly reconciliation for 03:00 Beijing time", () => {
    const beijingMidnight = new Date("2026-08-05T16:00:00.000Z");

    expect(millisecondsUntilNextNightlyRun(beijingMidnight)).toBe(3 * 60 * 60 * 1000);
  });
});
