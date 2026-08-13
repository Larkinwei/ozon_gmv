// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscoveryProductsPanel, DiscoveryQueriesPanel } from "./SelectionDiscoveryPanels";

vi.mock("../api", () => ({
  fetchSelectionProductRanking: vi.fn(),
  fetchSelectionProductRankings: vi.fn(async () => ({
    items: [{
      id: "product-1", ozonProductId: "171", name: "VOIS Hair Shampoo, 2000 ml", ozonUrl: "https://ozon.ru/product/171",
      photoUrl: null, seller: "VOIS", brand: "VOIS", categoryLevel1: "美容和卫生", categoryLevel3: "洗发水",
      productFlags: [], snapshotDate: "2026-08-13", reportPeriodDays: 28, orderedAmount: { amount: "89124482.12", currency: "RUB" },
      turnoverGrowth: 0.434, orderedUnits: 87758, averagePrice: { amount: "1015.57", currency: "RUB" },
      impressionToOrderRate: 0.0038, missedSales: 0, outOfStockDays: 0, rank: 1, scope: "global", scopeCategoryId: null, stock: 169550,
    }],
    facets: { categoryLevel1: ["美容和卫生"], categoryLevel3: ["洗发水"], productFlags: [] },
    page: 1, pageSize: 20, total: 1, periodDays: 28, scope: "global", categoryId: null,
    snapshotId: "snapshot", collectedAt: "2026-08-13T00:00:00.000Z",
  })),
  fetchSelectionMarketQueries: vi.fn(async () => ({
    items: [{
      id: "query-1", phrase: "сумка женская", rank: 1, scope: "global", groupName: null,
      searchCount: 244000, searchesWithCart: 37409, cartRate: 0.1533, orderedUnits: 6290, orderRate: 0.0211,
      orderedAmount: { amount: "12429403.00", currency: "RUB" }, averagePrice: { amount: "2332.00", currency: "RUB" },
      productViews: 120, competingSellers: 64, noInteractionCount: 0, noInteractionRate: 0.415,
      noResultCount: 0, noResultRate: 0.001, averageProductCount: 120, wordstatStatus: "missing",
    }],
    groups: [], page: 1, pageSize: 20, total: 1, periodDays: 7, scope: "global", categoryId: null,
    categoryLink: null, snapshotId: "snapshot", collectedAt: "2026-08-13T00:00:00.000Z",
  })),
}));

afterEach(() => vi.clearAllMocks());

function renderWithQueryClient(element: React.JSX.Element): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
}

describe("selection discovery ranking tables", () => {
  it("separates localized product identity from sales metrics", async () => {
    renderWithQueryClient(<DiscoveryProductsPanel category={null} periodDays={28} onPeriod={vi.fn()} onCategoryMode={vi.fn()} onClearCategory={vi.fn()} onCandidate={vi.fn()} />);

    expect(await screen.findByText("VOIS Hair Shampoo, 2000 ml")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "商品信息" })).toBeInTheDocument();
    expect(screen.getByText("洗发水")).toBeInTheDocument();
    expect(screen.getByText("87,758 件")).toBeInTheDocument();
  });

  it("labels Russian buyer queries and splits every secondary rate onto its own line", async () => {
    renderWithQueryClient(<DiscoveryQueriesPanel category={null} selectedIds={new Set()} onToggle={vi.fn()} onWordstat={vi.fn()} wordstatPending={false} onCategoryMode={vi.fn()} onClearCategory={vi.fn()} />);

    expect(await screen.findByText("сумка женская")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "热搜词（俄文原词）" })).toBeInTheDocument();
    expect(screen.getByText("加购率 15.33%")).toBeInTheDocument();
    expect(screen.getByText("下单率 2.11%")).toBeInTheDocument();
  });
});
