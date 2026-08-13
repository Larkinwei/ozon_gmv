import { describe, expect, it } from "vitest";

import type { SelectionCategoryMetric } from "../src/shared/contracts";
import { OpenCliDiscoveryCollector } from "../src/server/selection/opencli-discovery-collector";

const categories: SelectionCategoryMetric[] = [{
  id: "93950", name: "洗发水", categoryLevel1Id: "17027489", categoryLevel1Name: "美容和卫生",
  periodDays: 28, gmv: { amount: "100.00", currency: "RUB" }, gmvGrowth: 0.1,
  orderedUnits: 10, averagePrice: { amount: "10.00", currency: "RUB" }, averagePriceGrowth: null,
  sellerCount: 3, brandCount: 2, clusterCount: null, buyoutRate: 0.9, topFiveSellerShare: 0.2,
  categoryShare: null, rating: null, maximumRating: null,
}];

describe("OpenCLI discovery collector", () => {
  it("maps category descendants, normalizes product/query rates and resumes completed pages", async () => {
    const pages = new Map();
    const productScripts: string[] = [];
    const delays: number[] = [];
    const collector = new OpenCliDiscoveryCollector({
      executable: "/test/opencli",
      sessionName: "test-discovery",
      delayImplementation: async (milliseconds) => { delays.push(milliseconds); },
      runCommand: async (args) => {
        if (args.includes("open") || args.includes("wait") || args.includes("close")) return "{}";
        const script = args.at(-1) ?? "";
        if (script.includes("/api/v1/seller-tree/get")) {
          return JSON.stringify({ companyId: "company", groups: ["Красота и здоровье"], tree: {
            "17027489": { descriptionCategoryId: "17027489", descriptionCategoryName: "Красота и гигиена", descriptionTypeId: "0", nodes: {
              "93950": { descriptionCategoryId: "93950", descriptionCategoryName: "Шампунь", descriptionTypeId: "93950", nodes: {} },
            } },
          } });
        }
        if (script.includes("what_to_sell/data/v3")) {
          productScripts.push(script);
          return JSON.stringify({ status: 200, total: 1, items: [{ sku: "171", name: "Шампунь", link: "https://www.ozon.ru/product/171", category1Id: "17027489", category1: "Красота", category3Id: "93950", category3: "Шампунь", gmvSum: 123.45, soldCount: "12", salesDynamics: 25, avgPrice: 10, convViewToOrder: 4, stock: "8" }] });
        }
        return JSON.stringify({ status: 200, total: 1, items: [{ query: "шампунь", count: 100, uniqQueriesWCa: 20, ca: 20, ord: 10, searchUsersToOrdUsers: 10, gmv: 1000, avgCaRub: 100, uniqSellers: 5, usersWithoutInterectionShare: 30, zrShare: 2 }] });
      },
    });
    const result = await collector.collect({
      categories,
      resumePages: pages,
      onPage: (page) => pages.set(page.pageKey, page.payload),
    });
    expect(result.links[0]).toMatchObject({ categoryId: "93950", productTypeIds: ["93950"], queryGroups: ["Красота и здоровье"] });
    expect(result.products[0]).toMatchObject({ orderedAmountMinor: "12345", turnoverGrowth: 0.25, impressionToOrderRate: 0.04 });
    expect(result.queries[0]).toMatchObject({ phrase: "шампунь", cartRate: 0.2, orderRate: 0.1 });
    expect(productScripts[0]).toContain('"x-o3-language": "zh-Hans"');
    expect(pages.has("products:global:7:0")).toBe(true);
    expect(pages.has("queries:global:7:0")).toBe(true);
    expect(Math.max(...delays)).toBeLessThanOrEqual(250);
  });
});
