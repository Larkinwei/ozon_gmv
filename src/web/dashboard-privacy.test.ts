// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

describe("dashboard privacy state", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it("persists the hidden state across a fresh module instance", async () => {
    const first = await import("./dashboard-privacy");
    first.dashboardPrivacy.setHidden(true);
    expect(window.localStorage.getItem("gmv.dashboard.hide_store_identity")).toBe("true");

    vi.resetModules();
    const refreshed = await import("./dashboard-privacy");
    expect(refreshed.dashboardPrivacy.getSnapshot()).toBe(true);
  });

  it("removes the persisted value when visibility is restored", async () => {
    const privacy = await import("./dashboard-privacy");
    privacy.dashboardPrivacy.setHidden(true);
    privacy.dashboardPrivacy.setHidden(false);

    expect(window.localStorage.getItem("gmv.dashboard.hide_store_identity")).toBeNull();
  });
});
