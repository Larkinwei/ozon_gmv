// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    prepareStockPrepPosting: vi.fn(),
    approveStockPrepRiskOrder: vi.fn(),
    scanStockPrep: vi.fn(),
    createStockPrepBatch: vi.fn(),
    fetchStockPrepBatch: vi.fn(),
    resetStockPrepOrders: vi.fn(),
    markStockPrepOrdersAdded: vi.fn(),
    markUnmatchedStockPrepOrdersAdded: vi.fn(),
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
  vi.mocked(api.fetchStockPrepFulfillmentPostings).mockResolvedValue({ postings: [] });
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
      { posting_number: "post-prepared", status: "awaiting_deliver", sku_count: 1, piece_count: 1, added_sku_count: 1, offer_ids: "SKU-C", can_prepare: false, prepare_block_reason: "已完成备货，等待发运" },
    ] });
    vi.mocked(api.prepareStockPrepPosting).mockResolvedValue({ status: "awaiting_registration" });
    renderPage();
    await screen.findByRole("option", { name: "YOGOLD" });
    fireEvent.change(screen.getByLabelText("Ozon 店铺"), { target: { value: "store-1" } });
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    fireEvent.click(await screen.findByRole("button", { name: "已加购 · 2 单 · 2 件" }));

    expect(await screen.findByText((_content, element) => element?.tagName === "SMALL" && element.textContent?.startsWith("可提交备货 1 单 / 待人工处理 1 单。") === true)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批量提交 Ozon 备货 (1 单)" })).toBeEnabled();
    const rowPrepareButton = screen.getByRole("button", { name: "提交 Ozon 备货 post-added" });
    expect(rowPrepareButton).toBeEnabled();
    fireEvent.click(rowPrepareButton);
    await waitFor(() => expect(api.prepareStockPrepPosting).toHaveBeenCalledWith("store-1", "post-added"));
    await waitFor(() => expect(api.fetchStockPrepFulfillmentPostings).toHaveBeenCalled());
    expect(api.scanStockPrep).toHaveBeenCalledTimes(1);
    expect(screen.getByText("商品尚未标记已加购")).toBeInTheDocument();
    expect(screen.queryByText("post-added")).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader", { name: "Ozon 备货" })).toHaveLength(1);
    expect(screen.getByText("post-incomplete")).toBeInTheDocument();
  });

  it("limits Ozon preparation to three concurrent postings and reports progress", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    const postingNumbers = ["post-1", "post-2", "post-3", "post-4"];
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: postingNumbers.map((postingNumber, index) => ({ offerUrl: `https://detail.1688.com/offer/${index + 1}.html`, offerId: `SKU-${index + 1}`, skuId: `1688-${index + 1}`, imageUrl: null, status: "added", quantity: 1, error: null, orders: [{ postingNumber, offerId: `SKU-${index + 1}`, imageUrl: null, productName: `商品 ${index + 1}`, quantity: 1, state: "added", error: null, selectedByDefault: false }] })) });
    vi.mocked(api.fetchStockPrepFulfillmentPostings).mockResolvedValue({ postings: postingNumbers.map((postingNumber, index) => ({ posting_number: postingNumber, status: "awaiting_packaging", sku_count: 1, piece_count: 1, added_sku_count: 1, offer_ids: `SKU-${index + 1}`, can_prepare: true, prepare_block_reason: null })) });
    let active = 0;
    let maximumActive = 0;
    const resolvers: Array<() => void> = [];
    vi.mocked(api.prepareStockPrepPosting).mockImplementation(() => new Promise((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      resolvers.push(() => { active -= 1; resolve({ status: "awaiting_registration" }); });
    }));
    renderPage();
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    fireEvent.click(screen.getByRole("button", { name: "已加购 · 4 单 · 4 件" }));
    await screen.findByText((_content, element) => element?.tagName === "SMALL" && element.textContent?.startsWith("可提交备货 4 单") === true);
    fireEvent.click(screen.getByRole("button", { name: "批量提交 Ozon 备货 (4 单)" }));

    await waitFor(() => expect(api.prepareStockPrepPosting).toHaveBeenCalledTimes(3));
    expect(maximumActive).toBe(3);
    expect(screen.getByText(/成功 0 · 处理中 3 · 等待 1 · 失败 0/)).toBeInTheDocument();
    resolvers[0]!();
    await waitFor(() => expect(api.prepareStockPrepPosting).toHaveBeenCalledTimes(4));
    expect(maximumActive).toBe(3);
    for (const resolve of resolvers.slice(1)) resolve();
    await waitFor(() => expect(screen.getByText("已提交 4 单 Ozon 备货，并进入等待发运")).toBeInTheDocument());
  });

  it("selects every purchasable SKU in the same posting together", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: ["A", "B"].map((offerId, index) => ({ offerUrl: `https://detail.1688.com/offer/${index + 1}.html`, offerId, skuId: `1688-${offerId}`, imageUrl: null, status: "pending", quantity: 1, error: null, orders: [{ postingNumber: "post-multi", offerId, imageUrl: null, productName: `商品 ${offerId}`, quantity: 1, state: "pending", error: null, selectedByDefault: false, postingSkuCount: 2, postingPieceCount: 2, postingCanAdd: true, postingBlockReason: null }] })) });
    renderPage();
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    fireEvent.click(screen.getByRole("button", { name: "待采购 · 1 单 · 2 件" }));
    const checkboxes = await screen.findAllByRole("checkbox", { name: "选择订单 post-multi" });
    expect(checkboxes.every((checkbox) => !checkbox.hasAttribute("checked"))).toBe(true);
    fireEvent.click(checkboxes[0]!);
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).toBeChecked();
    expect(screen.getByRole("button", { name: "加入采购车 (2)" })).toBeEnabled();
  });

  it("allows an unmatched SKU to be manually confirmed as procured", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: null, offerId: "MISSING", skuId: null, imageUrl: null, status: "unmatched", quantity: 1, error: "飞书未找到该货号", orders: [{ postingNumber: "post-missing", offerId: "MISSING", imageUrl: null, productName: "未映射商品", quantity: 1, state: "unmatched", error: "飞书未找到该货号", selectedByDefault: false, postingSkuCount: 1, postingPieceCount: 1, postingCanAdd: false, postingBlockReason: "同一发货单中的货号 MISSING 飞书未找到该货号" }] }] });
    vi.mocked(api.markUnmatchedStockPrepOrdersAdded).mockResolvedValue({ markedCount: 1 });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("1688手动采购");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    fireEvent.click(screen.getByRole("button", { name: "待采购 · 1 单 · 1 件" }));
    expect(screen.queryByRole("checkbox", { name: "选择订单 post-missing" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "人工确认已采购" }));

    expect(prompt).toHaveBeenCalledWith(expect.stringContaining("没有飞书映射"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("采购备注：1688手动采购"));
    await waitFor(() => expect(api.markUnmatchedStockPrepOrdersAdded).toHaveBeenCalledWith("store-1", [{ postingNumber: "post-missing", offerId: "MISSING" }], "1688手动采购"));
  });

  it("confirms every eligible order in an unmatched SKU group together", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    const orders = ["post-missing-1", "post-missing-2"].map((postingNumber) => ({ postingNumber, offerId: "MISSING", imageUrl: null, productName: "未映射商品", quantity: 1, state: "unmatched", error: "飞书未找到该货号", selectedByDefault: false, postingSkuCount: 1, postingPieceCount: 1, postingCanAdd: false, postingBlockReason: "同一发货单中的货号 MISSING 飞书未找到该货号" }));
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: null, offerId: "MISSING", skuId: null, imageUrl: null, status: "unmatched", quantity: 2, error: "飞书未找到该货号", orders }] });
    vi.mocked(api.markUnmatchedStockPrepOrdersAdded).mockResolvedValue({ markedCount: 2 });
    vi.spyOn(window, "prompt").mockReturnValue("线下统一采购");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    fireEvent.click(screen.getByRole("button", { name: "待采购 · 2 单 · 2 件" }));
    fireEvent.click(screen.getByRole("button", { name: "批量人工确认已采购（2 单）" }));

    await waitFor(() => expect(api.markUnmatchedStockPrepOrdersAdded).toHaveBeenCalledWith("store-1", [
      { postingNumber: "post-missing-1", offerId: "MISSING" },
      { postingNumber: "post-missing-2", offerId: "MISSING" },
    ], "线下统一采购"));
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
    fireEvent.click(screen.getByRole("button", { name: "待采购 · 2 单 · 3 件" }));

    await screen.findByRole("button", { name: "加入采购车 (2)" });
    expect(screen.getAllByText("1 组")).toHaveLength(2);
    expect(screen.getAllByText("2 张发货单 · 3 件")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: "选择订单 post-1" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "选择订单 post-2" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择订单 post-2" }));
    expect(screen.getByRole("button", { name: "加入采购车 (1)" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "加入采购车 (1)" }));
    expect(screen.getByRole("dialog", { name: "确认加入 1688 采购车" })).toBeInTheDocument();
    expect(screen.getByText("预计件数").nextElementSibling).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
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
    fireEvent.click(screen.getByRole("button", { name: "待采购 · 2 单 · 2 件" }));
    const failed = await screen.findByRole("checkbox", { name: "选择订单 post-failed" });
    expect(failed).not.toBeChecked();
    expect(failed).toBeEnabled();
    expect(screen.getByRole("button", { name: "加入采购车 (1)" })).toBeInTheDocument();
    fireEvent.click(failed);
    await waitFor(() => expect(screen.getByRole("button", { name: "加入采购车 (2)" })).toBeInTheDocument());
  });

  it("uses the unified selection to withdraw an added order without a second confirmation", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchUpdateStatus).mockResolvedValue({ state: "up-to-date" } as UpdateView);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/747713283348.html", offerId: "1645-2-XXL", skuId: "6103279203988", imageUrl: null, status: "added", quantity: 1, error: null, orders: [
      { postingNumber: "post-added", offerId: "1645-2-XXL", imageUrl: null, productName: "蓝底叶子XXL", quantity: 1, state: "added", error: null, selectedByDefault: false },
    ] }] });
    vi.mocked(api.resetStockPrepOrders).mockResolvedValue({ resetCount: 1 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();

    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    fireEvent.click(screen.getByRole("button", { name: "已加购 · 1 单 · 1 件" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择订单 post-added" }));
    fireEvent.click(await screen.findByRole("button", { name: "撤回状态 (1)" }));
    await waitFor(() => expect(api.resetStockPrepOrders).toHaveBeenCalledWith("store-1", [{ postingNumber: "post-added", offerId: "1645-2-XXL" }]));
    expect(confirm).not.toHaveBeenCalled();
    expect(api.scanStockPrep).toHaveBeenCalledTimes(1);
  });

  it("lets operators directly withdraw uncertain orders without the obsolete cart-check action", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/1.html", offerId: "SKU-A", skuId: "1688-A", imageUrl: null, status: "uncertain", quantity: 1, error: null, orders: [
      { postingNumber: "post-uncertain", offerId: "SKU-A", imageUrl: null, productName: "商品 A", quantity: 1, state: "uncertain", error: "购物车增量无法确认", selectedByDefault: false },
    ] }] });
    vi.mocked(api.resetStockPrepOrders).mockResolvedValue({ resetCount: 1 });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();

    await waitFor(() => expect(api.scanStockPrep).toHaveBeenCalledWith("store-1", false));
    expect(screen.queryByText("核对未增加")).not.toBeInTheDocument();
    expect(screen.queryByText("核对购物车未增加")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "待采购 · 1 单 · 1 件" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择订单 post-uncertain" }));
    fireEvent.click(screen.getByRole("button", { name: "撤回状态 (1)" }));
    await waitFor(() => expect(api.resetStockPrepOrders).toHaveBeenCalledWith("store-1", [{ postingNumber: "post-uncertain", offerId: "SKU-A" }]));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("requires an explicit approval before a multi-item order can be selected", async () => {
    vi.mocked(api.fetchStores).mockResolvedValue([{ id: "store-1", name: "YOGOLD", platform: "ozon", enabled: true } as StoreView]);
    vi.mocked(api.fetchStockPrepConnection).mockResolvedValue({ platform: "darwin", feishu: { connected: true, profile: "ozon-team-wiki", userName: "刘建伟", message: "ok", appIdConfigured: false, appSecretConfigured: false, authorization: null }, configuredStoreCount: 1, browserBridge: { ready: true, message: "connected" }, dropshipSuppliers: [] });
    vi.mocked(api.fetchStockPrepState).mockResolvedValue({ source: { url: "https://feishu/base" }, latestBatch: null, connection: {} as api.StockPrepConnection, lastOrderSyncAt: null });
    vi.mocked(api.scanStockPrep).mockResolvedValue({ storeId: "store-1", groups: [{ offerUrl: "https://detail.1688.com/offer/747713283348.html", offerId: "1645-2-XXL", skuId: "6103279203988", imageUrl: null, status: "pending", quantity: 2, error: null, orders: [
      { postingNumber: "12345678-order-1", orderNumber: "order-risk", buyerPrefix: "12345678", currentOrderCount: 1, currentOrderIndex: 1, offerId: "1645-2-XXL", imageUrl: null, productName: "蓝底叶子XXL", quantity: 2, orderQuantity: 2, riskLevel: "review", approved: false, state: "pending", error: null, selectedByDefault: false, buyerHistory: { syncState: "complete", syncError: null, ordersInYear: 1, deliveredOrders: 1, cancelledOrders: 0, refusalOrders: 0, returnCount: 0, returnedPieces: 0, latestOutcome: "delivered", latestAt: Date.now() - 86400000, orderSequenceByPostingNumber: { "12345678-order-1": 2 }, recentOrders: [{ postingNumber: "12345678-old-1", status: "delivered", orderAt: Date.now() - 86400000, cancellationInitiator: null, cancellationType: null, returns: [] }] } },
    ] }] });
    vi.mocked(api.approveStockPrepRiskOrder).mockResolvedValue({ approved: true });
    renderPage();
    expect(await screen.findByText(/该订单购买多件，需人工确认/)).toBeInTheDocument();
    expect(screen.getByText(/近一年历史 · 已同步/)).toBeInTheDocument();
    expect(screen.getByText("1 笔订单")).toBeInTheDocument();
    expect(screen.queryByText("12345678-old-1")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看历史明细" }));
    expect(screen.getByText("12345678-old-1")).toBeInTheDocument();
    expect(screen.getAllByText(/已送达/).length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("button", { name: "查看风险详情" }));
    const riskDrawer = screen.getByRole("dialog", { name: "买家风险详情" });
    expect(within(riskDrawer).getByText("买家编号")).toBeInTheDocument();
    expect(within(riskDrawer).getByText("12345678-order-1")).toBeInTheDocument();
    expect(within(riskDrawer).getByText("Ozon 订单号：order-risk")).toBeInTheDocument();
    expect(within(riskDrawer).getByRole("button", { name: "人工放行 1 单 · 2 件" })).toBeEnabled();
    fireEvent.click(within(riskDrawer).getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "待采购 · 1 单 · 2 件" }));
    fireEvent.click(screen.getByRole("button", { name: "查看风险详情" }));
    expect(screen.getByRole("dialog", { name: "买家风险详情" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    fireEvent.click(screen.getByRole("button", { name: "需要处理 · 1" }));
    fireEvent.click(screen.getByRole("button", { name: "人工放行" }));
    await waitFor(() => expect(api.approveStockPrepRiskOrder).toHaveBeenCalledWith("store-1", "12345678"));
    fireEvent.click(screen.getByRole("button", { name: "待采购 · 1 单 · 2 件" }));
    expect(await screen.findByRole("checkbox", { name: "选择订单 12345678-order-1" })).toBeEnabled();
  });

});
