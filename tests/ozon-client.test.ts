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
});
