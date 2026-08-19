// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MyDataOverview, MyDataProductPage, MyDataProductView } from "../../shared/contracts";
import { MyDataPanel } from "./MyDataPanel";

const { fetchOverview, fetchProducts, clearMyData, commitMyDataImport, previewMyDataImport } = vi.hoisted(() => ({
  fetchOverview: vi.fn(),
  fetchProducts: vi.fn(),
  clearMyData: vi.fn(),
  commitMyDataImport: vi.fn(),
  previewMyDataImport: vi.fn(),
}));

vi.mock("../api", () => ({
  clearMyData,
  commitMyDataImport,
  fetchMyDataOverview: fetchOverview,
  fetchMyDataProducts: fetchProducts,
  previewMyDataImport,
}));

const overview: MyDataOverview = {
  productCount: 40,
  monthlyUnits: 40,
  monthlySales: { amount: "400", currency: "RUB" },
  averageOrderValue: { amount: "10", currency: "RUB" },
  latestCaptureDay: "2026-08-19",
  captureDays: ["2026-08-19"],
  keywordCount: 0,
  importCount: 1,
};

function product(sku: string): MyDataProductView {
  return {
    id: sku,
    sku,
    productName: `商品 ${sku}`,
    currentPrice: { amount: "10", currency: "RUB" },
    monthlyUnits: 1,
    monthlySales: { amount: "10", currency: "RUB" },
    averageOrderValue: { amount: "10", currency: "RUB" },
    impressions: 10,
    conversionRate: 1,
    discountRate: 0,
    category: "家居",
    keyword: "",
    productUrl: "",
    imageUrl: null,
    status: "ready",
    fulfillmentMode: "FBS",
    capturedAt: "2026-08-19T00:00:00.000Z",
    captureDay: "2026-08-19",
  };
}

function page(pageNumber: number, pageSize: number): MyDataProductPage {
  const start = (pageNumber - 1) * pageSize + 1;
  return {
    items: [product(String(start))],
    page: pageNumber,
    pageSize,
    total: 40,
    latestCaptureDay: "2026-08-19",
    captureDays: ["2026-08-19"],
    keywords: [],
    facets: { categories: ["家居"], fulfillmentModes: ["FBS"] },
  };
}

function renderPanel(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><MemoryRouter><MyDataPanel onNotice={vi.fn()} /></MemoryRouter></QueryClientProvider>);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("MyDataPanel pagination", () => {
  it("uses the first page click immediately while the next query is loading", async () => {
    let resolvePageTwo!: (value: MyDataProductPage) => void;
    const pageTwo = new Promise<MyDataProductPage>((resolve) => { resolvePageTwo = resolve; });
    fetchOverview.mockResolvedValue(overview);
    fetchProducts.mockImplementation(async (filters: { page: number; pageSize: number }) => {
      if (filters.page === 2) return pageTwo;
      return page(filters.page, filters.pageSize);
    });

    renderPanel();
    expect(await screen.findByText("商品 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "2" }));
    await waitFor(() => expect(fetchProducts).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 20 })));
    expect(screen.getByRole("button", { name: "2" })).toBeDisabled();

    resolvePageTwo(page(2, 20));
    expect(await screen.findByText("商品 21")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "2" })).toHaveAttribute("aria-current", "page");
  });
});
