// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoreBreakdown } from "../../shared/contracts";
import { StoreRanking } from "./StoreRanking";

const stores: StoreBreakdown[] = [
  { storeId: "store-1", storeName: "店铺 A", color: "#3B82F6", platform: "ozon", orders: 4, gmv: [{ amount: "400", currency: "CNY" }], orderSharePercent: 66.7, gmvChangePercent: 10 },
  { storeId: "store-2", storeName: "店铺 B", color: "#22C55E", platform: "ozon", orders: 2, gmv: [{ amount: "200", currency: "CNY" }], orderSharePercent: 33.3, gmvChangePercent: -5 },
  { storeId: "store-3", storeName: "无订单店铺", color: "#F59E0B", platform: "ozon", orders: 0, gmv: [{ amount: "0", currency: "CNY" }], orderSharePercent: 0, gmvChangePercent: null },
];

describe("StoreRanking", () => {
  afterEach(cleanup);

  it("shows every store with orders and excludes stores without orders", () => {
    render(<StoreRanking stores={stores} onSelectStore={vi.fn()} />);

    expect(screen.getByText("店铺 A")).toBeInTheDocument();
    expect(screen.getByText("店铺 B")).toBeInTheDocument();
    expect(screen.getByText("4 单 · 占 66.7%")).toBeInTheDocument();
    expect(screen.getByText("GMV ↑ 10.0%")).toBeInTheDocument();
    expect(screen.queryByText("无订单店铺")).not.toBeInTheDocument();
    expect(screen.getByText("2 家店铺")).toBeInTheDocument();
  });

  it("selects the clicked store to drive the global dashboard filter", () => {
    const onSelectStore = vi.fn();
    render(<StoreRanking stores={stores} onSelectStore={onSelectStore} />);

    fireEvent.click(screen.getByRole("button", { name: "按店铺筛选：店铺 A" }));

    expect(onSelectStore).toHaveBeenCalledWith(stores[0]);
  });
});
