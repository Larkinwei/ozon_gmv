import { afterEach, describe, expect, it, vi } from "vitest";

import { PerformanceAdsService } from "../src/server/services/performance-ads-service";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import type { PerformanceAdsCampaign, PerformanceAdsDiagnostic } from "../src/shared/contracts";
import { createTestDatabase } from "./test-context";

describe("PerformanceAdsService", () => {
  const contexts: Array<ReturnType<typeof createTestDatabase>> = [];
  afterEach(() => {
    for (const context of contexts.splice(0)) context.cleanup();
  });

  it("stores credentials encrypted, queues the initial backfill, and keeps its completion flag on narrow syncs", async () => {
    const context = createTestDatabase();
    contexts.push(context);
    const requests: Array<{ path: string; method: string; body: string }> = [];
    const fakeFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(input instanceof URL ? input : String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      requests.push({ path: `${url.pathname}${url.search}`, method, body });
      if (url.pathname.endsWith("/api/client/token")) {
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      }
      if (url.pathname.endsWith("/api/client/campaign")) {
        return Response.json({ campaigns: [{ id: "123", title: "活动 A", state: "CAMPAIGN_STATE_RUNNING" }] });
      }
      if (url.pathname.endsWith("/api/client/statistics/daily/json")) {
        return Response.json({
          rows: [{
            id: "123",
            title: "活动 A",
            date: "2026-11-02",
            views: "10",
            clicks: "2",
            moneySpent: "3,50",
            orders: "1",
            ordersMoney: "20,00",
          }],
        });
      }
      if (url.pathname.endsWith("/api/client/statistics/products/sku")) {
        return Response.json({ rows: [{ date: "2026-11-02", campaignId: "123", sku: "SKU-1", impressions: 5, clicks: 1, expense: 1, orders: 1, sales: 10 }] });
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
    const stores = new StoresRepository(context.database);
    await stores.create({ id: "store-1", name: "测试店铺", clientId: "seller-client", apiKeyCiphertext: "seller-key", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
    const proxySettings = { createFetch: () => fakeFetch } as never;
    const service = new PerformanceAdsService(context.config, context.database, stores, proxySettings, new SettingsRepository(context.database));

    await service.save("store-1", { clientId: "client-id", clientSecret: "secret-value" });
    expect(context.database.prepare("SELECT value FROM app_settings WHERE key LIKE 'performance.ads.%'").all()).toHaveLength(2);
    expect(JSON.stringify(context.database.prepare("SELECT value FROM app_settings WHERE key LIKE 'performance.ads.%'").all())).not.toContain("secret-value");
    await service.test("store-1");

    const accepted = await service.startInitialBackfill("store-1");
    expect(accepted.accepted).toBe(true);
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const state = context.database.prepare("SELECT status FROM performance_ad_sync_state WHERE store_id = ?").get("store-1") as { status?: string } | undefined;
      if (state?.status === "success") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect((context.database.prepare("SELECT status FROM performance_ad_sync_state WHERE store_id = ?").get("store-1") as { status?: string } | undefined)?.status).toBe("success");
    const state = context.database.prepare("SELECT initial_backfill_done FROM performance_ad_sync_state WHERE store_id = ?").get("store-1") as { initial_backfill_done: number };
    expect(state.initial_backfill_done).toBe(1);
    expect(requests.some((request) => request.path.startsWith("/api/client/statistics/daily/json?dateFrom="))).toBe(true);
    expect(requests.some((request) => request.path === "/api/client/statistics/products/sku" && request.method === "POST")).toBe(true);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM performance_ad_daily_metrics WHERE store_id = ?").get("store-1")).toMatchObject({ count: 2 });

    context.database.prepare(`INSERT INTO storefront_price_snapshots
      (id, store_id, product_id, sku, offer_id, product_name, image_url, backend_price, green_price, black_price, currency_code, captured_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("snapshot-1", "store-1", "product-1", "776655", "SKU-1", "测试商品", "https://img.example/item.jpg", "100", null, null, "RUB", Date.now());

    const report = await service.list("store-1", "2026-11-01", "2026-11-03");
    expect(report.campaigns[0]).toMatchObject({
      campaignId: "123",
      state: "campaign_state_running",
    });
    expect(report.totals.expense).toBe("3.50");
    expect(report.trend).toHaveLength(3);
    expect(report.trend.map((point) => point.date)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(report.trend[0]).toMatchObject({ expense: "0.00", clicks: 0, orders: 0 });
    expect(report.trend[1]).toMatchObject({ expense: "3.50", sales: "20.00" });
    expect(report.skus[0]?.product).toMatchObject({
      ozonSku: "776655",
      offerId: "SKU-1",
      name: "测试商品",
      imageUrl: "https://img.example/item.jpg",
      productUrl: "https://www.ozon.ru/product/776655/",
    });

    await service.sync("store-1", "2026-11-02", "2026-11-02");
    const afterNarrowSync = context.database.prepare("SELECT initial_backfill_done FROM performance_ad_sync_state WHERE store_id = ?").get("store-1") as { initial_backfill_done: number };
    expect(afterNarrowSync.initial_backfill_done).toBe(1);
    service.stop();
  });

  it("serializes account requests and retries Ozon's single-active-request 429", async () => {
    const context = createTestDatabase();
    contexts.push(context);
    let campaignAttempts = 0;
    const fakeFetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(input instanceof URL ? input : String(input));
      if (url.pathname.endsWith("/api/client/token")) {
        return Response.json({ access_token: "test-token", expires_in: 3600 });
      }
      if (url.pathname.endsWith("/api/client/campaign")) {
        campaignAttempts += 1;
        if (campaignAttempts === 1) {
          return Response.json({ message: "Превышен лимит активных запросов (максимум 1)" }, {
            status: 429,
            headers: { "Retry-After": "0" },
          });
        }
        return Response.json({ campaigns: [] });
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
    const stores = new StoresRepository(context.database);
    await stores.create({ id: "store-1", name: "测试店铺", clientId: "seller-client", apiKeyCiphertext: "seller-key", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
    const service = new PerformanceAdsService(context.config, context.database, stores, { createFetch: () => fakeFetch } as never, new SettingsRepository(context.database));

    await service.save("store-1", { clientId: "client-id", clientSecret: "secret-value" });
    await expect(service.test("store-1")).resolves.toMatchObject({ ok: true });
    expect(campaignAttempts).toBe(2);
    service.stop();
  });

  it("diagnoses only running campaigns and includes their state in each card", () => {
    const context = createTestDatabase();
    contexts.push(context);
    const service = new PerformanceAdsService(
      context.config,
      context.database,
      new StoresRepository(context.database),
      { createFetch: () => fetch } as never,
      new SettingsRepository(context.database),
    );
    const campaign = (campaignId: string, state: string): PerformanceAdsCampaign => ({
      campaignId,
      name: `活动 ${campaignId}`,
      state,
      type: "",
      impressions: 2_000,
      clicks: 20,
      orders: 0,
      expense: "200.00",
      sales: "0.00",
      ctr: 1,
      avgCpc: 10,
      drr: null,
    });
    const buildDiagnostics = (service as unknown as {
      buildDiagnostics(campaigns: PerformanceAdsCampaign[]): PerformanceAdsDiagnostic[];
    }).buildDiagnostics.bind(service);

    const diagnostics = buildDiagnostics([
      campaign("running", "campaign_state_running"),
      campaign("archived", "campaign_state_archived"),
    ]);

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((item) => item.campaignId === "running")).toBe(true);
    expect(diagnostics.every((item) => item.campaignState === "campaign_state_running")).toBe(true);
    service.stop();
  });
});
