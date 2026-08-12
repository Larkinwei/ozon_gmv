// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SelectionCategoryPanel } from "./SelectionCategoryPanel";

const { refreshCloud } = vi.hoisted(() => ({
  refreshCloud: vi.fn(async () => ({
    id: null, status: "idle" as const, totalSteps: 0, completedSteps: 0, currentCategory: null,
    error: null, cloudPublished: false, startedAt: null, finishedAt: null,
  })),
}));

vi.mock("../api", () => ({
  fetchSelectionCategories: vi.fn(async () => ({ items: [], facets: { categoryLevel1: [] }, page: 1, pageSize: 100, total: 0, snapshotId: null, collectedAt: null })),
  fetchSelectionCategoryOverview: vi.fn(async (periodDays: 7 | 28) => ({ snapshotId: null, collectedAt: null, source: null, periodDays, categoryCount: 0, totalGmv: { amount: "0.00", currency: "RUB" }, totalOrderedUnits: 0, summaries: [] })),
  fetchSelectionCategorySettings: vi.fn(async () => ({ collectorEnabled: false, opencliPath: "/usr/local/bin/opencli", cloudBaseUrl: "https://categories.example.com", hasUploadToken: false })),
  fetchSelectionCategorySync: vi.fn(async () => ({ id: null, status: "idle", totalSteps: 0, completedSteps: 0, currentCategory: null, error: null, cloudPublished: false, startedAt: null, finishedAt: null })),
  refreshSelectionCategoriesFromCloud: refreshCloud,
  startSelectionCategorySync: vi.fn(),
  updateSelectionCategorySettings: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("SelectionCategoryPanel", () => {
  it("keeps viewer devices read-only and exposes the two period choices", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><SelectionCategoryPanel onNotice={vi.fn()} /></QueryClientProvider>);

    expect(await screen.findByRole("button", { name: "刷新云端数据" })).toBeInTheDocument();
    await waitFor(() => expect(refreshCloud).toHaveBeenCalled());
    refreshCloud.mockClear();
    expect(screen.getByRole("button", { name: "近 28 天" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "近 7 天" }));
    expect(screen.getByRole("button", { name: "近 7 天" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "刷新云端数据" }));
    await waitFor(() => expect(refreshCloud).toHaveBeenCalledOnce());
    expect(await screen.findByText("还没有类目快照")).toBeInTheDocument();
  });
});
