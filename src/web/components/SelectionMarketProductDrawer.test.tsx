// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SelectionMarketProductDetail } from "../../shared/contracts";
import { SelectionMarketProductDrawer } from "./SelectionMarketProductDrawer";

const snapshot = {
  id: "00000000-0000-4000-8000-000000000001",
  ozonProductId: "1710550744",
  name: "VOIS Hair Shampoo, 2000 ml",
  ozonUrl: "https://www.ozon.ru/product/1710550744",
  seller: "VOIS",
  brand: "VOIS",
  categoryLevel1: "Beauty & Hygiene",
  categoryLevel3: "洗发水",
  productFlags: ["Лидер по продажам"],
  snapshotDate: "2026-08-11",
  reportPeriodDays: 28,
  orderedAmount: { amount: "82753618.00", currency: "RUB" as const },
  turnoverGrowth: 0.33,
  orderedUnits: 79193,
  averagePrice: { amount: "1045.00", currency: "RUB" as const },
  impressionToOrderRate: 0.042,
  missedSales: 0,
  outOfStockDays: 4,
  minimumPrice: { amount: "999.00", currency: "RUB" as const },
  purchaseRate: 0.911,
  dailySalesAmount: { amount: "2357414.00", currency: "RUB" as const },
  dailySalesUnits: 2269,
  endingInventoryUnits: 179251,
  fulfillmentScheme: "FBO",
  volumeLiters: 6.5,
  impressions: 4820000,
  searchCatalogViews: 1200000,
  cardViews: 840000,
  searchCatalogCartRate: 0.132,
  cardCartRate: 0.168,
  promotionDiscountRate: 0.12,
  promotedOrderShare: 0.64,
  promotionDays: 24,
  advertisedDays: 27,
  advertisingCostShare: 0.083,
  productCardCreatedDate: "2024-09-10",
};
const product: SelectionMarketProductDetail = { ...snapshot, history: [snapshot] };

afterEach(() => {
  document.body.style.overflow = "";
});

describe("SelectionMarketProductDrawer", () => {
  it("exposes official metrics and supports keyboard closing and candidate creation", () => {
    const onClose = vi.fn();
    const onAddCandidate = vi.fn();
    render(<SelectionMarketProductDrawer product={product} loading={false} onClose={onClose} onAddCandidate={onAddCandidate} />);

    expect(screen.getByRole("dialog", { name: "热销商品详情" })).toBeInTheDocument();
    expect(screen.getByText("79,193 件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加入候选池" }));
    expect(onAddCandidate).toHaveBeenCalledWith(product);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
