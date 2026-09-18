// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrderDetail, OrderSearchPage } from "../../shared/contracts";
import * as api from "../api";
import OrderSearchPageView from "./OrderSearchPage";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, fetchOrderSearch: vi.fn(), fetchOrderDetail: vi.fn() };
});

const searchPage: OrderSearchPage = {
  page: 1,
  pageSize: 20,
  total: 1,
  items: [{
    id: "00000000-0000-4000-8000-000000000001",
    platform: "ozon",
    externalOrderId: "posting-1",
    postingNumber: "posting-1",
    orderNumber: "order-1",
    storeId: "store-1",
    storeName: "北极星旗舰店",
    storeColor: "#3B82F6",
    orderAt: "2026-09-18T04:00:00.000Z",
    amount: { amount: "199.00", currency: "RUB" },
    imageUrl: "https://cdn.example.com/blue.jpg",
    itemCount: 1,
    productNames: ["蓝色旅行收纳包"],
    skus: ["SKU-BLUE"],
    offerIds: ["OFFER-BLUE"],
    fulfillment: "FBS",
    status: "awaiting_packaging",
    cancelled: false,
  }],
};

const detail: OrderDetail = {
  id: searchPage.items[0]!.id,
  platform: "ozon",
  externalOrderId: "posting-1",
  postingNumber: "posting-1",
  orderNumber: "order-1",
  storeId: "store-1",
  storeName: "北极星旗舰店",
  storeColor: "#3B82F6",
  orderAt: "2026-09-18T04:00:00.000Z",
  fulfillment: "FBS",
  status: "awaiting_packaging",
  substatus: null,
  cancelled: false,
  cancelledAt: null,
  amount: { amount: "199.00", currency: "RUB" },
  items: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/orders/search"]}>
        <OrderSearchPageView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OrderSearchPage", () => {
  it("loads the default recent 90-day search and submits keyword filters", async () => {
    vi.mocked(api.fetchOrderSearch).mockResolvedValue(searchPage);
    renderPage();

    expect(await screen.findByText("蓝色旅行收纳包")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "蓝色旅行收纳包 主图" })).toHaveAttribute("src", "https://cdn.example.com/blue.jpg");
    const initialFilters = vi.mocked(api.fetchOrderSearch).mock.calls[0]?.[0];
    expect(initialFilters?.from).toBeDefined();
    expect(initialFilters?.to).toBeDefined();
    expect(Date.parse(initialFilters!.to!) - Date.parse(initialFilters!.from!)).toBe(90 * 24 * 60 * 60 * 1000);

    fireEvent.change(screen.getByPlaceholderText("订单号、商品名称或 SKU"), { target: { value: "SKU-BLUE" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索订单" }));
    await waitFor(() => expect(api.fetchOrderSearch).toHaveBeenLastCalledWith(expect.objectContaining({ q: "SKU-BLUE", page: 1, pageSize: 20 })));
  });

  it("opens the existing order detail drawer from a result", async () => {
    vi.mocked(api.fetchOrderSearch).mockResolvedValue(searchPage);
    vi.mocked(api.fetchOrderDetail).mockResolvedValue(detail);
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
    expect(await screen.findByRole("dialog", { name: "订单详情" })).toBeInTheDocument();
    expect(api.fetchOrderDetail).toHaveBeenCalledWith(searchPage.items[0]!.id);
  });
});
