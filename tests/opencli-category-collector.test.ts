import { describe, expect, it } from "vitest";

import { OpenCliCategoryCollector } from "../src/server/selection/opencli-category-collector";

describe("OpenCLI category collector", () => {
  it("reads root categories from Seller tree, retries 429 and normalizes official metrics", async () => {
    const delays: number[] = [];
    let fetchCalls = 0;
    const argumentsSeen: string[][] = [];
    const collector = new OpenCliCategoryCollector({
      executable: "/test/opencli",
      sessionName: "test-session",
      requestDelayMs: 1_000,
      delayImplementation: async (milliseconds) => { delays.push(milliseconds); },
      runCommand: async (argumentsList) => {
        argumentsSeen.push(argumentsList);
        if (argumentsList.includes("open") || argumentsList.includes("wait") || argumentsList.includes("close")) return "{}";
        const script = argumentsList.at(-1) ?? "";
        if (script.includes("/api/v1/seller-tree/get")) {
          return JSON.stringify({ companyId: "company", status: 200, categories: [{ id: "17027482", name: "Строительство и ремонт" }] });
        }
        fetchCalls += 1;
        if (fetchCalls <= 3) return JSON.stringify({ status: 429, message: "rate limited" });
        return JSON.stringify({ status: 200, items: [{
          key: "3", label: "果汁、水、饮料", metric_gmv: 123.45, metric_gmv_growth: 25,
          metric_items: "12", metric_aiv: 10.5, metric_aiv_growth: -5, metric_sellers: "8",
          metric_brands: "7", metric_clusters: "2", metric_buyout: 90,
          metric_leader_share: 30, metric_category_share: 4, rating: "4.8", max_rating: "5",
        }] });
      },
    });
    const result = await collector.collect({ resumeMetrics: [], resumeCompletedKeys: [], onProgress: () => undefined });
    expect(fetchCalls).toBe(5);
    expect(delays).toEqual([30_000, 60_000, 120_000, 1_000, 1_000]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: "果汁、水、饮料", categoryLevel1Id: "17027482", categoryLevel1Name: "Строительство и ремонт",
      gmvMinor: "12345", gmvGrowth: 0.25, buyoutRate: 0.9,
    });
    expect(argumentsSeen.some((args) => args.includes("find") || args.includes("click"))).toBe(false);
    expect(argumentsSeen.filter((args) => args.includes("eval")).map((args) => args.at(-1)).join("\n"))
      .toContain('id: 17027482');
  });

  it("fails immediately when the Chrome page has no logged-in company", async () => {
    const collector = new OpenCliCategoryCollector({
      executable: "/test/opencli",
      sessionName: "test-session",
      runCommand: async (argumentsList) => {
        const script = argumentsList.at(-1) ?? "";
        if (script.includes("/api/v1/seller-tree/get")) {
          return JSON.stringify({ companyId: "", categories: [], status: 0 });
        }
        return "{}";
      },
    });
    await expect(collector.collect({ resumeMetrics: [], resumeCompletedKeys: [], onProgress: () => undefined }))
      .rejects.toThrow("Chrome 中未找到 Ozon Seller 登录状态");
  });

  it("retries temporary Seller tree failures before collecting categories", async () => {
    const delays: number[] = [];
    let bootstrapCalls = 0;
    let metricCalls = 0;
    const collector = new OpenCliCategoryCollector({
      executable: "/test/opencli",
      sessionName: "test-session",
      requestDelayMs: 0,
      delayImplementation: async (milliseconds) => { delays.push(milliseconds); },
      runCommand: async (argumentsList) => {
        const script = argumentsList.at(-1) ?? "";
        if (script.includes("/api/v1/seller-tree/get")) {
          bootstrapCalls += 1;
          if (bootstrapCalls === 1) return JSON.stringify({ companyId: "company", status: 503, categories: [], message: "temporarily unavailable" });
          return JSON.stringify({ companyId: "company", status: 200, categories: [{ id: "1", name: "食品" }] });
        }
        if (script.includes("/api/site/exar-api/v2/gb/seller/metrics")) {
          metricCalls += 1;
          return JSON.stringify(metricCalls === 1
            ? { status: 0, message: "network error" }
            : { status: 200, items: [] });
        }
        return "{}";
      },
    });

    await collector.collect({ resumeMetrics: [], resumeCompletedKeys: [], onProgress: () => undefined });

    expect(bootstrapCalls).toBe(2);
    expect(metricCalls).toBe(3);
    expect(delays).toEqual([30_000, 30_000, 0, 0]);
  });

  it("reports Seller tree permission failures and empty category trees clearly", async () => {
    for (const result of [
      { companyId: "company", status: 403, categories: [] },
      { companyId: "company", status: 200, categories: [] },
    ]) {
      const collector = new OpenCliCategoryCollector({
        executable: "/test/opencli",
        sessionName: "test-session",
        runCommand: async (argumentsList) => {
          const script = argumentsList.at(-1) ?? "";
          return script.includes("/api/v1/seller-tree/get") ? JSON.stringify(result) : "{}";
        },
      });
      const expectedMessage = result.status === 403 ? "类目读取权限已失效" : "未返回一级类目";
      await expect(collector.collect({ resumeMetrics: [], resumeCompletedKeys: [], onProgress: () => undefined }))
        .rejects.toThrow(expectedMessage);
    }
  });
});
