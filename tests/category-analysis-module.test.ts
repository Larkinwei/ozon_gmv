import { describe, expect, it } from "vitest";

import type {
  SelectionCategoryCloudMetric,
  SelectionCategoryCloudSnapshot,
} from "../src/shared/contracts";
import type { CategoryCloudPort } from "../src/server/selection/category-cloud-client";
import { CategoryAnalysisModule } from "../src/server/selection/category-analysis-module";
import type { CategoryCollectorPort } from "../src/server/selection/opencli-category-collector";
import { createTestDatabase } from "./test-context";

function metrics(): SelectionCategoryCloudMetric[] {
  return [7, 28].flatMap((periodDays) => [
    {
      id: "3", name: "洗发水", categoryLevel1Id: "1", categoryLevel1Name: "美容和卫生",
      periodDays: periodDays as 7 | 28, gmvMinor: String(periodDays * 100_000), gmvGrowth: 0.25,
      orderedUnits: periodDays * 10, averagePriceMinor: "150000", averagePriceGrowth: 0.03,
      sellerCount: 80, brandCount: 45, clusterCount: 2, buyoutRate: 0.92,
      topFiveSellerShare: 0.24, categoryShare: 0.08, rating: 4.8, maximumRating: 5,
    },
    {
      id: "4", name: "电水壶", categoryLevel1Id: "2", categoryLevel1Name: "家用电器",
      periodDays: periodDays as 7 | 28, gmvMinor: String(periodDays * 200_000), gmvGrowth: -0.1,
      orderedUnits: periodDays * 4, averagePriceMinor: "320000", averagePriceGrowth: -0.02,
      sellerCount: 30, brandCount: 20, clusterCount: 1, buyoutRate: 0.85,
      topFiveSellerShare: 0.52, categoryShare: 0.06, rating: 4.6, maximumRating: 5,
    },
  ]);
}

async function waitForCompletion(module: CategoryAnalysisModule): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (module.getSync().status !== "running") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("同步任务未完成");
}

describe("category analysis module", () => {
  it("publishes only the complete two-period snapshot and applies filters", async () => {
    const context = createTestDatabase();
    const uploaded: SelectionCategoryCloudSnapshot[] = [];
    const collector: CategoryCollectorPort = {
      collect: async ({ onProgress }) => {
        const result = metrics();
        onProgress({ totalSteps: 4, completedSteps: 4, currentCategory: "家用电器 · 近 28 天", metrics: result, completedKeys: ["7:1", "7:2", "28:1", "28:2"] });
        return result;
      },
    };
    const cloud: CategoryCloudPort = {
      upload: async (snapshot) => {
        uploaded.push(snapshot);
        return { schemaVersion: 1, snapshotId: snapshot.snapshotId, collectedAt: snapshot.collectedAt, rowCount: snapshot.rowCount, sha256: "a".repeat(64), downloadUrl: "https://oss.example/a.gz", expiresAt: "2026-08-12T01:00:00.000Z" };
      },
      downloadLatest: async () => { throw new Error("offline"); },
    };
    const module = new CategoryAnalysisModule(context.config, context.database, {
      collectorFactory: () => collector,
      cloudFactory: () => cloud,
    });
    module.updateSettings({ collectorEnabled: true, opencliPath: "/test/opencli", cloudBaseUrl: "https://categories.example.com", uploadToken: "secret" });
    module.startSync();
    await waitForCompletion(module);

    try {
      expect(module.getSync()).toMatchObject({ status: "completed", cloudPublished: true, completedSteps: 4 });
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0]?.periods).toEqual([7, 28]);
      const page = module.list({ page: 1, pageSize: 20, periodDays: 28, sort: "growth", search: "水", maximumLeaderShare: 30 });
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({ name: "洗发水", gmvGrowth: 0.25 });
      const overview = module.overview(28);
      expect(overview.summaries).toHaveLength(2);
      expect(overview.categoryCount).toBe(2);
      await expect(module.refreshCloud()).rejects.toThrow("offline");
      expect(module.list({ page: 1, pageSize: 20, periodDays: 28, sort: "gmv" }).total).toBe(2);
    } finally {
      context.cleanup();
    }
  });

  it("does not publish an incomplete single-period collection", async () => {
    const context = createTestDatabase();
    const collector: CategoryCollectorPort = { collect: async () => metrics().filter((metric) => metric.periodDays === 7) };
    const module = new CategoryAnalysisModule(context.config, context.database, { collectorFactory: () => collector });
    module.updateSettings({ collectorEnabled: true, opencliPath: "/test/opencli" });
    module.startSync();
    await waitForCompletion(module);
    try {
      expect(module.getSync()).toMatchObject({ status: "failed" });
      expect(module.overview(7).snapshotId).toBeNull();
    } finally {
      context.cleanup();
    }
  });
});
