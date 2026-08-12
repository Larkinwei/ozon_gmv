import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { SelectionModule } from "../src/server/selection/selection-module";
import type { WordstatProfile } from "../src/server/selection/wordstat-client";
import { marketProductHeaders, marketProductWorkbook } from "./selection-fixtures";
import { createTestDatabase } from "./test-context";

function keywordCsv(count = 10): Buffer {
  const rows = Array.from({ length: count }, (_, index) => {
    const value = index + 1;
    return `关键词${value},${value * 100},${value}%,${value / 2}%,${10_000 - value}`;
  });
  return Buffer.from(["关键词,搜索次数,加购率,下单率,均价", ...rows].join("\n"));
}

const importMapping = {
  phrase: "关键词",
  searchCount: "搜索次数",
  cartRate: "加购率",
  cartRateUnit: "percent" as const,
  orderRate: "下单率",
  orderRateUnit: "percent" as const,
  averagePrice: "均价",
};

describe("product selection module", () => {
  it("previews a UTF-8 BOM semicolon CSV with Russian headers", async () => {
    const context = createTestDatabase();
    const selection = new SelectionModule(context.config, context.database);

    try {
      const preview = await selection.previewImport({
        fileName: "popular-queries.csv",
        content: Buffer.from(
          "\uFEFFПоисковая фраза;Количество запросов;Конверсия в корзину;Конверсия в заказ;Средняя цена\n"
          + "органайзер для кухни;1200;12,5%;4,2%;1499,90\n",
          "utf8",
        ),
      });

      expect(preview).toMatchObject({
        fileName: "popular-queries.csv",
        fileType: "csv",
        sheets: ["CSV"],
        selectedSheet: "CSV",
        headers: [
          "Поисковая фраза",
          "Количество запросов",
          "Конверсия в корзину",
          "Конверсия в заказ",
          "Средняя цена",
        ],
      });
      expect(preview.sampleRows).toEqual([
        ["органайзер для кухни", "1200", "12,5%", "4,2%", "1499,90"],
      ]);
    } finally {
      context.cleanup();
    }
  });

  it("previews a selected XLSX worksheet with numeric and text cells", async () => {
    const context = createTestDatabase();
    const selection = new SelectionModule(context.config, context.database);
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("说明").addRow(["此页不是数据"]);
    const worksheet = workbook.addWorksheet("热门查询");
    worksheet.addRow(["搜索词", "搜索次数", "加购率", "下单率", "均价"]);
    worksheet.addRow(["органайзер", 1200, "12.5%", 0.04, 1499.9]);
    worksheet.addRow([]);
    worksheet.addRow(["полка", "850", "9%", "3%", "999"]);
    const content = Buffer.from(await workbook.xlsx.writeBuffer());

    try {
      const preview = await selection.previewImport({
        fileName: "popular-queries.xlsx",
        content,
        sheetName: "热门查询",
      });

      expect(preview).toMatchObject({
        fileType: "xlsx",
        sheets: ["说明", "热门查询"],
        selectedSheet: "热门查询",
        totalDataRows: 2,
      });
      expect(preview.sampleRows).toEqual([
        ["органайзер", "1200", "12.5%", "0.04", "1499.9"],
        ["полка", "850", "9%", "3%", "999"],
      ]);
    } finally {
      context.cleanup();
    }
  });

  it("imports normalized keyword metrics and scores demand within the same snapshot", async () => {
    const context = createTestDatabase();
    const selection = new SelectionModule(context.config, context.database);
    const content = keywordCsv();

    try {
      const result = await selection.commitImport({
        fileName: "queries.csv",
        content,
        snapshotDate: "2026-08-11",
        mapping: importMapping,
      });
      const keywords = selection.listKeywords({ page: 1, pageSize: 20, sort: "demandScore" });

      expect(result).toMatchObject({ validRows: 10, skippedRows: 0 });
      expect(keywords.total).toBe(10);
      expect(keywords.items[0]).toMatchObject({
        phrase: "关键词10",
        searchCount: 1000,
        demandScore: 100,
        averagePrice: { amount: "9990.00", currency: "RUB" },
      });
      expect(keywords.items.at(-1)).toMatchObject({ phrase: "关键词1", demandScore: 0 });
    } finally {
      context.cleanup();
    }
  });

  it("detects and imports an official all-metrics product report", async () => {
    const context = createTestDatabase();
    const selection = new SelectionModule(context.config, context.database);
    const content = await marketProductWorkbook();

    try {
      const preview = await selection.previewImport({ fileName: "analytics_report_2026-08-11_17_07.xlsx", content });
      expect(preview).toMatchObject({
        kind: "market_product",
        detectedSnapshotDate: "2026-08-11",
        reportPeriodDays: 28,
        totalDataRows: 1,
      });
      const result = await selection.commitImport({
        fileName: "analytics_report_2026-08-11_17_07.xlsx",
        content,
        snapshotDate: "2026-08-11",
      });
      const page = selection.listMarketProducts({ page: 1, pageSize: 20, sort: "orderedAmount", productFlag: "Лидер по продажам" });

      expect(result).toMatchObject({ kind: "market_product", validRows: 1, skippedRows: 1 });
      expect(page.facets).toMatchObject({ categoryLevel1: ["Beauty & Hygiene"], categoryLevel3: ["洗发水"] });
      expect(page.items[0]).toMatchObject({
        name: "Святой Источник Hair Shampoo, 2000 ml",
        orderedAmount: { amount: "82753618.00", currency: "RUB" },
        turnoverGrowth: -0.12,
        orderedUnits: 79193,
        impressionToOrderRate: 0.042,
        outOfStockDays: null,
      });
      expect(selection.getMarketProduct(page.items[0]!.id)).toMatchObject({
        purchaseRate: null,
        promotionDays: 24,
        advertisedDays: 27,
        advertisingCostShare: 0.083,
        history: [{ snapshotDate: "2026-08-11" }],
      });
      expect(selection.getOverview()).toMatchObject({ marketProductCount: 1, latestMarketProductSnapshotDate: "2026-08-11" });
    } finally {
      context.cleanup();
    }
  });

  it("searches every imported product text field with Unicode-aware substring matching", async () => {
    const context = createTestDatabase();
    const selection = new SelectionModule(context.config, context.database);

    try {
      await selection.commitImport({
        fileName: "analytics_report_2026-08-11_17_07.xlsx",
        content: await marketProductWorkbook(),
        snapshotDate: "2026-08-11",
      });

      const query = (search: string, overrides: Partial<Parameters<typeof selection.listMarketProducts>[0]> = {}) => selection.listMarketProducts({
        page: 1,
        pageSize: 20,
        sort: "orderedAmount",
        search,
        ...overrides,
      });

      for (const search of ["Hair Shampoo", "VOIS", "Beauty Seller", "Beauty & Hygiene", "水", "лидер", "ＶＯＩＳ"]) {
        expect(query(search).total, search).toBe(1);
      }
      expect(query("Святой").total).toBe(1);
      expect(query("святой").total).toBe(1);
      expect(query("СВЯТОЙ").total).toBe(1);
      expect(query("水", {
        categoryLevel1: "Beauty & Hygiene",
        productFlag: "Лидер по продажам",
        minimumPrice: 1_000,
        maximumPrice: 1_100,
      }).total).toBe(1);
      expect(query("水", { minimumPrice: 2_000 }).total).toBe(0);
      expect(query("   ").total).toBe(1);
    } finally {
      context.cleanup();
    }
  });

  it("keeps product snapshots and candidate links when a later import is deleted", async () => {
    const context = createTestDatabase();
    const selection = new SelectionModule(context.config, context.database);

    try {
      await selection.commitImport({
        fileName: "analytics_report_2026-08-10_10_00.xlsx",
        content: await marketProductWorkbook(60_000_000, 60_000),
        snapshotDate: "2026-08-10",
      });
      const latestImport = await selection.commitImport({
        fileName: "analytics_report_2026-08-11_17_07.xlsx",
        content: await marketProductWorkbook(82_753_618, 79_193),
        snapshotDate: "2026-08-11",
      });
      const product = selection.listMarketProducts({ page: 1, pageSize: 20, sort: "orderedAmount" }).items[0]!;
      const candidate = selection.createCandidate({
        marketProductId: product.id,
        name: product.name,
        ozonUrl: product.ozonUrl,
        category: product.categoryLevel3,
      });

      expect(selection.getMarketProduct(product.id)?.history).toHaveLength(2);
      expect(candidate.marketProduct).toMatchObject({ orderedUnits: 79193, snapshotDate: "2026-08-11" });
      expect(selection.deleteImport(latestImport.id)).toBe(true);
      expect(selection.getCandidate(candidate.id)?.marketProduct).toMatchObject({ orderedUnits: 60000, snapshotDate: "2026-08-10" });
    } finally {
      context.cleanup();
    }
  });

  it("leaves small samples unscored and gives tied metrics the same midpoint percentile", async () => {
    const context = createTestDatabase();
    const selection = new SelectionModule(context.config, context.database);
    const smallRows = Array.from({ length: 9 }, (_, index) => `小样本${index},100,10%,5%,${1000 + index}`);
    const tiedRows = Array.from({ length: 10 }, (_, index) => `并列${index},500,20%,8%,${2000 + index * 500}`);

    try {
      await selection.commitImport({
        fileName: "small.csv",
        content: Buffer.from(["关键词,搜索次数,加购率,下单率,均价", ...smallRows].join("\n")),
        snapshotDate: "2026-08-10",
        mapping: importMapping,
      });
      const smallKeyword = selection.listKeywords({ page: 1, pageSize: 100, sort: "searchCount" }).items.find((item) => item.phrase === "小样本0");
      expect(smallKeyword?.demandScore).toBeNull();

      await selection.commitImport({
        fileName: "tied.csv",
        content: Buffer.from(["关键词,搜索次数,加购率,下单率,均价", ...tiedRows].join("\n")),
        snapshotDate: "2026-08-11",
        mapping: importMapping,
      });
      const tiedKeywords = selection.listKeywords({ page: 1, pageSize: 100, sort: "averagePrice" }).items.filter((item) => item.phrase.startsWith("并列"));

      expect(tiedKeywords).toHaveLength(10);
      expect(new Set(tiedKeywords.map((item) => item.demandScore))).toEqual(new Set([50]));
    } finally {
      context.cleanup();
    }
  });

  it("persists Wordstat settings without exposing the API key and completes a requested enrichment", async () => {
    const context = createTestDatabase();
    const profile: WordstatProfile = {
      totalCount30d: 2400,
      topRequests: [{ phrase: "关键词1", count: 2400 }],
      associations: [{ phrase: "相关词", count: 600 }],
      dynamics: [
        { date: "2025-07-01T00:00:00.000Z", count: 1000, share: 0.01 },
        { date: "2026-04-01T00:00:00.000Z", count: 1200, share: 0.01 },
        { date: "2026-07-01T00:00:00.000Z", count: 1500, share: 0.012 },
      ],
    };
    let receivedApiKey = "";
    let fetchCount = 0;
    const wordstatFactory = (_folderId: string, apiKey: string) => {
      receivedApiKey = apiKey;
      return {
        testConnection: async () => undefined,
        fetchProfile: async () => {
          fetchCount += 1;
          return profile;
        },
      };
    };
    const selection = new SelectionModule(context.config, context.database, { wordstatFactory });

    try {
      await selection.commitImport({
        fileName: "queries.csv",
        content: keywordCsv(),
        snapshotDate: "2026-08-11",
        mapping: importMapping,
      });
      selection.updateWordstatSettings({ folderId: "folder-1", apiKey: "secret-key" });
      expect(selection.viewWordstatSettings()).toEqual({ configured: true, folderId: "folder-1", hasApiKey: true });
      const keyword = selection.listKeywords({ page: 1, pageSize: 20, sort: "searchCount" }).items.at(-1)!;
      const job = selection.enqueueWordstat({ keywordIds: [keyword.id], force: false });

      selection.start();
      let current = selection.getWordstatJob(job.id);
      for (let attempt = 0; attempt < 20 && current.status !== "completed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        current = selection.getWordstatJob(job.id);
      }

      expect(current).toMatchObject({ status: "completed", total: 1, completed: 1, failed: 0 });
      expect(receivedApiKey).toBe("secret-key");
      expect(selection.getKeyword(keyword.id)?.wordstat).toMatchObject({
        totalCount30d: 2400,
        growth3m: 0.25,
        growth12m: 0.5,
        trend: "rising",
      });
      const cachedJob = selection.enqueueWordstat({ keywordIds: [keyword.id], force: false });
      expect(cachedJob).toMatchObject({ status: "completed", completed: 1, failed: 0 });
      expect(fetchCount).toBe(1);
    } finally {
      await selection.stop();
      context.cleanup();
    }
  });

  it("recovers an interrupted persisted Wordstat job and reports partial success", async () => {
    const context = createTestDatabase();
    const selection = new SelectionModule(context.config, context.database, {
      wordstatFactory: () => ({
        testConnection: async () => undefined,
        fetchProfile: async (phrase) => {
          if (phrase === "关键词2") {
            throw new Error("quota exhausted");
          }
          return { totalCount30d: 10, topRequests: [], associations: [], dynamics: [] };
        },
      }),
    });

    try {
      await selection.commitImport({
        fileName: "recovery.csv",
        content: keywordCsv(),
        snapshotDate: "2026-08-11",
        mapping: importMapping,
      });
      selection.updateWordstatSettings({ folderId: "folder-1", apiKey: "secret-key" });
      const keywords = selection.listKeywords({ page: 1, pageSize: 20, sort: "searchCount" }).items;
      const first = keywords.find((item) => item.phrase === "关键词1")!;
      const second = keywords.find((item) => item.phrase === "关键词2")!;
      const job = selection.enqueueWordstat({ keywordIds: [first.id, second.id], force: true });
      context.database.prepare("UPDATE selection_wordstat_jobs SET status = 'running' WHERE id = ?").run(job.id);
      context.database.prepare("UPDATE selection_wordstat_job_items SET status = 'running' WHERE job_id = ?").run(job.id);

      selection.start();
      let current = selection.getWordstatJob(job.id);
      for (let attempt = 0; attempt < 30 && current.status !== "partial"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        current = selection.getWordstatJob(job.id);
      }

      expect(current).toMatchObject({ status: "partial", total: 2, completed: 1, failed: 1 });
    } finally {
      await selection.stop();
      context.cleanup();
    }
  });

  it("keeps Wordstat concurrency at three across multiple queued jobs", async () => {
    const context = createTestDatabase();
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const selection = new SelectionModule(context.config, context.database, {
      wordstatFactory: () => ({
        testConnection: async () => undefined,
        fetchProfile: async () => {
          activeRequests += 1;
          maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
          await new Promise((resolve) => setTimeout(resolve, 8));
          activeRequests -= 1;
          return { totalCount30d: 10, topRequests: [], associations: [], dynamics: [] };
        },
      }),
    });

    try {
      await selection.commitImport({
        fileName: "concurrency.csv",
        content: keywordCsv(),
        snapshotDate: "2026-08-11",
        mapping: importMapping,
      });
      selection.updateWordstatSettings({ folderId: "folder-1", apiKey: "secret-key" });
      const keywordIds = selection.listKeywords({ page: 1, pageSize: 20, sort: "searchCount" }).items.map((item) => item.id);
      const firstJob = selection.enqueueWordstat({ keywordIds: keywordIds.slice(0, 5), force: true });
      const secondJob = selection.enqueueWordstat({ keywordIds: keywordIds.slice(5), force: true });
      selection.start();

      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (selection.getWordstatJob(firstJob.id).status === "completed"
          && selection.getWordstatJob(secondJob.id).status === "completed") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(selection.getWordstatJob(firstJob.id).status).toBe("completed");
      expect(selection.getWordstatJob(secondJob.id).status).toBe("completed");
      expect(maximumActiveRequests).toBe(3);
    } finally {
      await selection.stop();
      context.cleanup();
    }
  });

  it("keeps candidate decisions and rejects the same Ozon product twice", async () => {
    const context = createTestDatabase();
    const selection = new SelectionModule(context.config, context.database);

    try {
      await selection.commitImport({
        fileName: "queries.csv",
        content: keywordCsv(),
        snapshotDate: "2026-08-11",
        mapping: importMapping,
      });
      const keyword = selection.listKeywords({ page: 1, pageSize: 20, sort: "searchCount" }).items[0]!;
      const candidate = selection.createCandidate({
        keywordId: keyword.id,
        name: "厨房收纳架",
        ozonUrl: "https://www.ozon.ru/product/organayzer-1234567890/?from=search",
        category: "Дом и сад",
        targetPrice: "1799.00",
        note: "先确认尺寸和物流",
      });
      const updated = selection.updateCandidate(candidate.id, {
        status: "recommended",
        decisionReason: "需求强且目标售价合适",
      });

      expect(updated).toMatchObject({
        status: "recommended",
        decisionReason: "需求强且目标售价合适",
        keyword: { id: keyword.id, phrase: keyword.phrase, demandScore: 100 },
        targetPrice: { amount: "1799.00", currency: "RUB" },
      });
      expect(selection.listCandidates({ status: "recommended" })).toHaveLength(1);
      expect(() => selection.createCandidate({
        name: "重复商品",
        ozonUrl: "https://ozon.ru/product/another-title-1234567890/",
      })).toThrow(/已经在候选池/);
    } finally {
      context.cleanup();
    }
  });
});
