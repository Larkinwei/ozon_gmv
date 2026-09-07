import { describe, expect, it } from "vitest";

import { OzonClient } from "../src/server/ozon/client";

describe("Ozon store operations client", () => {
  it("reads the current 30-day finance balance report", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        total: {
          opening_balance: { currency_code: "RUB", value: 1200.5 },
          closing_balance: { currency_code: "RUB", value: "1450.75" },
          accrued: { currency_code: "RUB", value: 500 },
          payments: [{ currency_code: "RUB", value: "249.75" }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const client = new OzonClient({
      clientId: "client",
      apiKey: "secret",
      baseUrl: "https://api-seller.ozon.ru",
      fetchImplementation,
      maxAttempts: 1,
    });

    const dateFrom = new Date("2026-08-01T00:00:00.000Z");
    const dateTo = new Date("2026-08-31T00:00:00.000Z");
    await expect(client.getFinanceBalance(dateFrom, dateTo)).resolves.toEqual({
      openingBalance: { currencyCode: "RUB", value: "1200.5" },
      closingBalance: { currencyCode: "RUB", value: "1450.75" },
      accrued: { currencyCode: "RUB", value: "500" },
      payments: [{ currencyCode: "RUB", value: "249.75" }],
    });
    expect(requestUrl).toBe("https://api-seller.ozon.ru/v1/finance/balance");
    expect(requestBody).toEqual({ date_from: "2026-08-01", date_to: "2026-08-31" });
  });

  it("loads question counts, the latest five questions, and one question detail", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (url.endsWith("/count")) {
        return new Response(JSON.stringify({ all: 8, new: 2, processed: 4, unprocessed: 1, viewed: 1 }), { status: 200 });
      }
      const question = {
        id: "question-1",
        answers_count: "2",
        product_url: "https://www.ozon.ru/product/1/",
        question_link: "https://www.ozon.ru/product/1/questions/",
        published_at: "2026-08-31T10:00:00.000Z",
        sku: 12345,
        status: "UNPROCESSED",
        text: "可以放入 15 寸电脑吗？",
      };
      if (url.endsWith("/list")) {
        return new Response(JSON.stringify({ questions: [question], last_id: "question-1", has_next: false }), { status: 200 });
      }
      return new Response(JSON.stringify(question), { status: 200 });
    }) as typeof fetch;
    const client = new OzonClient({
      clientId: "client",
      apiKey: "secret",
      baseUrl: "https://api-seller.ozon.ru",
      fetchImplementation,
      maxAttempts: 1,
    });

    await expect(client.getQuestionCount()).resolves.toEqual({ all: 8, new: 2, processed: 4, unprocessed: 1, viewed: 1 });
    await expect(client.getQuestionList()).resolves.toMatchObject({
      lastId: "question-1",
      hasNext: false,
      questions: [{ id: "question-1", sku: "12345", answersCount: 2, text: "可以放入 15 寸电脑吗？" }],
    });
    await expect(client.getQuestionInfo("question-1")).resolves.toMatchObject({ id: "question-1", status: "UNPROCESSED" });
    expect(requests).toEqual([
      { url: "https://api-seller.ozon.ru/v1/question/count", body: {} },
      {
        url: "https://api-seller.ozon.ru/v1/question/list",
        body: { filter: { status: "ALL" }, limit: 5, last_id: "", sort_dir: "DESC" },
      },
      { url: "https://api-seller.ozon.ru/v1/question/info", body: { question_id: "question-1" } },
    ]);
  });
});
