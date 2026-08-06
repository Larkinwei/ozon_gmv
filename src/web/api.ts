import type {
  DashboardRange,
  DashboardSnapshot,
  NetworkSettingsView,
  OrderDetail,
  ProxyMode,
  ProxyTestResult,
  RuntimeView,
  SessionView,
  StoreCreateInput,
  StoreCreateResult,
  StoreView,
  UpdateView,
  WallboardPairingView,
} from "../shared/contracts";
import { createDemoOrderDetail, createDemoSnapshot, demoStores } from "./demo-data";

export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";
let runtimeRole: RuntimeView["role"] = "admin";

interface DashboardFilters {
  range: DashboardRange;
  storeId: string;
  from?: string;
  to?: string;
}

interface StoreUpdateInput {
  name?: string;
  apiKey?: string;
  color?: string;
  enabled?: boolean;
  fulfillmentModes?: StoreView["fulfillmentModes"];
}

/** Sends JSON API requests without declaring a content type for an empty body. */
async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export async function fetchSession(): Promise<SessionView> {
  if (DEMO_MODE) {
    return { authenticated: true, username: "demo", setupRequired: false };
  }
  if (runtimeRole === "wallboard") {
    const session = await apiFetch<{ authenticated: boolean }>("/api/wallboard/session");
    return session.authenticated ? { authenticated: true, username: "wallboard" } : { authenticated: false };
  }
  return apiFetch("/api/auth/session");
}

export async function fetchRuntime(): Promise<RuntimeView> {
  const runtime = DEMO_MODE ? { role: "admin" as const } : await apiFetch<RuntimeView>("/api/runtime");
  runtimeRole = runtime.role;
  return runtime;
}

export async function initializeSetup(username: string, password: string): Promise<SessionView> {
  return apiFetch("/api/setup/initialize", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function login(username: string, password: string): Promise<SessionView> {
  return apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function logout(): Promise<void> {
  if (!DEMO_MODE) {
    await apiFetch("/api/auth/logout", { method: "POST" });
  }
}

export async function fetchDashboard(filters: DashboardFilters): Promise<DashboardSnapshot> {
  if (DEMO_MODE) {
    return createDemoSnapshot(filters.range, filters.storeId);
  }
  const params = new URLSearchParams({ range: filters.range });
  if (filters.storeId !== "all") {
    params.set("storeIds", filters.storeId);
  }
  if (filters.from) {
    params.set("from", filters.from);
  }
  if (filters.to) {
    params.set("to", filters.to);
  }
  const prefix = runtimeRole === "wallboard" ? "/api/wallboard" : "/api/dashboard";
  return apiFetch(`${prefix}/overview?${params.toString()}`);
}

/** Reads one order from the local SQLite projection for the current runtime role. */
export async function fetchOrderDetail(id: string): Promise<OrderDetail> {
  if (DEMO_MODE) {
    return createDemoOrderDetail(id);
  }
  const prefix = runtimeRole === "wallboard" ? "/api/wallboard" : "/api/dashboard";
  return apiFetch(`${prefix}/orders/${encodeURIComponent(id)}`);
}

export function dashboardStreamUrl(): string {
  return runtimeRole === "wallboard" ? "/api/wallboard/stream" : "/api/dashboard/stream";
}

export async function fetchStores(): Promise<StoreView[]> {
  return DEMO_MODE ? demoStores : apiFetch("/api/stores");
}

export async function createStore(input: StoreCreateInput): Promise<StoreCreateResult> {
  if (DEMO_MODE) {
    const store: StoreView = {
      id: crypto.randomUUID(),
      name: input.name,
      clientId: input.clientId,
      color: input.color,
      enabled: true,
      fulfillmentModes: input.fulfillmentModes,
      apiKeyExpiresAt: null,
      lastSyncStartedAt: new Date().toISOString(),
      lastSyncFinishedAt: new Date().toISOString(),
      lastSyncError: null,
      syncHealth: "healthy",
    };
    return {
      store,
      backfillDays: 90,
      pollIntervalSeconds: 60,
    };
  }
  return apiFetch("/api/stores", { method: "POST", body: JSON.stringify(input) });
}

export async function updateStore(id: string, input: StoreUpdateInput): Promise<StoreView> {
  if (DEMO_MODE) {
    const current = demoStores.find((store) => store.id === id);
    if (!current) {
      throw new Error("店铺不存在");
    }
    return { ...current, ...input };
  }
  return apiFetch(`/api/stores/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function testStore(id: string): Promise<void> {
  if (!DEMO_MODE) {
    await apiFetch(`/api/stores/${id}/test`, { method: "POST" });
  }
}

/** Starts a background store synchronization for the selected recent-day range. */
export async function syncStore(id: string, days: number): Promise<void> {
  if (!DEMO_MODE) {
    await apiFetch(`/api/stores/${id}/sync`, {
      method: "POST",
      body: JSON.stringify({ days }),
    });
  }
}

export async function fetchNetworkSettings(): Promise<NetworkSettingsView> {
  return apiFetch("/api/settings/network");
}

export async function updateNetworkSettings(mode: ProxyMode, manualProxy?: string): Promise<NetworkSettingsView> {
  return apiFetch("/api/settings/network", {
    method: "PUT",
    body: JSON.stringify({ mode, ...(manualProxy ? { manualProxy } : {}) }),
  });
}

export async function testNetworkSettings(): Promise<ProxyTestResult> {
  return apiFetch("/api/settings/network/test", { method: "POST" });
}

export async function fetchUpdateStatus(): Promise<UpdateView> {
  if (DEMO_MODE) {
    return {
      supported: false,
      currentVersion: "1.1.0",
      latestVersion: null,
      state: "unsupported",
      notes: null,
      publishedAt: null,
      downloadedBytes: 0,
      totalBytes: 0,
      lastCheckedAt: null,
      error: null,
    };
  }
  return apiFetch("/api/settings/update");
}

export async function checkSoftwareUpdate(): Promise<UpdateView> {
  return apiFetch("/api/settings/update/check", { method: "POST" });
}

export async function installSoftwareUpdate(): Promise<UpdateView> {
  return apiFetch("/api/settings/update/install", { method: "POST" });
}

export async function createWallboardPairing(): Promise<WallboardPairingView> {
  return apiFetch("/api/wallboard/pairings", { method: "POST" });
}

export async function revokeWallboardSessions(): Promise<void> {
  await apiFetch("/api/wallboard/revoke", { method: "POST" });
}
