import { describe, expect, it } from "vitest";

import { OzonClient } from "../src/server/ozon/client";

function posting(postingNumber: string): Record<string, unknown> {
  return {
    posting_number: postingNumber,
    order_number: postingNumber.slice(0, -2),
    in_process_at: "2026-08-05T10:00:00.000Z",
    status: "awaiting_packaging",
    products: [
      {
        sku: 1001,
        offer_id: "SKU-1001",
        name: "Test product",
        quantity: 1,
        price: { amount: "1990.00", currency: "RUB" },
      },
    ],
  };
}

describe("Ozon Seller API client", () => {
  it("queries product cards by seller SKU using the current v3 contract", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        items: [{
          offer_id: "SKU-1001",
          images: ["https://cdn.example.com/fallback.jpg"],
          primary_image: ["https://cdn.example.com/primary.jpg"],
          sources: [{ sku: 1001 }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new OzonClient({
      clientId: "client",
      apiKey: "secret",
      baseUrl: "https://api-seller.ozon.ru",
      fetchImplementation,
      maxAttempts: 1,
    });

    const products = await client.getProductInfo(["1001"]);

    expect(requestUrl).toBe("https://api-seller.ozon.ru/v3/product/info/list");
    expect(requestBody).toEqual({ sku: ["1001"] });
    expect(products[0]?.primary_image[0]).toBe("https://cdn.example.com/primary.jpg");
  });

  it("uses the official page size for each posting endpoint", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const fetchImplementation = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ postings: [], cursor: null, has_next: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new OzonClient({
      clientId: "client",
      apiKey: "secret",
      baseUrl: "https://api-seller.ozon.ru",
      fetchImplementation,
      maxAttempts: 1,
    });

    for await (const _page of client.iteratePostingPages(
      "FBO",
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-05T00:00:00.000Z"),
    )) {
      // Iteration captures the outgoing FBO request body.
    }
    for await (const _page of client.iteratePostingPages(
      "FBS",
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-05T00:00:00.000Z"),
    )) {
      // Iteration captures the outgoing FBS request body.
    }

    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({ limit: 100 });
    expect(requestBodies[1]).toMatchObject({ limit: 100 });
  });

  it("follows the current cursor pagination contract", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let requestIndex = 0;
    const responses = [
      { postings: [posting("100-0001-1")], cursor: "next-cursor", has_next: true },
      { postings: [posting("100-0002-1")], cursor: "terminal-cursor", has_next: false },
    ];
    const fetchImplementation = (async (_input: URL | RequestInfo, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const body = responses[requestIndex];
      requestIndex += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new OzonClient({
      clientId: "client",
      apiKey: "secret",
      baseUrl: "https://api-seller.ozon.ru",
      fetchImplementation,
      maxAttempts: 1,
    });

    const postingNumbers: string[] = [];
    for await (const page of client.iteratePostingPages(
      "FBS",
      new Date("2026-08-01T00:00:00.000Z"),
      new Date("2026-08-05T00:00:00.000Z"),
    )) {
      postingNumbers.push(...page.postings.map((item) => item.posting_number));
    }

    expect(postingNumbers).toEqual(["100-0001-1", "100-0002-1"]);
    expect(requestBodies[0]).not.toHaveProperty("cursor");
    expect(requestBodies[1]).toMatchObject({ cursor: "next-cursor" });
    expect(requestBodies).toHaveLength(2);
  });

  it("retries a rate-limited request using Retry-After", async () => {
    let attempts = 0;
    const fetchImplementation = (async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      return new Response(JSON.stringify({ expires_at: null, roles: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const client = new OzonClient({
      clientId: "client",
      apiKey: "secret",
      baseUrl: "https://api-seller.ozon.ru",
      fetchImplementation,
      maxAttempts: 2,
    });

    await expect(client.getRoles()).resolves.toEqual({ expires_at: null, roles: [] });
    expect(attempts).toBe(2);
  });

  it("creates a target offer and configures its price and stock", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      let payload: Record<string, unknown> = {};
      if (url.endsWith("/v1/product/import-by-sku")) {
        payload = { result: { task_id: 123, unmatched_sku_list: [] } };
      } else if (url.endsWith("/v1/product/import/info")) {
        payload = { result: { items: [{ offer_id: "MY-1001", product_id: 456, status: "imported", errors: [] }] } };
      } else if (url.endsWith("/v2/warehouse/list")) {
        payload = { warehouses: [{ warehouse_id: 7, name: "Москва", status: "active" }] };
      } else if (url.endsWith("/v4/product/info/limit")) {
        payload = { daily_create_remaining: 20, total_product_limit: 1000 };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new OzonClient({ clientId: "client", apiKey: "secret", baseUrl: "https://api-seller.ozon.ru", fetchImplementation, maxAttempts: 1 });

    await expect(client.importProductBySku({ sku: "1001", name: "商品", offerId: "MY-1001", price: "1299", currency: "RUB", vat: "0.2" })).resolves.toEqual({ taskId: "123", unmatchedSkuList: [] });
    await expect(client.getProductImportInfo("123")).resolves.toEqual([{ offerId: "MY-1001", productId: "456", status: "imported", errors: [], warnings: [] }]);
    await expect(client.getWarehouses()).resolves.toEqual([{ id: "7", name: "Москва", status: "active" }]);
    await expect(client.getProductInfoLimit()).resolves.toEqual({ dailyCreateRemaining: 20, totalProductLimit: 1000 });
    await expect(client.updateProductPrice({ offerId: "MY-1001", price: "1299", currency: "RUB", vat: "0.2" })).resolves.toBeUndefined();
    await expect(client.updateProductStock({ offerId: "MY-1001", productId: "456", warehouseId: "7", stock: 2 })).resolves.toBeUndefined();

    expect(requests.map((request) => request.url)).toEqual([
      "https://api-seller.ozon.ru/v1/product/import-by-sku",
      "https://api-seller.ozon.ru/v1/product/import/info",
      "https://api-seller.ozon.ru/v2/warehouse/list",
      "https://api-seller.ozon.ru/v4/product/info/limit",
      "https://api-seller.ozon.ru/v1/product/import/prices",
      "https://api-seller.ozon.ru/v2/products/stocks",
    ]);
    expect(requests.at(-1)?.body).toMatchObject({ stocks: [{ offer_id: "MY-1001", product_id: "456", warehouse_id: "7", stock: 2 }] });
  });

  it("replaces and verifies the complete ordered product image list", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const payload = String(input).endsWith("/v2/product/pictures/info")
        ? { items: [{ product_id: 456, primary_photo: ["https://cdn.example.com/main.jpg"], photo: ["https://cdn.example.com/sub.jpg"], errors: [] }] }
        : { result: {} };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new OzonClient({ clientId: "client", apiKey: "secret", baseUrl: "https://api-seller.ozon.ru", fetchImplementation, maxAttempts: 1 });

    await client.importProductPictures({ productId: "456", images: ["https://cdn.example.com/main.jpg", "https://cdn.example.com/sub.jpg"] });
    await client.verifyProductPictures("456");

    expect(requests[0]).toMatchObject({
      url: "https://api-seller.ozon.ru/v1/product/pictures/import",
      body: { product_id: 456, images: ["https://cdn.example.com/main.jpg", "https://cdn.example.com/sub.jpg"] },
    });
    expect(requests[1]).toMatchObject({ url: "https://api-seller.ozon.ru/v2/product/pictures/info", body: { product_id: [456] } });
  });
});
