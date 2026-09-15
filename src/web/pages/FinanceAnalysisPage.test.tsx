// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDemoFinanceExceptions, createDemoFinanceOrderPage, createDemoFinanceOverview, createDemoFinanceSync, demoStores } from "../demo-data";
import * as api from "../api";
import FinanceAnalysisPage from "./FinanceAnalysisPage";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchStores: vi.fn(),
    fetchFinanceOverview: vi.fn(),
    fetchFinanceOrders: vi.fn(),
    fetchFinanceExceptions: vi.fn(),
    fetchFinanceOrderDetail: vi.fn(),
    fetchFinanceSync: vi.fn(),
    startFinanceSync: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  vi.mocked(api.fetchStores).mockResolvedValue(demoStores);
  vi.mocked(api.fetchFinanceOverview).mockImplementation(async (month, storeId) => createDemoFinanceOverview(month, storeId));
  vi.mocked(api.fetchFinanceOrders).mockImplementation(async (filters) => createDemoFinanceOrderPage(filters.month, filters.storeId, filters.sku, filters.status, filters.page ?? 1, filters.pageSize ?? 20));
  vi.mocked(api.fetchFinanceExceptions).mockImplementation(async (month, storeId) => createDemoFinanceExceptions(month, storeId));
  vi.mocked(api.fetchFinanceOrderDetail).mockImplementation(async (postingId, month) => ({
    ...createDemoFinanceOverview(month ?? "2026-09").skuSummaries[0],
    ...createDemoFinanceOrderPage(month ?? "2026-09", "all").items.find((order) => order.postingId === postingId),
  } as never));
  vi.mocked(api.fetchFinanceSync).mockResolvedValue(createDemoFinanceSync("2026-09"));
  vi.mocked(api.startFinanceSync).mockResolvedValue(createDemoFinanceSync("2026-09"));
});

function renderFinancePage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><FinanceAnalysisPage /></QueryClientProvider>);
}

describe("FinanceAnalysisPage", () => {
  it("shows fee categories and separates order and settlement currencies", async () => {
    renderFinancePage();

    await waitFor(() => expect(screen.getAllByText("平台佣金").length).toBeGreaterThan(0));

    expect(screen.getAllByText("销售件数").length).toBeGreaterThan(0);
    expect(screen.getAllByText("待确认费用").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/结算：/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/订单：/).length).toBeGreaterThan(0);
    expect(screen.queryByText("未产生结算流水")).not.toBeInTheDocument();
  });

  it("reuses fresh results when switching back to a previously visited store", async () => {
    renderFinancePage();
    const storeSelect = await screen.findByLabelText("店铺");

    await waitFor(() => expect(api.fetchFinanceOverview).toHaveBeenCalledTimes(1));
    expect(api.fetchFinanceOrders).toHaveBeenCalledTimes(1);
    expect(api.fetchFinanceExceptions).toHaveBeenCalledTimes(1);

    fireEvent.change(storeSelect, { target: { value: demoStores[0]!.id } });
    await waitFor(() => expect(api.fetchFinanceOverview).toHaveBeenCalledTimes(2));
    expect(api.fetchFinanceOrders).toHaveBeenCalledTimes(2);
    expect(api.fetchFinanceExceptions).toHaveBeenCalledTimes(2);

    fireEvent.change(storeSelect, { target: { value: "all" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.fetchFinanceOverview).toHaveBeenCalledTimes(2);
    expect(api.fetchFinanceOrders).toHaveBeenCalledTimes(2);
    expect(api.fetchFinanceExceptions).toHaveBeenCalledTimes(2);
  });

  it("refreshes every finance query from the local projection together", async () => {
    renderFinancePage();

    await waitFor(() => expect(api.fetchFinanceOverview).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "刷新数据" }));

    await waitFor(() => expect(api.fetchFinanceOverview).toHaveBeenCalledTimes(2));
    expect(api.fetchFinanceOrders).toHaveBeenCalledTimes(2);
    expect(api.fetchFinanceExceptions).toHaveBeenCalledTimes(2);
  });
});
