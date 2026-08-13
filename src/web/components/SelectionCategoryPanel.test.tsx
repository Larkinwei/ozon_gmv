// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CategoryOpportunityMap } from "./CategoryOpportunityMap";
import { SelectionCategoryPanel, SelectionCategorySourceCard } from "./SelectionCategoryPanel";

const { refreshCloud, startSync } = vi.hoisted(() => ({
  refreshCloud: vi.fn(async () => ({
    id: null, status: "idle" as const, stage: null, totalSteps: 0, completedSteps: 0, currentItem: null,
    stageProgress: { categories: { completed: 0, total: 0 }, products: { completed: 0, total: 0 }, queries: { completed: 0, total: 0 } },
    error: null, cloudPublished: false, resumable: false, startedAt: null, finishedAt: null,
  })),
  startSync: vi.fn(async () => ({
    id: "sync-1", status: "running" as const, stage: "categories" as const, totalSteps: 320, completedSteps: 0, currentItem: "正在读取一级类目",
    stageProgress: { categories: { completed: 0, total: 62 }, products: { completed: 0, total: 57 }, queries: { completed: 0, total: 201 } },
    error: null, cloudPublished: false, resumable: false, startedAt: new Date().toISOString(), finishedAt: null,
  })),
}));

vi.mock("../api", () => ({
  fetchSelectionCategories: vi.fn(async () => ({ items: [], facets: { categoryLevel1: [] }, page: 1, pageSize: 100, total: 0, snapshotId: null, collectedAt: null })),
  fetchSelectionCategoryOverview: vi.fn(async (periodDays: 7 | 28) => ({ snapshotId: null, collectedAt: null, source: null, periodDays, categoryCount: 0, totalGmv: { amount: "0.00", currency: "RUB" }, totalOrderedUnits: 0, summaries: [] })),
  fetchSelectionDiscoverySettings: vi.fn(async () => ({ collectorEnabled: false, opencliPath: "/usr/local/bin/opencli", cloudBaseUrl: "https://categories.example.com", hasUploadToken: false, estimatedDurationMinutes: [8, 15] })),
  fetchSelectionDiscoverySync: vi.fn(async () => ({ id: null, status: "idle", stage: null, totalSteps: 0, completedSteps: 0, currentItem: null, stageProgress: { categories: { completed: 0, total: 0 }, products: { completed: 0, total: 0 }, queries: { completed: 0, total: 0 } }, error: null, cloudPublished: false, resumable: false, startedAt: null, finishedAt: null })),
  refreshSelectionDiscoveryFromCloud: refreshCloud,
  startSelectionDiscoverySync: startSync,
  updateSelectionDiscoverySettings: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("SelectionCategoryPanel", () => {
  it("explains how to read the category opportunity map", () => {
    render(<CategoryOpportunityMap points={[{
      name: "旅行收纳",
      growth: 24.5,
      concentration: 31.2,
      gmv: 180000,
      currency: "RUB",
    }]} />);
    expect(screen.getByRole("heading", { name: "类目机会地图" })).toBeInTheDocument();
    expect(screen.getByText("优先关注")).toBeInTheDocument();
    expect(screen.getByText("增长但集中")).toBeInTheDocument();
    expect(screen.getByText("竞争分散")).toBeInTheDocument();
    expect(screen.getByText("谨慎进入")).toBeInTheDocument();
    expect(screen.getByText("GMV 增长越快")).toBeInTheDocument();
    expect(screen.getByText("头部卖家越不集中")).toBeInTheDocument();
  });

  it("keeps synchronization actions out of category analysis and exposes the two period choices", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><SelectionCategoryPanel onNotice={vi.fn()} /></QueryClientProvider>);

    await waitFor(() => expect(refreshCloud).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "刷新云端数据" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /一键同步/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "近 28 天" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "近 7 天" }));
    expect(screen.getByRole("button", { name: "近 7 天" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("还没有类目快照")).toBeInTheDocument();
  });

  it("places unified market synchronization in the data-source card", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><SelectionCategorySourceCard
      settings={{ collectorEnabled: true, opencliPath: "/usr/local/bin/opencli", cloudBaseUrl: "https://categories.example.com", hasUploadToken: true, estimatedDurationMinutes: [8, 15] }}
      onSaved={vi.fn(async () => undefined)}
      onNotice={vi.fn()}
    /></QueryClientProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "一键同步全部市场数据" }));
    await waitFor(() => expect(startSync).toHaveBeenCalledOnce());
  });
});
