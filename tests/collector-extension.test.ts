import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const backgroundSource = readFileSync(new URL("../collector-extension/background.js", import.meta.url), "utf8");

function createSkuRow(label: string) {
  return {
    getAttribute: () => "",
    querySelectorAll: () => [],
    querySelector: (selector: string) => selector.includes("name") || selector.includes("title")
      ? { getAttribute: () => label, textContent: label }
      : null,
  };
}

async function collect1688Product() {
  const skuMap = {
    0: { skuId: "sku-a", specAttrs: "Large", price: "12.50", canBookCount: 8 },
    1: { skuId: "sku-b", specAttrs: "Small", price: "9.50", canBookCount: 11 },
  };
  const dimensions = [
    { skuId: "sku-a", sku1: "Large", length: 33, width: 22, height: 17, weight: 680 },
    { skuId: "sku-b", sku1: "Small", length: 28, width: 20.5, height: 35, weight: 850 },
  ];
  const rows = [createSkuRow("Large"), createSkuRow("Small")];
  const model = {
    offerBaseInfo: { subject: "Test product", mainImageList: ["https://img.example.test/main.jpg"] },
    tradeModel: { skuMap, minPrice: "9.50", maxPrice: "12.50" },
    detailDescription: { pieceWeightScale: { pieceWeightScaleInfo: dimensions } },
  };
  const window = { context: { result: { global: { globalData: { model } }, data: {} } } };
  const document = {
    title: "Test product - Alibaba",
    querySelector: (selector: string) => selector.startsWith("h1,")
      ? { textContent: "Test product" }
      : selector.startsWith("#gallery img,") ? {} : null,
    querySelectorAll: (selector: string) => selector.startsWith("script[type=\"application/ld+json\"]")
      ? []
      : selector.startsWith("#skuSelection .ant-table-tbody") ? rows : [],
  };
  const chrome = { runtime: { onMessage: { addListener: () => undefined } } };
  const source = `${backgroundSource}\ncollectMarketplaceProduct("1688");`;
  return runInNewContext(source, {
    chrome,
    document,
    location: { href: "https://detail.1688.com/offer/123456.html", pathname: "/offer/123456.html" },
    window,
    URL,
    Date,
    Set,
    WeakSet,
    setTimeout,
  }) as Promise<{ skuVariants: Array<{ sourceSkuId: string; packageDimensions: Record<string, string> }>; missingFields: string[] }>;
}

describe("1688 collector", () => {
  it("deduplicates DOM SKU rows and maps supplier dimensions to millimeters and grams", async () => {
    const product = await collect1688Product();

    expect(product.skuVariants).toHaveLength(2);
    expect(product.skuVariants.map((variant) => variant.sourceSkuId)).toEqual(["sku-a", "sku-b"]);
    expect(product.skuVariants[0]!.packageDimensions).toEqual({
      depth: "330", width: "220", height: "170", dimensionUnit: "mm", weight: "680", weightUnit: "g",
    });
    expect(product.skuVariants[1]!.packageDimensions).toEqual({
      depth: "280", width: "205", height: "350", dimensionUnit: "mm", weight: "850", weightUnit: "g",
    });
    expect(product.missingFields).not.toContain("SKU 尺寸/重量");
  });
});
