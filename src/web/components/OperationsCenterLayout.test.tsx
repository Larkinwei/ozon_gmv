// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import OperationsCenterLayout from "./OperationsCenterLayout";

vi.mock("../api", () => ({
  fetchUpdateStatus: vi.fn().mockResolvedValue({ state: "current" }),
  logout: vi.fn(),
}));

function renderLayout(path: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <OperationsCenterLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("OperationsCenterLayout", () => {
  afterEach(() => cleanup());

  it("keeps four top-level destinations and exposes the product operation groups", () => {
    renderLayout("/operations/selection");

    expect(screen.getByRole("link", { name: "经营总览" })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: "运营中心" })).toHaveAttribute("href", "/operations");
    expect(screen.getByRole("link", { name: "店铺管理" })).toHaveAttribute("href", "/stores");
    expect(screen.getByRole("link", { name: "本机设置" })).toHaveAttribute("href", "/settings");
    expect(screen.getByText("商品分析")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "选品分析" })).toHaveAttribute("href", "/operations/selection");
    expect(screen.getByRole("link", { name: "商品上架" })).toHaveAttribute("href", "/operations/publish");
    expect(screen.getByRole("link", { name: "发布任务" })).toHaveAttribute("href", "/operations/publish/tasks");
    expect(screen.getByRole("link", { name: "AI 助手" })).toHaveAttribute("href", "/operations/ai");
  });

  it("marks the task page active and keeps the mobile menu keyboard-operable", () => {
    renderLayout("/operations/publish/tasks");

    expect(screen.getByRole("link", { name: "运营中心" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "发布任务" })).toHaveAttribute("aria-current", "page");
    const menuButton = screen.getByRole("button", { name: /商品运营菜单/ });
    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(menuButton);
    expect(menuButton).toHaveAttribute("aria-expanded", "true");
  });
});
