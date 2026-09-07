import { describe, expect, it } from "vitest";

import type { StoreView } from "../shared/contracts";
import { isStoreSynchronizing } from "./store-sync-status";

function store(overrides: Partial<StoreView> = {}): StoreView {
  return {
    id: "store-1",
    name: "测试店铺",
    platform: "wildberries",
    externalStoreId: null,
    capabilities: {
      orders: true,
      sales: true,
      balance: true,
      notifications: true,
      inventory: false,
      writeOperations: false,
    },
    clientId: "wb:store-1",
    color: "#3B82F6",
    enabled: true,
    fulfillmentModes: [],
    apiKeyExpiresAt: null,
    lastSyncStartedAt: "2026-09-07T14:43:15.000Z",
    lastSyncFinishedAt: null,
    lastSyncError: null,
    syncHealth: "never",
    ...overrides,
  };
}

describe("store sync status", () => {
  it("does not report a failed sync as still running", () => {
    expect(isStoreSynchronizing(store({ lastSyncError: "HTTP 429" }))).toBe(false);
  });

  it("reports a started sync without a finish timestamp as running", () => {
    expect(isStoreSynchronizing(store())).toBe(true);
  });
});
