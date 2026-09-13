// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoreOperationsSnapshot } from "../../shared/contracts";
import { HIDDEN_PLACEHOLDER } from "../dashboard-privacy";
import { StoreOperationsPanel } from "./StoreOperationsPanel";

const snapshot: StoreOperationsSnapshot = {
  generatedAt: "2026-08-31T12:00:00.000Z",
  stores: [{
    storeId: "store-1",
    storeName: "店铺 A",
    storeColor: "#3B82F6",
    platform: "ozon",
    balance: {
      status: { state: "ok", message: null, updatedAt: "2026-08-31T12:00:00.000Z" },
      primary: { amount: "1450.75", currency: "RUB" },
      primaryLabel: "期末余额",
      openingBalance: { amount: "1200.50", currency: "RUB" },
      closingBalance: { amount: "1450.75", currency: "RUB" },
      accrued: { amount: "500.00", currency: "RUB" },
      payments: [{ amount: "249.75", currency: "RUB" }],
    },
    questions: {
      status: { state: "ok", message: null, updatedAt: "2026-08-31T12:00:00.000Z" },
      counts: { all: 8, new: 2, processed: 4, unprocessed: 1, viewed: 1 },
      latest: [{
        id: "question-1",
        storeId: "store-1",
        storeName: "店铺 A",
        storeColor: "#3B82F6",
        text: "可以放入 15 寸电脑吗？",
        status: "UNPROCESSED",
        sku: "12345",
        productName: "收纳包",
        productUrl: "https://www.ozon.ru/product/1/",
        questionLink: "https://www.ozon.ru/product/1/questions/",
        publishedAt: "2026-08-31T10:00:00.000Z",
        answersCount: 0,
      }],
    },
  }],
};

describe("StoreOperationsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    document.body.style.overflow = "";
  });

  it("shows compact balance metrics without rendering the buyer-question module", () => {
    render(<StoreOperationsPanel snapshot={snapshot} isLoading={false} error={null} onRetry={() => undefined} />);

    expect(screen.getByRole("heading", { name: "店铺余额" })).toBeInTheDocument();
    expect(screen.getByText("当前余额")).toBeInTheDocument();
    expect(screen.getByText("周期开始余额")).toBeInTheDocument();
    expect(screen.getByText("周期入账")).toBeInTheDocument();
    expect(screen.getByText((_, element) => (
      element?.tagName === "STRONG" && element.textContent === "1\u00a0450,75\u00a0₽"
    ))).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "买家问题" })).not.toBeInTheDocument();
    expect(screen.queryByText("BUYER QUESTIONS")).not.toBeInTheDocument();
    expect(screen.queryByText("期末余额")).not.toBeInTheDocument();
    expect(screen.queryByText("付款金额")).not.toBeInTheDocument();
    expect(screen.queryByText("余额明细")).not.toBeInTheDocument();
    expect(screen.queryByText("可以放入 15 寸电脑吗？")).not.toBeInTheDocument();
  });

  it("keeps multi-store balance rows compact without detail controls", () => {
    const multiStoreSnapshot: StoreOperationsSnapshot = {
      ...snapshot,
      stores: [
        ...snapshot.stores,
        {
          ...snapshot.stores[0]!,
          storeId: "store-2",
          storeName: "店铺 B",
        },
      ],
    };
    render(<StoreOperationsPanel snapshot={multiStoreSnapshot} isLoading={false} error={null} onRetry={() => undefined} />);

    expect(screen.getAllByText("当前余额")).toHaveLength(2);
    expect(screen.getByText("店铺 B")).toBeInTheDocument();
    expect(screen.queryByText("余额明细")).not.toBeInTheDocument();
    expect(screen.queryByText("付款金额")).not.toBeInTheDocument();
    expect(screen.queryByText("周期开始余额")).not.toBeInTheDocument();
  });

  it("hides store names and every balance value in privacy mode", () => {
    render(<StoreOperationsPanel snapshot={snapshot} isLoading={false} error={null} onRetry={() => undefined} privacyHidden />);

    expect(screen.queryByText("店铺 A")).not.toBeInTheDocument();
    expect(screen.getAllByText(HIDDEN_PLACEHOLDER)).toHaveLength(4);
    expect(screen.queryByText("1\u00a0450,75\u00a0₽")).not.toBeInTheDocument();
  });
});
