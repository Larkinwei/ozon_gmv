import { describe, expect, it } from "vitest";

import { mergeSellerSource } from "../src/shared/publish-source";
import type { ResellSourceView } from "../src/shared/contracts";

const mySource: ResellSourceView = {
  sku: "2092858314",
  productName: "MY 标题",
  sourceType: "follow_sell",
  category: "拖鞋",
  typeId: null,
  descriptionCategoryId: null,
  currentPrice: { amount: "122.86", currency: "RUB" },
  productUrl: "https://www.ozon.ru/product/2092858314/",
  imageUrl: "https://cdn.example.com/my.jpg",
  images: [],
  monthlyUnits: 61,
  monthlySales: { amount: "7494.38", currency: "RUB" },
  captureDay: "2026-08-18",
};

describe("mergeSellerSource", () => {
  it("does not let zero analytics or empty metadata erase the MY snapshot", () => {
    const sellerSource: ResellSourceView = {
      ...mySource,
      sourceType: "seller_bridge",
      productName: "Seller 标题",
      category: "",
      currentPrice: { amount: "0", currency: "RUB" },
      monthlyUnits: 0,
      monthlySales: { amount: "0", currency: "RUB" },
      captureDay: "",
      images: [{ id: "seller-image", url: "https://cdn.example.com/seller.jpg", fileName: "seller.jpg", mimeType: "image/jpeg", byteSize: 0, width: 1, height: 1, source: "source" }],
    };

    const merged = mergeSellerSource(mySource, sellerSource);

    expect(merged.productName).toBe("Seller 标题");
    expect(merged.category).toBe("拖鞋");
    expect(merged.currentPrice).toEqual(mySource.currentPrice);
    expect(merged.monthlyUnits).toBe(61);
    expect(merged.monthlySales).toEqual(mySource.monthlySales);
    expect(merged.captureDay).toBe("2026-08-18");
    expect(merged.images).toHaveLength(1);
  });
});
