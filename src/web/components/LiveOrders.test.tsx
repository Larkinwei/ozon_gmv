// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecentOrder } from "../../shared/contracts";
import { LiveOrders } from "./LiveOrders";

const order: RecentOrder = {
  id: "order-1",
  platform: "ozon",
  externalOrderId: "posting-1",
  postingNumber: "123-0001-1",
  storeId: "store-1",
  storeName: "YOGOLD",
  storeColor: "#3B82F6",
  orderAt: "2026-08-05T06:00:00.000Z",
  imageUrl: null,
  amount: { amount: "42.00", currency: "CNY" },
  itemCount: 2,
  productNames: ["轻量防水旅行收纳包", "便携行李整理袋"],
  fulfillment: "FBS",
  status: "awaiting_packaging",
  cancelled: false,
};

describe("LiveOrders", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hides the entire live order feed in privacy mode", () => {
    render(
      <LiveOrders
        orders={[order]}
        totalOrders={1}
        onLoadMore={() => undefined}
        paused={false}
        onPausedChange={() => undefined}
        onOrderSelect={() => undefined}
        privacyHidden
      />,
    );

    expect(screen.queryByRole("heading", { name: "实时订单流" })).not.toBeInTheDocument();
    expect(screen.queryByText(order.postingNumber)).not.toBeInTheDocument();
  });

  it("shows the primary product name and remaining product types", () => {
    const onOrderSelect = vi.fn();
    render(
      <LiveOrders
        orders={[order]}
        totalOrders={1}
        onLoadMore={() => undefined}
        paused={false}
        onPausedChange={() => undefined}
        onOrderSelect={onOrderSelect}
      />,
    );

    expect(screen.getByText("轻量防水旅行收纳包")).toBeInTheDocument();
    expect(screen.getByText("+1 种")).toBeInTheDocument();
    expect(screen.getByLabelText("商品：轻量防水旅行收纳包、便携行李整理袋")).toBeInTheDocument();
    const orderButton = screen.getByRole("button", { name: "查看订单 123-0001-1 详情" });
    fireEvent.click(orderButton);
    expect(onOrderSelect).toHaveBeenCalledWith("order-1");
  });

  it("loads more orders when the feed reaches its scroll sentinel", () => {
    const onLoadMore = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) {
        callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    });
    render(
      <LiveOrders
        orders={[order]}
        totalOrders={11}
        onLoadMore={onLoadMore}
        paused={false}
        onPausedChange={() => undefined}
        onOrderSelect={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: /查看更多订单/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("继续向下滚动加载更多订单")).toBeInTheDocument();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
