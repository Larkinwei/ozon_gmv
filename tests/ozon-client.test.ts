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

  it("loads the official description category and product type tree", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        result: [{
          description_category_id: 95249,
          category_name: "宠物 товары",
          children: [{ type_name: "动物梳子", type_id: 123456, children: [] }],
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

    const tree = await client.getDescriptionCategoryTree();

    expect(requestUrl).toBe("https://api-seller.ozon.ru/v1/description-category/tree");
    expect(requestBody).toEqual({ language: "DEFAULT" });
    expect(tree[0]?.description_category_id).toBe(95249);
    expect(tree[0]?.children[0]?.type_id).toBe(123456);
  });

  it("loads dynamic required attributes and dictionary values for a target category", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const payload = url.endsWith("/values")
        ? { result: [{ id: 12, value: "Черный" }] }
        : { result: [{ id: 100, name: "Цвет", is_required: true, dictionary_id: 10, is_collection: false }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new OzonClient({ clientId: "client", apiKey: "secret", baseUrl: "https://api-seller.ozon.ru", fetchImplementation, maxAttempts: 1 });

    await expect(client.getDescriptionCategoryAttributes({ descriptionCategoryId: 95249, typeId: 123456 })).resolves.toEqual([{
      id: 100,
      name: "Цвет",
      required: true,
      dictionaryId: 10,
      isCollection: false,
      type: null,
      raw: { id: 100, name: "Цвет", is_required: true, dictionary_id: 10, is_collection: false },
    }]);
    await expect(client.getDescriptionCategoryAttributeValues({ descriptionCategoryId: 95249, typeId: 123456, attributeId: 100 })).resolves.toEqual([{ id: "12", name: "Черный" }]);
    expect(requests[0]?.body).toMatchObject({ description_category_id: 95249, type_id: 123456, language: "DEFAULT" });
  });

  it("searches the official dictionary for the Russian no-brand value", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ result: [{ id: 126745801, value: "Нет бренда" }] }), {
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

    await expect(client.searchDescriptionCategoryAttributeValues({
      descriptionCategoryId: 15621048,
      typeId: 96766,
      attributeId: 31,
      query: "Нет бренда",
    })).resolves.toEqual([{ id: "126745801", name: "Нет бренда" }]);
    expect(requestUrl).toBe("https://api-seller.ozon.ru/v1/description-category/attribute/values/search");
    expect(requestBody).toMatchObject({
      description_category_id: 15621048,
      type_id: 96766,
      attribute_id: 31,
      value: "Нет бренда",
    });
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
        payload = { result: { items: [{ offer_id: "MY-1001", product_id: 456, status: "processed", errors: [] }] } };
      } else if (url.endsWith("/v2/warehouse/list")) {
        payload = { warehouses: [{ warehouse_id: 7, name: "Москва", status: "active" }] };
      } else if (url.endsWith("/v4/product/info/limit")) {
        payload = { daily_create_remaining: 20, total_product_limit: 1000 };
      } else if (url.endsWith("/v2/products/stocks")) {
        payload = { result: { items: [{ offer_id: "MY-1001", product_id: "456", warehouse_id: "7", updated: true, errors: [] }] } };
      } else if (url.endsWith("/v2/product/info/stocks-by-warehouse/fbs")) {
        payload = { result: { items: [{ offer_id: "MY-1001", product_id: "456", warehouse_id: "7", stock: 2, reserved: 0 }] } };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new OzonClient({ clientId: "client", apiKey: "secret", baseUrl: "https://api-seller.ozon.ru", fetchImplementation, maxAttempts: 1 });

    await expect(client.importProductBySku({ sku: "1001", name: "商品", typeId: 123, descriptionCategoryId: 456, offerId: "MY-1001", price: "1299", currency: "RUB", vat: "0.2" })).resolves.toEqual({ taskId: "123", unmatchedSkuList: [] });
    await expect(client.getProductImportInfo("123")).resolves.toEqual([{ offerId: "MY-1001", productId: "456", status: "processed", errors: [], warnings: [] }]);
    await expect(client.getWarehouses()).resolves.toEqual([{ id: "7", name: "Москва", status: "active" }]);
    await expect(client.getProductInfoLimit()).resolves.toEqual({ dailyCreateRemaining: 20, totalProductLimit: 1000 });
    await expect(client.updateProductPrice({ offerId: "MY-1001", price: "1299", currency: "RUB", vat: "0.2" })).resolves.toBeUndefined();
    await expect(client.updateProductStock({ offerId: "MY-1001", productId: "456", warehouseId: "7", stock: 2 })).resolves.toMatchObject({ updated: true, offerId: "MY-1001" });
    await expect(client.getFbsStockByWarehouse({ offerId: "MY-1001", productId: "456", warehouseId: "7" })).resolves.toMatchObject({ stock: 2, warehouseId: "7" });

    expect(requests.map((request) => request.url)).toEqual([
      "https://api-seller.ozon.ru/v1/product/import-by-sku",
      "https://api-seller.ozon.ru/v1/product/import/info",
      "https://api-seller.ozon.ru/v2/warehouse/list",
      "https://api-seller.ozon.ru/v4/product/info/limit",
      "https://api-seller.ozon.ru/v1/product/import/prices",
      "https://api-seller.ozon.ru/v2/products/stocks",
      "https://api-seller.ozon.ru/v2/product/info/stocks-by-warehouse/fbs",
    ]);
    expect(requests[0]?.body).toMatchObject({ items: [{ type_id: 123, description_category_id: 456 }] });
    expect(requests.find((request) => request.url.endsWith("/v2/products/stocks"))?.body).toMatchObject({ stocks: [{ offer_id: "MY-1001", product_id: "456", warehouse_id: "7", stock: 2 }] });
    expect(requests.find((request) => request.url.endsWith("/v2/product/info/stocks-by-warehouse/fbs"))?.body).toEqual({ warehouse_id: 7, limit: 100, offset: 0 });
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

  it("rejects an HTTP 200 stock update that Ozon did not apply", async () => {
    const fetchImplementation = (async () => new Response(JSON.stringify({
      result: { items: [{ offer_id: "MY-1001", product_id: "456", warehouse_id: "7", updated: false, errors: [{ code: "WAREHOUSE_NOT_FOUND", message: "仓库不存在" }] }] },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const client = new OzonClient({ clientId: "client", apiKey: "secret", baseUrl: "https://api-seller.ozon.ru", fetchImplementation, maxAttempts: 1 });

    await expect(client.updateProductStock({ offerId: "MY-1001", productId: "456", warehouseId: "7", stock: 2 }))
      .rejects.toThrow("WAREHOUSE_NOT_FOUND");
  });

  it("uses the current finance accrual, type, posting, and cash-flow endpoints", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      let payload: unknown = {};
      if (url.endsWith("/v1/finance/accrual/by-day")) {
        payload = { accruals: [], last_id: null };
      } else if (url.endsWith("/v1/finance/accrual/types")) {
        payload = { accrual_types: [{ id: 29, name: "Доставка", description: "delivery" }] };
      } else if (url.endsWith("/v1/finance/accrual/postings")) {
        payload = { posting_accruals: [{ posting_number: "posting-1", accruals: [] }] };
      } else if (url.endsWith("/v1/finance/cash-flow-statement/list")) {
        payload = { rows: [] };
      }
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new OzonClient({ clientId: "client", apiKey: "secret", baseUrl: "https://api-seller.ozon.ru", fetchImplementation, maxAttempts: 1 });

    await expect(client.getFinanceAccrualByDay("2026-08-05", "cursor-1")).resolves.toMatchObject({ accruals: [], lastId: null });
    await expect(client.getFinanceAccrualTypes()).resolves.toEqual([{ id: "29", name: "Доставка", description: "delivery" }]);
    await expect(client.getFinanceAccrualPostings(["posting-1"])).resolves.toEqual([{ posting_number: "posting-1", accruals: [] }]);
    await expect(client.getFinanceCashFlowStatement(new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-05T00:00:00.000Z"))).resolves.toEqual({ raw: { rows: [] } });

    expect(requests.map((request) => request.url)).toEqual([
      "https://api-seller.ozon.ru/v1/finance/accrual/by-day",
      "https://api-seller.ozon.ru/v1/finance/accrual/types",
      "https://api-seller.ozon.ru/v1/finance/accrual/postings",
      "https://api-seller.ozon.ru/v1/finance/cash-flow-statement/list",
    ]);
    expect(requests[0]?.body).toEqual({ date: "2026-08-05", last_id: "cursor-1" });
    expect(requests[2]?.body).toEqual({ posting_numbers: ["posting-1"] });
    expect(requests[3]?.body).toMatchObject({ page: 1, page_size: 1000, date: { from: "2026-08-01", to: "2026-08-05" }, with_details: true });
  });
});
