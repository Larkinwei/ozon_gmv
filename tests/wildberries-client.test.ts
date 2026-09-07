import { describe, expect, it, vi } from "vitest";

import { WildberriesClient } from "../src/server/wildberries/client";
import { normalizeWildberriesOrders, normalizeWildberriesSales } from "../src/server/wildberries/normalize";

describe("Wildberries API client", () => {
  it("uses the statistics and finance domains with a bearer token", async () => {
    const requests: Array<{ url: string; authorization: string }> = [];
    const fetchImplementation = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") ?? "" });
      if (url.includes("account/balance")) {
        return new Response(JSON.stringify({ currency: "RUB", current: "125.50", for_withdraw: "80.00" }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    const client = new WildberriesClient({ apiToken: "wb-token", fetchImplementation, maxAttempts: 1 });

    await client.getOrders(new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z"));
    await client.getSales(new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-02T00:00:00.000Z"));
    await expect(client.getBalance()).resolves.toMatchObject({ current: "125.50", currency: "RUB" });

    expect(requests).toEqual([
      { url: "https://statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=2026-08-01&flag=0", authorization: "Bearer wb-token" },
      { url: "https://statistics-api.wildberries.ru/api/v1/supplier/sales?dateFrom=2026-08-01&flag=0", authorization: "Bearer wb-token" },
      { url: "https://finance-api.wildberries.ru/api/v1/account/balance", authorization: "Bearer wb-token" },
    ]);
  });

  it("retries rate limits and preserves permission errors", async () => {
    let attempts = 0;
    const fetchImplementation = (async () => {
      attempts += 1;
      if (attempts === 1) return new Response("busy", { status: 429, headers: { "X-RateLimit-Retry": "0" } });
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    const client = new WildberriesClient({ apiToken: "wb-token", fetchImplementation, maxAttempts: 2 });
    await expect(client.getOrders(new Date("2026-08-01"), new Date("2026-08-02"))).resolves.toEqual([]);
    expect(attempts).toBe(2);

    const denied = new WildberriesClient({
      apiToken: "wb-token",
      fetchImplementation: (async () => new Response("denied", { status: 403 })) as typeof fetch,
      maxAttempts: 1,
    });
    await expect(denied.getBalance()).rejects.toMatchObject({ status: 403, retryable: false });
  });

  it("falls back to a direct request when the configured proxy cannot reach WB", async () => {
    const proxyFetch = vi.fn(async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    const directFetch = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer wb-token");
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    const client = new WildberriesClient({
      apiToken: "wb-token",
      fetchImplementation: proxyFetch,
      directFetchImplementation: directFetch,
      maxAttempts: 1,
    });

    await expect(client.getOrders(new Date("2026-08-01"), new Date("2026-08-02"))).resolves.toEqual([]);
    expect(proxyFetch).toHaveBeenCalledTimes(1);
    expect(directFetch).toHaveBeenCalledTimes(1);
  });
});

describe("Wildberries report normalization", () => {
  it("groups item rows by srid and keeps returns as negative sales facts", () => {
    const orders = normalizeWildberriesOrders([
      { srid: "order-1", date: "2026-08-18T10:00:00Z", totalPrice: 100, barcode: "111", supplierArticle: "A", subject: "商品 A" },
      { srid: "order-1", date: "2026-08-18T10:00:00Z", totalPrice: 50, barcode: "222", supplierArticle: "B", subject: "商品 B" },
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ externalOrderId: "order-1", grossAmount: "150.00" });
    expect(orders[0]?.items).toHaveLength(2);

    const sales = normalizeWildberriesSales([
      { saleID: "sale-1", srid: "order-1", date: "2026-08-18T10:00:00Z", forPay: 120, barcode: "111", supplierArticle: "A", subject: "商品 A" },
      { saleID: "return-1", srid: "order-1", date: "2026-08-19T10:00:00Z", forPay: 20, isStorno: true, barcode: "111", supplierArticle: "A", subject: "商品 A" },
    ]);
    expect(sales.map((sale) => sale.factType)).toEqual(["sale", "return"]);
    expect(sales[1]?.amount).toBe("20.00");
  });
});
