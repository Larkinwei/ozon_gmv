// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoreOperationsSnapshot } from "../../shared/contracts";
import { StoreOperationsPanel } from "./StoreOperationsPanel";

const { fetchQuestionDetail } = vi.hoisted(() => ({ fetchQuestionDetail: vi.fn() }));

vi.mock("../api", () => ({ fetchQuestionDetail }));

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

  it("shows compact balance metrics and a question summary without rendering the question list", () => {
    render(<StoreOperationsPanel snapshot={snapshot} isLoading={false} error={null} onRetry={() => undefined} />);

    expect(screen.getByRole("heading", { name: "店铺余额" })).toBeInTheDocument();
    expect(screen.getByText("当前余额")).toBeInTheDocument();
    expect(screen.getByText("周期开始余额")).toBeInTheDocument();
    expect(screen.getByText("周期入账")).toBeInTheDocument();
    expect(screen.getByText((_, element) => (
      element?.tagName === "STRONG" && element.textContent === "1\u00a0450,75\u00a0₽"
    ))).toBeInTheDocument();
    expect(screen.getByLabelText("未处理问题 1 条")).toBeInTheDocument();
    expect(screen.getByText("需要关注买家问题")).toBeInTheDocument();
    expect(screen.getByText("1 家已开通")).toBeInTheDocument();
    expect(screen.queryByText("期末余额")).not.toBeInTheDocument();
    expect(screen.queryByText("付款金额")).not.toBeInTheDocument();
    expect(screen.queryByText("余额明细")).not.toBeInTheDocument();
    expect(screen.queryByText("可以放入 15 寸电脑吗？")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看最近问题" })).toBeInTheDocument();
  });

  it("opens a read-only question detail drawer without exposing buyer identity", async () => {
    fetchQuestionDetail.mockResolvedValue(snapshot.stores[0]?.questions.latest[0]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <StoreOperationsPanel snapshot={snapshot} isLoading={false} error={null} onRetry={() => undefined} />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看最近问题" }));
    expect(await screen.findByRole("dialog", { name: "问题详情" })).toBeInTheDocument();
    expect(await screen.findByText("大屏仅提供查看摘要，回复和状态处理请进入店铺后台完成。")).toBeInTheDocument();
    expect(screen.queryByText(/作者|买家姓名|author/i)).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "问题详情" })).not.toBeInTheDocument();
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
});
