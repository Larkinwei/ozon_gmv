// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StoreView, UpdateView } from "../../shared/contracts";
import * as api from "../api";
import StockPrepPage from "./StockPrepPage";

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchStores: vi.fn(),
    fetchUpdateStatus: vi.fn(),
    fetchStockPrepConnection: vi.fn(),
    fetchStockPrepState: vi.fn(),
    fetchStockPrepBlacklist: vi.fn(),
    fetchStockPrepFulfillmentPostings: vi.fn(),
    approveStockPrepRiskOrder: vi.fn(),
    scanStockPrep: vi.fn(),
    createStockPrepBatch: vi.fn(),
    fetchStockPrepBatch: vi.fn(),
    resetStockPrepOrders: vi.fn(),
    logout: vi.fn(),
  };
});

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  } });
  vi.mocked(api.fetchStockPrepBlacklist).mockResolvedValue([]);
});
afterEach(() => { cleanup(); window.localStorage.clear(); vi.clearAllMocks(); });

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<MemoryRouter><QueryClientProvider client={client}><StockPrepPage /></QueryClientProvider></MemoryRouter>);
}

describe("StockPrepPage", () => {
  it("prioritizes and automatically selects fully added awaiting-packaging postings", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchUpdateStatus).mockResolvedValue({ state: "up-to-date" } as UpdateView);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [
      { offerUrl: "https://detail.1688.com/offer/1.html", offerId: "SKU-A", skuId: "1688-A", imageUrl: null, status: "added", quantity: 1, error: null, orders: [
        { postingNumber: "post-added", offerId: "SKU-A", imageUrl: null, productName: "商品 A", quantity: 1, state: "added", error: null, selectedByDefault: false },
      ] },
      { offerUrl: "https://detail.1688.com/offer/2.html", offerId: "SKU-B", skuId: "1688-B", imageUrl: null, status: "added", quantity: 1, error: null, orders: [
        { postingNumber: "post-incomplete", offerId: "SKU-B", imageUrl: null, productName: "商品 B", quantity: 1, state: "added", error: null, selectedByDefault: false },
      ] },
    ] });
    vi.mocked(api.fetchStockPrepFulfillmentPostings).mockResolvedValue({ postings: [
      { posting_number: "post-added", status: "awaiting_packaging", sku_count: 1, piece_count: 1, added_sku_count: 1, offer_ids: "SKU-A", can_prepare: true, prepare_block_reason: null },
      { posting_number: "post-incomplete", status: "awaiting_packaging", sku_count: 1, piece_count: 1, added_sku_count: 0, offer_ids: "SKU-B", can_prepare: false, prepare_block_reason: "商品尚未标记已加购" },
      { posting_number: "post-prepared", status: "awaiting_deliver", sku_count: 1, piece_count: 1, added_sku_count: 1, offer_ids: "SKU-C", can_prepare: false, prepare_block_reason: "Ozon状态已变化，请刷新订单" },
    ] });
    renderPage();
    await screen.findByRole("option", { name: "YOGOLD" });
    fireEvent.change(screen.getByLabelText("Ozon 店铺"), { target: { value: "store-1" } });
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    fireEvent.click(await screen.findByRole("button", { name: "已加购 · 2 单 · 2 件" }));

    expect(await screen.findByText("可自动备货 1 单 / 待人工处理 1 单")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步 Ozon 备货" })).toBeEnabled();
    expect(screen.getByText("商品尚未标记已加购")).toBeInTheDocument();
    expect(screen.getAllByText("post-added")).toHaveLength(1);
    expect(screen.getAllByRole("columnheader", { name: "Ozon 备货" })).toHaveLength(2);
    expect(screen.getByText("post-added").compareDocumentPosition(screen.getByText("post-incomplete")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("preselects pending orders and recalculates the cart quantity when an order is unchecked", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchUpdateStatus).mockResolvedValue({ state: "up-to-date" } as UpdateView);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: new Date(2026, 10, 18, 12, 34, 56).getTime() });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/747713283348.html", offerId: "1645-2-XXL", skuId: "6103279203988", imageUrl: null, status: "pending", quantity: 3, error: null, orders: [
      { postingNumber: "post-1", offerId: "1645-2-XXL", imageUrl: null, productName: "蓝底叶子XXL", quantity: 1, state: "pending", error: null, selectedByDefault: true },
      { postingNumber: "post-2", offerId: "1645-2-XXL", imageUrl: null, productName: "蓝底叶子XXL", quantity: 2, state: "pending", error: null, selectedByDefault: true },
    ] }] });
    renderPage();
    await screen.findByRole("option", { name: "YOGOLD" });
    fireEvent.change(screen.getByLabelText("Ozon 店铺"), { target: { value: "store-1" } });
    await waitFor(() => expect(api.fetchStockPrepState).toHaveBeenCalledWith("store-1"));
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    expect(await screen.findByText(/最近订单同步：2026-11-18 12:34:56/u)).toBeInTheDocument();

    await screen.findByRole("button", { name: "加购已选 2 条明细 · 3 件" });
    expect(screen.getAllByText("1 组")).toHaveLength(2);
    expect(screen.getAllByText("2 张发货单 · 3 件")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "选择订单 post-1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选择订单 post-2" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择订单 post-2" }));
    expect(screen.getByRole("button", { name: "加购已选 1 条明细 · 1 件" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "刷新订单" }));
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", true));
  });

  it("allows failed orders to be manually selected for retry, but does not select them by default", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchUpdateStatus).mockResolvedValue({ state: "up-to-date" } as UpdateView);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/747713283348.html", offerId: "1645-2-XXL", skuId: "6103279203988", imageUrl: null, status: "pending", quantity: 2, error: null, orders: [
      { postingNumber: "post-failed", offerId: "1645-2-XXL", imageUrl: null, productName: "蓝底叶子XXL", quantity: 1, state: "failed", error: "页面超时", selectedByDefault: false },
      { postingNumber: "post-pending", offerId: "1645-2-XXL", imageUrl: null, productName: "蓝底叶子XXL", quantity: 1, state: "pending", error: null, selectedByDefault: true },
    ] }] });
    renderPage();
    await screen.findByRole("option", { name: "YOGOLD" });
    fireEvent.change(screen.getByLabelText("Ozon 店铺"), { target: { value: "store-1" } });
    await waitFor(() => expect(api.fetchStockPrepState).toHaveBeenCalledWith("store-1"));
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    const failed = await screen.findByRole("checkbox", { name: "选择订单 post-failed" });
    expect(failed).not.toBeChecked();
    expect(failed).toBeEnabled();
    expect(screen.getByRole("button", { name: "加购已选 1 条明细 · 1 件" })).toBeInTheDocument();
    fireEvent.click(failed);
    await waitFor(() => expect(screen.getByRole("button", { name: "加购已选 2 条明细 · 2 件" })).toBeInTheDocument());
  });

  it("lets operators withdraw an added order after warning that the cart quantity will remain", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchUpdateStatus).mockResolvedValue({ state: "up-to-date" } as UpdateView);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/747713283348.html", offerId: "1645-2-XXL", skuId: "6103279203988", imageUrl: null, status: "added", quantity: 1, error: null, orders: [
      { postingNumber: "post-added", offerId: "1645-2-XXL", imageUrl: null, productName: "蓝底叶子XXL", quantity: 1, state: "added", error: null, selectedByDefault: false },
    ] }] });
    vi.mocked(api.resetStockPrepOrders).mockResolvedValue({ resetCount: 1 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();

    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    fireEvent.click(screen.getByRole("button", { name: "已加购 · 1 单 · 1 件" }));
    fireEvent.click(await screen.findByRole("button", { name: "撤回本组" }));
    await waitFor(() => expect(api.resetStockPrepOrders).toHaveBeenCalledWith("store-1", [{ postingNumber: "post-added", offerId: "1645-2-XXL" }]));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("1688 购物车不会扣减"));
    expect(api.scanStockPrep).toHaveBeenCalledTimes(1);
  });

  it("requires an explicit approval before a multi-item order can be selected", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/747713283348.html", offerId: "1645-2-XXL", skuId: "6103279203988", imageUrl: null, status: "pending", quantity: 2, error: null, orders: [
      { postingNumber: "12345678-order-1", orderNumber: "order-risk", buyerPrefix: "12345678", currentOrderCount: 1, currentOrderIndex: 1, offerId: "1645-2-XXL", imageUrl: null, productName: "蓝底叶子XXL", quantity: 2, orderQuantity: 2, riskLevel: "review", approved: false, state: "pending", error: null, selectedByDefault: false, buyerHistory: { syncState: "failed", syncError: "Ozon API 400: PERIOD_IS_TOO_LONG", ordersInYear: 1, deliveredOrders: 0, cancelledOrders: 0, refusalOrders: 0, returnCount: 0, returnedPieces: 0, latestOutcome: "awaiting_packaging", latestAt: Date.now(), orderSequenceByPostingNumber: {}, recentOrders: [{ postingNumber: "12345678-order-1", status: "awaiting_packaging", orderAt: Date.now(), cancellationInitiator: null, cancellationType: null, returns: [] }] } },
    ] }] });
    vi.mocked(api.approveStockPrepRiskOrder).mockResolvedValue({ approved: true });
    renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: "选择订单 12345678-order-1" });
    expect(checkbox).toBeDisabled();
    expect(screen.getAllByText(/该订单购买多件，需人工确认/)).toHaveLength(2);
    expect(screen.getAllByText("等待打包").length).toBeGreaterThan(0);
    expect(screen.getByText("失败原因：Ozon API 400: PERIOD_IS_TOO_LONG")).toBeInTheDocument();
    expect(screen.queryByText("awaiting_packaging")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "人工放行买家订单组" }));
    await waitFor(() => expect(api.approveStockPrepRiskOrder).toHaveBeenCalledWith("store-1", "12345678"));
  });

});
