// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SelectionMarketProductPage } from "../../shared/contracts";
import { MarketProductsPanel } from "./SelectionPage";

const emptyPage: SelectionMarketProductPage = {
  items: [],
  facets: { categoryLevel1: ["Beauty & Hygiene"], categoryLevel3: ["洗发水"], productFlags: ["Лидер по продажам"] },
  page: 1,
  pageSize: 20,
  total: 0,
};

const resultPage: SelectionMarketProductPage = {
  ...emptyPage,
  total: 1,
  items: [{
    id: "00000000-0000-4000-8000-000000000001",
    ozonProductId: "1710550744",
    name: "Святой Источник Hair Shampoo",
    ozonUrl: "https://www.ozon.ru/product/1710550744",
    seller: "Beauty Seller",
    brand: "VOIS",
    categoryLevel1: "Beauty & Hygiene",
    categoryLevel3: "洗发水",
    productFlags: ["Лидер по продажам"],
    snapshotDate: "2026-08-11",
    reportPeriodDays: 28,
    orderedAmount: { amount: "82753618.00", currency: "RUB" },
    turnoverGrowth: -0.12,
    orderedUnits: 79_193,
    averagePrice: { amount: "1045.00", currency: "RUB" },
    impressionToOrderRate: 0.042,
    missedSales: 2_500,
    outOfStockDays: null,
  }],
};

const noOp = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

interface ProductPanelFixtureProps {
  marketProductCount: number;
  data: SelectionMarketProductPage;
  search?: string;
  onClearFilters?: () => void;
}

/** Renders the product panel with stable defaults for empty-state tests. */
function ProductPanelFixture(props: ProductPanelFixtureProps): React.JSX.Element {
  return <MarketProductsPanel
    page={1}
    totalPages={1}
    marketProductCount={props.marketProductCount}
    data={props.data}
    loading={false}
    error={null}
    search={props.search ?? ""}
    categoryLevel1=""
    categoryLevel3=""
    productFlag=""
    minimumPrice=""
    maximumPrice=""
    sort="orderedAmount"
    onSearch={noOp}
    onCategoryLevel1={noOp}
    onCategoryLevel3={noOp}
    onProductFlag={noOp}
    onMinimumPrice={noOp}
    onMaximumPrice={noOp}
    onSort={noOp}
    onPage={noOp}
    onOpen={noOp}
    onImport={noOp}
    onClearFilters={props.onClearFilters ?? noOp}
  />;
}

function FilteredProductsHarness(): React.JSX.Element {
  const [filtered, setFiltered] = useState(true);
  return <ProductPanelFixture
    marketProductCount={1}
    data={filtered ? emptyPage : resultPage}
    search={filtered ? "水" : ""}
    onClearFilters={() => setFiltered(false)}
  />;
}

describe("MarketProductsPanel", () => {
  it("keeps the import action for a database without product reports", () => {
    render(<ProductPanelFixture marketProductCount={0} data={emptyPage} />);

    expect(screen.getByText("还没有热销商品数据")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导入商品报表" })).toBeInTheDocument();
    expect(screen.queryByText("没有匹配的热销商品")).not.toBeInTheDocument();
  });

  it("shows a filtered empty state and restores results after clearing filters", () => {
    render(<FilteredProductsHarness />);

    expect(screen.getByRole("textbox", { name: "搜索商品、品牌、卖家、类目或标签" })).toHaveValue("水");
    expect(screen.getByText("没有匹配的热销商品")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导入商品报表" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清除筛选" }));

    expect(screen.getByText("Святой Источник Hair Shampoo")).toBeInTheDocument();
    expect(screen.queryByText("没有匹配的热销商品")).not.toBeInTheDocument();
  });
});
