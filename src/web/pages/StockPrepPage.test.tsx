// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    scanStockPrep: vi.fn(),
    createStockPrepBatch: vi.fn(),
    fetchStockPrepBatch: vi.fn(),
    resetStockPrepOrders: vi.fn(),
    logout: vi.fn(),
  };
});

afterEach(() => { cleanup(); window.localStorage.clear(); vi.clearAllMocks(); });

function renderPage(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(<MemoryRouter><QueryClientProvider client={client}><StockPrepPage /></QueryClientProvider></MemoryRouter>);
}

describe("StockPrepPage", () => {
  it("preselects pending orders and recalculates the cart quantity when an order is unchecked", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchUpdateStatus).mockResolvedValue({ state: "up-to-date" } as UpdateView);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" } });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/747713283348.html", offerId: "1645-2-XXL", skuId: "6103279203988", status: "pending", quantity: 3, error: null, orders: [
      { postingNumber: "post-1", offerId: "1645-2-XXL", productName: "蓝底叶子XXL", quantity: 1, state: "pending", error: null, selectedByDefault: true },
      { postingNumber: "post-2", offerId: "1645-2-XXL", productName: "蓝底叶子XXL", quantity: 2, state: "pending", error: null, selectedByDefault: true },
    ] }] });
    renderPage();
    await screen.findByRole("option", { name: "YOGOLD" });
    fireEvent.change(screen.getByLabelText("Ozon 店铺"), { target: { value: "store-1" } });
    await waitFor(() => expect(api.fetchStockPrepState).toHaveBeenCalledWith("store-1"));
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1"));

    await screen.findByRole("button", { name: "加购所选 2 笔 · 3 件" });
    expect(screen.getByRole("checkbox", { name: "选择订单 post-1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选择订单 post-2" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择订单 post-2" }));
    expect(screen.getByRole("button", { name: "加购所选 1 笔 · 1 件" })).toBeEnabled();
  });

  it("allows failed orders to be manually selected for retry, but does not select them by default", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchUpdateStatus).mockResolvedValue({ state: "up-to-date" } as UpdateView);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" } });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/747713283348.html", offerId: "1645-2-XXL", skuId: "6103279203988", status: "pending", quantity: 2, error: null, orders: [
      { postingNumber: "post-failed", offerId: "1645-2-XXL", productName: "蓝底叶子XXL", quantity: 1, state: "failed", error: "页面超时", selectedByDefault: false },
      { postingNumber: "post-pending", offerId: "1645-2-XXL", productName: "蓝底叶子XXL", quantity: 1, state: "pending", error: null, selectedByDefault: true },
    ] }] });
    renderPage();
    await screen.findByRole("option", { name: "YOGOLD" });
    fireEvent.change(screen.getByLabelText("Ozon 店铺"), { target: { value: "store-1" } });
    await waitFor(() => expect(api.fetchStockPrepState).toHaveBeenCalledWith("store-1"));
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1"));
    const failed = await screen.findByRole("checkbox", { name: "选择订单 post-failed" });
    expect(failed).not.toBeChecked();
    expect(failed).toBeEnabled();
    expect(screen.getByRole("button", { name: "加购所选 1 笔 · 1 件" })).toBeInTheDocument();
    fireEvent.click(failed);
    await waitFor(() => expect(screen.getByRole("button", { name: "加购所选 2 笔 · 2 件" })).toBeInTheDocument());
  });

  it("lets operators withdraw an added order after warning that the cart quantity will remain", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchUpdateStatus).mockResolvedValue({ state: "up-to-date" } as UpdateView);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" } });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/747713283348.html", offerId: "1645-2-XXL", skuId: "6103279203988", status: "added", quantity: 1, error: null, orders: [
      { postingNumber: "post-added", offerId: "1645-2-XXL", productName: "蓝底叶子XXL", quantity: 1, state: "added", error: null, selectedByDefault: false },
    ] }] });
    vi.mocked(api.resetStockPrepOrders).mockResolvedValue({ resetCount: 1 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();

    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1"));
    fireEvent.click(screen.getByRole("button", { name: /已加购/ }));
    fireEvent.click(await screen.findByRole("button", { name: "撤回本组" }));
    await waitFor(() => expect(api.resetStockPrepOrders).toHaveBeenCalledWith("store-1", [{ postingNumber: "post-added", offerId: "1645-2-XXL" }]));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("1688 购物车不会扣减"));
    expect(api.scanStockPrep).toHaveBeenCalledTimes(1);
  });
});
