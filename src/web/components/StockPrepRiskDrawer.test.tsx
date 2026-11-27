// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StockPrepOrder } from "../api";
import { StockPrepRiskDrawer } from "./StockPrepRiskDrawer";

afterEach(cleanup);

describe("StockPrepRiskDrawer", () => {
  it("groups every current posting for the buyer and exposes the full approval scope", () => {
    const approve = vi.fn();
    const common: Omit<StockPrepOrder, "postingNumber" | "orderNumber" | "offerId" | "productName" | "quantity"> = {
      buyerPrefix: "12345678",
      imageUrl: null,
      currentOrderCount: 2,
      currentOrderIndex: 1,
      shipmentDeadlineAt: Date.now() + 3_600_000,
      riskLevel: "review",
      approved: false,
      state: "pending",
      error: null,
      selectedByDefault: false,
      buyerHistory: { syncState: "complete", syncError: null, ordersInYear: 1, deliveredOrders: 1, cancelledOrders: 0, refusalOrders: 0, returnCount: 0, returnedPieces: 0, latestOutcome: "delivered", latestAt: Date.now() - 86_400_000, orderSequenceByPostingNumber: { "12345678-a-1": 2, "12345678-b-1": 3 }, recentOrders: [{ postingNumber: "12345678-old-1", status: "delivered", orderAt: Date.now() - 86_400_000, cancellationInitiator: null, cancellationType: null, returns: [] }] },
    };
    const orders: StockPrepOrder[] = [
      { ...common, postingNumber: "12345678-a-1", orderNumber: "order-a", offerId: "SKU-A", productName: "商品 A", quantity: 1 },
      { ...common, postingNumber: "12345678-b-1", orderNumber: "order-b", offerId: "SKU-B", productName: "商品 B", quantity: 2, currentOrderIndex: 2 },
    ];

    render(<StockPrepRiskDrawer buyerPrefix="12345678" orders={orders} approving={false} blacklisting={false} onClose={vi.fn()} onApprove={approve} onAddBlacklist={vi.fn()}/>);

    expect(screen.getByText("同一买家存在多笔待采购订单，需要核对全部订单后决定是否放行。")).toBeInTheDocument();
    expect(screen.getByText("12345678-a-1")).toBeInTheDocument();
    expect(screen.getByText("12345678-b-1")).toBeInTheDocument();
    expect(screen.getByText("Ozon 订单号：order-b")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看明细" }));
    expect(screen.getByText("12345678-old-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "人工放行 2 单 · 3 件" }));
    expect(approve).toHaveBeenCalledOnce();
  });
});
