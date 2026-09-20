// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StoreBreakdown } from "../../shared/contracts";
import { StoreRanking } from "./StoreRanking";

const stores: StoreBreakdown[] = [
  { storeId: "store-1", storeName: "店铺 A", color: "#3B82F6", platform: "ozon", orders: 4, gmv: [{ amount: "400", currency: "CNY" }] },
  { storeId: "store-2", storeName: "店铺 B", color: "#22C55E", platform: "ozon", orders: 2, gmv: [{ amount: "200", currency: "CNY" }] },
  { storeId: "store-3", storeName: "无订单店铺", color: "#F59E0B", platform: "ozon", orders: 0, gmv: [{ amount: "0", currency: "CNY" }] },
];

describe("StoreRanking", () => {
  it("shows every store with orders and excludes stores without orders", () => {
    render(<StoreRanking stores={stores} />);

    expect(screen.getByText("店铺 A")).toBeInTheDocument();
    expect(screen.getByText("店铺 B")).toBeInTheDocument();
    expect(screen.queryByText("无订单店铺")).not.toBeInTheDocument();
    expect(screen.getByText("2 家店铺")).toBeInTheDocument();
  });
});
