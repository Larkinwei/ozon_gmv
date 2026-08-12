import { describe, expect, it } from "vitest";

import { OpenCliCategoryCollector } from "../src/server/selection/opencli-category-collector";

describe("OpenCLI category collector", () => {
  it("uses fixed arguments, retries 429 and normalizes official metrics", async () => {
    const delays: number[] = [];
    let fetchCalls = 0;
    const collector = new OpenCliCategoryCollector({
      executable: "/test/opencli",
      sessionName: "test-session",
      requestDelayMs: 1_000,
      delayImplementation: async (milliseconds) => { delays.push(milliseconds); },
      runCommand: async (argumentsList) => {
        if (argumentsList.includes("find")) return JSON.stringify({ entries: [{ ref: 1 }, { ref: 2 }] });
        if (argumentsList.includes("open") || argumentsList.includes("wait") || argumentsList.includes("close") || argumentsList.includes("click")) return "{}";
        const script = argumentsList.at(-1) ?? "";
        if (script.includes("localStorage.getItem")) {
          return JSON.stringify({ companyId: "company", categories: [{ id: "1", name: "食品" }] });
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
    expect(result[0]).toMatchObject({ name: "果汁、水、饮料", gmvMinor: "12345", gmvGrowth: 0.25, buyoutRate: 0.9 });
  });

  it("fails immediately when the Chrome page has no logged-in company", async () => {
    const collector = new OpenCliCategoryCollector({
      executable: "/test/opencli",
      sessionName: "test-session",
      runCommand: async (argumentsList) => {
        if (argumentsList.includes("find")) return JSON.stringify({ entries: [{ ref: 1 }, { ref: 2 }] });
        return argumentsList.includes("eval") ? JSON.stringify({ companyId: "", categories: [] }) : "{}";
      },
    });
    await expect(collector.collect({ resumeMetrics: [], resumeCompletedKeys: [], onProgress: () => undefined }))
      .rejects.toThrow("Chrome 中未找到 Ozon Seller 登录状态");
  });
});
