import { describe, expect, it } from "vitest";

import type {
  SelectionCategoryCloudMetric,
  SelectionCategoryCloudSnapshot,
  SelectionCategoryLink,
  SelectionDiscoveryProductRanking,
  SelectionDiscoveryQueryRanking,
} from "../src/shared/contracts";
import type { CategoryCloudPort } from "../src/server/selection/category-cloud-client";
import { DiscoveryModule } from "../src/server/selection/discovery-module";
import type { CategoryCollectorPort } from "../src/server/selection/opencli-category-collector";
import type { DiscoveryMarketCollectorPort } from "../src/server/selection/opencli-discovery-collector";
import { createTestDatabase } from "./test-context";

const categoryMetrics: SelectionCategoryCloudMetric[] = [7, 28].map((periodDays) => ({
  id: "93950", name: "洗发水", categoryLevel1Id: "17027489", categoryLevel1Name: "美容和卫生",
  periodDays: periodDays as 7 | 28, gmvMinor: String(periodDays * 100_000), gmvGrowth: 0.25,
  orderedUnits: periodDays * 10, averagePriceMinor: "150000", averagePriceGrowth: 0.03,
  sellerCount: 80, brandCount: 45, clusterCount: 2, buyoutRate: 0.92,
  topFiveSellerShare: 0.24, categoryShare: 0.08, rating: 4.8, maximumRating: 5,
}));

const productBase: Omit<SelectionDiscoveryProductRanking, "scope" | "scopeCategoryId" | "rank"> = {
  ozonProductId: "171", name: "Шампунь", ozonUrl: "https://www.ozon.ru/product/171", photoUrl: null,
  seller: "Seller", sellerId: "10", brand: "Brand", brandId: "20",
  categoryLevel1Id: "17027489", categoryLevel1: "Красота", categoryLevel3Id: "93950", categoryLevel3: "Шампунь",
  periodDays: 28, orderedAmountMinor: "1234500", orderedUnits: 12, turnoverGrowth: 0.25,
  averagePriceMinor: "102875", minimumPriceMinor: "99900", purchaseRate: 0.9,
  missedSalesMinor: "5000", outOfStockDays: 1, stock: 8, fboStock: 8, fbsStock: 0,
  fulfillmentScheme: "FBO", volumeLiters: 1, impressions: 1000, searchViews: 700, cardViews: 400,
  impressionToOrderRate: 0.012, searchToCartRate: 0.2, cardToCartRate: 0.15,
  promotionDiscountRate: 0.1, promotedOrderShare: 0.3, promotionDays: 3, advertisedDays: 2,
  advertisingCostShare: 0.05, productCardCreatedDate: "2025-01-01",
};

const products: SelectionDiscoveryProductRanking[] = [
  { ...productBase, scope: "global", scopeCategoryId: null, rank: 1 },
  { ...productBase, scope: "category", scopeCategoryId: "93950", rank: 1 },
];

const queries: SelectionDiscoveryQueryRanking[] = [{
  phrase: "шампунь", normalizedPhrase: "шампунь", scope: "global", groupName: null,
  periodDays: 7, rank: 1, searchCount: 100, searchesWithCart: 20, cartRate: 0.2,
  orderedUnits: 10, orderRate: 0.1, orderedAmountMinor: "100000", averagePriceMinor: "10000",
  productViews: 200, competingSellers: 5, noInteractionCount: 30, noInteractionRate: 0.3,
  noResultCount: 2, noResultRate: 0.02, averageProductCount: 15,
}];

const categoryLinks: SelectionCategoryLink[] = [{
  categoryId: "93950", categoryName: "洗发水", categoryLevel1Id: "17027489", categoryLevel1Name: "美容和卫生",
  productTypeIds: ["93950"], queryGroups: ["Красота и здоровье"], queryScope: "category_level_1",
}];

const cloudSnapshot: SelectionCategoryCloudSnapshot = {
  schemaVersion: 1,
  snapshotId: "a".repeat(64),
  collectedAt: "2026-08-13T06:17:58.095Z",
  periods: [7, 28],
  rowCount: categoryMetrics.length,
  metrics: categoryMetrics,
  products,
  queries,
  categoryLinks,
  discoveryCounts: {
    categoryMetrics: categoryMetrics.length,
    productRankings: products.length,
    queryRankings: queries.length,
    categoryLinks: categoryLinks.length,
  },
};

async function waitForCompletion(module: DiscoveryModule): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (module.getSync().status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("统一市场同步任务未完成");
}

describe("discovery module", () => {
  it("hydrates a fresh read-only client from the latest cloud snapshot on startup", async () => {
    const context = createTestDatabase();
    const cloud: CategoryCloudPort = {
      upload: async () => { throw new Error("not used"); },
      downloadLatest: async () => cloudSnapshot,
    };
    const module = new DiscoveryModule(context.config, context.database, { cloudFactory: () => cloud });

    try {
      expect(module.listQueries({ page: 1, pageSize: 20, sort: "searchCount" }).total).toBe(0);
      await expect(module.start()).resolves.toBe(true);
      expect(module.listQueries({ page: 1, pageSize: 20, sort: "searchCount" })).toMatchObject({
        total: 1,
        snapshotId: cloudSnapshot.snapshotId,
      });
      expect(module.getSync()).toMatchObject({ source: "cloud", status: "completed", completedSteps: 1 });
    } finally {
      context.cleanup();
    }
  });

  it("reports cloud refresh progress while the shared snapshot is downloading", async () => {
    const context = createTestDatabase();
    let finishDownload: ((snapshot: SelectionCategoryCloudSnapshot) => void) | undefined;
    const download = new Promise<SelectionCategoryCloudSnapshot>((resolve) => { finishDownload = resolve; });
    const cloud: CategoryCloudPort = {
      upload: async () => { throw new Error("not used"); },
      downloadLatest: async () => download,
    };
    const module = new DiscoveryModule(context.config, context.database, { cloudFactory: () => cloud });

    try {
      const startup = module.start();
      expect(module.getSync()).toMatchObject({
        source: "cloud",
        status: "running",
        currentItem: "正在下载云端市场快照…",
      });
      finishDownload?.(cloudSnapshot);
      await expect(startup).resolves.toBe(true);
      expect(module.getSync()).toMatchObject({ source: "cloud", status: "completed", completedSteps: 1 });
    } finally {
      context.cleanup();
    }
  });

  it("atomically persists and publishes category, product and query rankings", async () => {
    const context = createTestDatabase();
    const uploads: SelectionCategoryCloudSnapshot[] = [];
    const categoryCollector: CategoryCollectorPort = {
      collect: async ({ onProgress }) => {
        onProgress({ totalSteps: 2, completedSteps: 2, currentCategory: "美容和卫生 · 近 28 天", metrics: categoryMetrics, completedKeys: ["7:17027489", "28:17027489"] });
        return categoryMetrics;
      },
    };
    const marketCollector: DiscoveryMarketCollectorPort = {
      collect: async ({ onPage }) => {
        onPage({ pageKey: "links:all", stage: "links", currentItem: "类目映射", payload: categoryLinks }, 1, 4);
        onPage({ pageKey: "products:global:28:0", stage: "products", currentItem: "热销商品", payload: products }, 2, 4);
        onPage({ pageKey: "queries:global:7:0", stage: "queries", currentItem: "热搜词", payload: queries }, 3, 4);
        return { products, queries, links: categoryLinks, totalSteps: 4 };
      },
    };
    const cloud: CategoryCloudPort = {
      upload: async (snapshot) => {
        uploads.push(snapshot);
        return { schemaVersion: 1, snapshotId: snapshot.snapshotId, collectedAt: snapshot.collectedAt, rowCount: snapshot.rowCount, sha256: "a".repeat(64), downloadUrl: "https://oss.example/snapshot.gz", expiresAt: "2026-08-13T01:00:00.000Z" };
      },
      downloadLatest: async () => { throw new Error("not used"); },
    };
    const module = new DiscoveryModule(context.config, context.database, {
      categoryCollectorFactory: () => categoryCollector,
      marketCollectorFactory: () => marketCollector,
      cloudFactory: () => cloud,
    });
    module.updateSettings({ collectorEnabled: true, opencliPath: "/test/opencli", cloudBaseUrl: "https://categories.example.com", uploadToken: "secret" });
    module.startSync();
    await waitForCompletion(module);

    try {
      expect(module.getSync()).toMatchObject({ status: "completed", cloudPublished: true });
      expect(uploads[0]?.discoveryCounts).toEqual({ categoryMetrics: 2, productRankings: 2, queryRankings: 1, categoryLinks: 1 });
      expect(module.listProducts({ page: 1, pageSize: 20, periodDays: 28, sort: "orderedAmount" })).toMatchObject({
        total: 1, scope: "global", items: [{ categoryLevel1: "美容和卫生", categoryLevel3: "洗发水" }],
      });
      expect(module.listProducts({ page: 1, pageSize: 20, periodDays: 28, sort: "orderedAmount", categoryId: "93950" })).toMatchObject({ total: 1, scope: "category" });
      expect(module.listQueries({ page: 1, pageSize: 20, sort: "searchCount", categoryId: "93950" })).toMatchObject({
        categoryLink: { queryGroups: ["Красота и здоровье"], queryScope: "category_level_1" },
      });
    } finally {
      context.cleanup();
    }
  });
});
