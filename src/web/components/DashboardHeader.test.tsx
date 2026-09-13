// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { StoreView } from "../../shared/contracts";
import { DashboardHeader } from "./DashboardHeader";

const store: StoreView = {
  id: "store-1",
  name: "店铺 A",
  platform: "ozon",
  externalStoreId: null,
  capabilities: { orders: true, sales: true, balance: true, notifications: true, inventory: true, writeOperations: true },
  clientId: "client-1",
  color: "#3B82F6",
  enabled: true,
  fulfillmentModes: ["FBO", "FBS"],
  apiKeyExpiresAt: null,
  lastSyncStartedAt: null,
  lastSyncFinishedAt: null,
  lastSyncError: null,
  syncHealth: "healthy",
};

describe("DashboardHeader privacy toggle", () => {
  it("exposes an accessible hide/show button and masks store options", () => {
    const onPrivacyToggle = vi.fn();
    const props = {
      stores: [store],
      storeId: "all",
      platform: "all" as const,
      range: "today" as const,
      streamStatus: "connected" as const,
      wallboard: true,
      customFrom: "2026-09-12T00:00",
      customTo: "2026-09-13T00:00",
      onStoreChange: vi.fn(),
      onPlatformChange: vi.fn(),
      onRangeChange: vi.fn(),
      onCustomFromChange: vi.fn(),
      onCustomToChange: vi.fn(),
      privacyHidden: false,
      onPrivacyToggle,
    };

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderHeader = (headerProps: typeof props) => render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/wallboard"]}>
          <DashboardHeader {...headerProps} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const { rerender } = renderHeader(props);
    const hideButton = screen.getByRole("button", { name: "隐藏店铺名称和余额" });
    expect(hideButton).toHaveAttribute("aria-pressed", "false");
    expect(hideButton).toHaveClass("is-active");
    expect(screen.getByRole("option", { name: "店铺 A" })).toBeInTheDocument();

    fireEvent.click(hideButton);
    expect(onPrivacyToggle).toHaveBeenCalledTimes(1);

    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/wallboard"]}>
          <DashboardHeader {...props} privacyHidden />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const showButton = screen.getByRole("button", { name: "显示店铺名称和余额" });
    expect(showButton).toHaveAttribute("aria-pressed", "true");
    expect(showButton).not.toHaveClass("is-active");
    expect(screen.getByRole("option", { name: "***" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "店铺 A" })).not.toBeInTheDocument();
  });
});
