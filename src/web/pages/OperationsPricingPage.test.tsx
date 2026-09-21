// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../api";
import OperationsPricingPage from "./OperationsPricingPage";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchExchangeRate: vi.fn(),
    refreshExchangeRate: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } });
  vi.mocked(api.fetchExchangeRate).mockResolvedValue({ available: true, rate: "10", fromCurrency: "CNY", toCurrency: "RUB", source: "测试汇率", effectiveDate: "2026-09-21", checkedAt: "2026-09-21T00:00:00.000Z", fetchedAt: "2026-09-21T00:00:00.000Z", error: null });
  vi.mocked(api.refreshExchangeRate).mockResolvedValue({ available: true, rate: "10", fromCurrency: "CNY", toCurrency: "RUB", source: "测试汇率", effectiveDate: "2026-09-21", checkedAt: "2026-09-21T00:00:00.000Z", fetchedAt: "2026-09-21T00:00:00.000Z", error: null });
});

function renderPricingPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><OperationsPricingPage /></QueryClientProvider>);
}

describe("OperationsPricingPage", () => {
  it("defaults to target-price mode and calculates the workbook example", async () => {
    renderPricingPage();

    expect(screen.getByRole("tab", { name: /目标利润反推售价/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "载入表格示例" }));

    expect(await screen.findByText("建议成交价")).toBeInTheDocument();
    expect(screen.getByText("¥295.51")).toBeInTheDocument();
    expect(screen.queryByText("平台预计回款")).not.toBeInTheDocument();
  });

  it("switches to existing-price mode without showing a suggested price field", async () => {
    renderPricingPage();
    fireEvent.click(screen.getByRole("tab", { name: /已有售价核算利润/ }));

    await waitFor(() => expect(screen.getByText("平台实际成交价")).toBeInTheDocument());
    expect(screen.queryByText("建议成交价")).not.toBeInTheDocument();
    expect(screen.getByText("输入 Ozon 实际成交价，按费用比例和物流估算利润。")).toBeInTheDocument();
    expect(screen.queryByText("平台预计回款")).not.toBeInTheDocument();
  });
});
