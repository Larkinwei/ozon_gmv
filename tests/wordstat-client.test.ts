import { describe, expect, it, vi } from "vitest";

import { WordstatClient } from "../src/server/selection/wordstat-client";

describe("Yandex Wordstat adapter", () => {
  it("loads Russia-wide top requests and the last 24 complete months", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        totalCount: "12000",
        results: [{ phrase: "органайзер для кухни", count: "12000" }],
        associations: [{ phrase: "хранение на кухне", count: "3500" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [
          { date: "2026-06-01T00:00:00Z", count: "900", share: 0.01 },
          { date: "2026-07-01T00:00:00Z", count: "1200", share: 0.012 },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = new WordstatClient({
      folderId: "folder-1",
      apiKey: "secret-key",
      fetchImplementation: fetchMock,
      now: () => new Date("2026-08-11T00:00:00.000Z"),
    });

    const profile = await client.fetchProfile("органайзер для кухни");

    expect(profile.totalCount30d).toBe(12000);
    expect(profile.associations).toEqual([{ phrase: "хранение на кухне", count: 3500 }]);
    const [topUrl, topInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(topUrl.pathname).toBe("/v2/wordstat/topRequests");
    expect(new Headers(topInit.headers).get("authorization")).toBe("Api-key secret-key");
    expect(JSON.parse(String(topInit.body))).toMatchObject({
      phrase: "органайзер для кухни",
      numPhrases: 100,
      regions: ["225"],
      devices: ["DEVICE_ALL"],
      folderId: "folder-1",
    });
    const [dynamicsUrl, dynamicsInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(dynamicsUrl.pathname).toBe("/v2/wordstat/dynamics");
    expect(JSON.parse(String(dynamicsInit.body))).toMatchObject({
      period: "PERIOD_MONTHLY",
      fromDate: "2024-08-01T00:00:00.000Z",
      toDate: "2026-07-31T23:59:59.999Z",
    });
  });

  it("retries a quota response using Retry-After without changing the request", async () => {
    let topAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith("/topRequests")) {
        topAttempts += 1;
        if (topAttempts === 1) {
          return new Response("quota", { status: 429, headers: { "Retry-After": "0" } });
        }
        return new Response(JSON.stringify({ totalCount: "5", results: [], associations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new WordstatClient({
      folderId: "folder-1",
      apiKey: "secret-key",
      fetchImplementation: fetchMock,
      maxAttempts: 2,
    });

    const profile = await client.fetchProfile("test");

    expect(profile.totalCount30d).toBe(5);
    expect(topAttempts).toBe(2);
  });
});
