import type {
  DashboardRange,
  DashboardSnapshot,
  NetworkSettingsView,
  OrderNotificationSettings,
  OrderDetail,
  ProxyMode,
  ProxyTestResult,
  RuntimeView,
  SelectionCandidate,
  SelectionCandidateCreateInput,
  SelectionCandidateStatus,
  SelectionCandidateUpdateInput,
  SelectionCategoryOverview,
  SelectionCategoryPage,
  SelectionCategoryPeriod,
  SelectionCategorySort,
  SelectionCategorySourceSettingsInput,
  SelectionCategorySourceSettingsView,
  SelectionCategorySyncView,
  SelectionImportMapping,
  SelectionImportPreview,
  SelectionImportResult,
  SelectionImportView,
  SelectionKeywordDetail,
  SelectionKeywordPage,
  SelectionKeywordSort,
  SelectionMarketProductDetail,
  SelectionMarketProductPage,
  SelectionMarketProductSort,
  SelectionOverview,
  SessionView,
  StoreCreateInput,
  StoreCreateResult,
  StoreView,
  UpdateView,
  WallboardPairingView,
  WordstatJobView,
  WordstatSettingsView,
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
  if (typeof init?.body === "string" && !headers.has("Content-Type")) {
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
  if (response.status === 204) {
    return undefined as T;
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

export async function fetchOrderNotificationSettings(): Promise<OrderNotificationSettings> {
  if (DEMO_MODE) {
    return { supported: true, enabled: true, agentConnected: true, lastDeliveredAt: null, lastError: null };
  }
  return apiFetch("/api/settings/notifications");
}

export async function updateOrderNotificationSettings(enabled: boolean): Promise<OrderNotificationSettings> {
  return apiFetch("/api/settings/notifications", { method: "PUT", body: JSON.stringify({ enabled }) });
}

export async function testOrderNotification(): Promise<void> {
  await apiFetch("/api/settings/notifications/test", { method: "POST" });
}

export async function fetchUpdateStatus(): Promise<UpdateView> {
  if (DEMO_MODE) {
    return {
      supported: false,
      currentVersion: "1.4.0",
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

export interface SelectionKeywordFilters {
  page: number;
  pageSize: number;
  sort: SelectionKeywordSort;
  search?: string | undefined;
  minimumPrice?: number | undefined;
  maximumPrice?: number | undefined;
}

export async function fetchSelectionOverview(): Promise<SelectionOverview> {
  if (DEMO_MODE) {
    return demoSelectionOverview;
  }
  return apiFetch("/api/selection/overview");
}

export async function fetchSelectionKeywords(filters: SelectionKeywordFilters): Promise<SelectionKeywordPage> {
  if (DEMO_MODE) {
    const search = filters.search?.toLocaleLowerCase("ru-RU") ?? "";
    const items = demoSelectionKeywords.filter((item) => item.phrase.toLocaleLowerCase("ru-RU").includes(search));
    return { items, page: 1, pageSize: filters.pageSize, total: items.length };
  }
  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    sort: filters.sort,
  });
  if (filters.search) {
    params.set("search", filters.search);
  }
  if (filters.minimumPrice !== undefined) {
    params.set("minimumPrice", String(filters.minimumPrice));
  }
  if (filters.maximumPrice !== undefined) {
    params.set("maximumPrice", String(filters.maximumPrice));
  }
  return apiFetch(`/api/selection/keywords?${params.toString()}`);
}

export async function fetchSelectionKeyword(id: string): Promise<SelectionKeywordDetail> {
  if (DEMO_MODE) {
    const keyword = demoSelectionKeywordDetails.find((item) => item.id === id);
    if (!keyword) {
      throw new Error("关键词不存在");
    }
    return keyword;
  }
  return apiFetch(`/api/selection/keywords/${encodeURIComponent(id)}`);
}

export async function fetchSelectionImports(): Promise<SelectionImportView[]> {
  return DEMO_MODE ? demoSelectionImports : apiFetch("/api/selection/imports");
}

export async function previewSelectionImport(file: File, sheetName?: string): Promise<SelectionImportPreview> {
  if (DEMO_MODE) {
    const isProductReport = file.name.startsWith("analytics_report_");
    return {
      kind: isProductReport ? "market_product" : "keyword",
      fileName: file.name,
      fileType: file.name.endsWith(".xlsx") ? "xlsx" : "csv",
      sheets: [sheetName ?? "CSV"],
      selectedSheet: sheetName ?? "CSV",
      detectedSnapshotDate: isProductReport ? "2026-08-11" : null,
      reportPeriodDays: isProductReport ? 28 : null,
      headers: isProductReport
        ? ["Название товара", "Ссылка на товар", "Заказано на сумму, ₽", "Заказано, штуки", "Средняя цена, ₽"]
        : ["搜索词", "搜索次数", "加购转化率", "下单转化率", "买家平均价格"],
      sampleRows: isProductReport
        ? [["VOIS Hair Shampoo, 2000 ml", "https://www.ozon.ru/product/1710550744", "82753618", "79193", "1045"]]
        : [["органайзер для кухни", "12400", "18.6%", "7.2%", "1699"]],
      totalDataRows: isProductReport ? 1000 : 120,
    };
  }
  const body = new FormData();
  body.append("file", file);
  if (sheetName) {
    body.append("sheetName", sheetName);
  }
  return apiFetch("/api/selection/imports/preview", { method: "POST", body });
}

export async function commitSelectionImport(input: {
  file: File;
  sheetName?: string | undefined;
  snapshotDate: string;
  kind: SelectionImportPreview["kind"];
  mapping?: SelectionImportMapping | undefined;
}): Promise<SelectionImportResult> {
  if (DEMO_MODE) {
    return { id: crypto.randomUUID(), kind: input.kind, validRows: input.kind === "market_product" ? 1000 : 120, skippedRows: 0, errors: [] };
  }
  const body = new FormData();
  body.append("file", input.file);
  body.append("snapshotDate", input.snapshotDate);
  if (input.mapping) {
    body.append("mapping", JSON.stringify(input.mapping));
  }
  if (input.sheetName) {
    body.append("sheetName", input.sheetName);
  }
  return apiFetch("/api/selection/imports", { method: "POST", body });
}

export async function deleteSelectionImport(id: string): Promise<void> {
  if (!DEMO_MODE) {
    await apiFetch(`/api/selection/imports/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

export async function fetchSelectionMarketProducts(filters: {
  page: number;
  pageSize: number;
  sort: SelectionMarketProductSort;
  search?: string | undefined;
  categoryLevel1?: string | undefined;
  categoryLevel3?: string | undefined;
  productFlag?: string | undefined;
  minimumPrice?: number | undefined;
  maximumPrice?: number | undefined;
}): Promise<SelectionMarketProductPage> {
  if (DEMO_MODE) {
    return { items: demoSelectionMarketProducts, facets: demoSelectionMarketFacets, page: 1, pageSize: filters.pageSize, total: demoSelectionMarketProducts.length };
  }
  const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize), sort: filters.sort });
  for (const [key, value] of Object.entries(filters)) {
    if (key !== "page" && key !== "pageSize" && key !== "sort" && value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  return apiFetch(`/api/selection/products?${params.toString()}`);
}

export async function fetchSelectionMarketProduct(id: string): Promise<SelectionMarketProductDetail> {
  if (DEMO_MODE) {
    const product = demoSelectionMarketProductDetails.find((item) => item.id === id);
    if (!product) {
      throw new Error("热销商品不存在");
    }
    return product;
  }
  return apiFetch(`/api/selection/products/${encodeURIComponent(id)}`);
}

export async function fetchSelectionCandidates(filters: {
  status?: SelectionCandidateStatus | undefined;
  search?: string | undefined;
} = {}): Promise<SelectionCandidate[]> {
  if (DEMO_MODE) {
    return demoSelectionCandidates.filter((candidate) => !filters.status || candidate.status === filters.status);
  }
  const params = new URLSearchParams();
  if (filters.status) {
    params.set("status", filters.status);
  }
  if (filters.search) {
    params.set("search", filters.search);
  }
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return apiFetch(`/api/selection/candidates${query}`);
}

export async function createSelectionCandidate(input: SelectionCandidateCreateInput): Promise<SelectionCandidate> {
  if (DEMO_MODE) {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(), name: input.name, ozonUrl: input.ozonUrl ?? null,
      category: input.category ?? null,
      targetPrice: input.targetPrice ? { amount: input.targetPrice, currency: "RUB" } : null,
      status: "watching", decisionReason: null, note: input.note ?? null, keyword: null, marketProduct: null,
      createdAt: now, updatedAt: now,
    };
  }
  return apiFetch("/api/selection/candidates", { method: "POST", body: JSON.stringify(input) });
}

export async function updateSelectionCandidate(
  id: string,
  input: SelectionCandidateUpdateInput,
): Promise<SelectionCandidate> {
  if (DEMO_MODE) {
    const current = demoSelectionCandidates.find((candidate) => candidate.id === id);
    if (!current) {
      throw new Error("候选商品不存在");
    }
    return { ...current, ...input, updatedAt: new Date().toISOString() } as SelectionCandidate;
  }
  return apiFetch(`/api/selection/candidates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function fetchWordstatSettings(): Promise<WordstatSettingsView> {
  return DEMO_MODE
    ? { configured: true, folderId: "demo-folder", hasApiKey: true }
    : apiFetch("/api/selection/sources/wordstat");
}

export async function updateWordstatSettings(folderId: string, apiKey?: string): Promise<WordstatSettingsView> {
  return apiFetch("/api/selection/sources/wordstat", {
    method: "PUT",
    body: JSON.stringify({ folderId, ...(apiKey ? { apiKey } : {}) }),
  });
}

export async function testWordstatSettings(): Promise<void> {
  if (!DEMO_MODE) {
    await apiFetch("/api/selection/sources/wordstat/test", { method: "POST" });
  }
}

export async function fetchWordstatJobs(): Promise<WordstatJobView[]> {
  return DEMO_MODE ? [] : apiFetch("/api/selection/wordstat/jobs");
}

export async function createWordstatJob(keywordIds: string[], force = false): Promise<WordstatJobView> {
  return apiFetch("/api/selection/wordstat/jobs", {
    method: "POST",
    body: JSON.stringify({ keywordIds, force }),
  });
}

export interface SelectionCategoryFilters {
  page: number;
  pageSize: number;
  periodDays: SelectionCategoryPeriod;
  sort: SelectionCategorySort;
  search?: string | undefined;
  categoryLevel1Id?: string | undefined;
  minimumPrice?: number | undefined;
  maximumPrice?: number | undefined;
  minimumGmv?: number | undefined;
  maximumGmv?: number | undefined;
  minimumGrowth?: number | undefined;
  maximumGrowth?: number | undefined;
  maximumSellerCount?: number | undefined;
  minimumBuyoutRate?: number | undefined;
  maximumLeaderShare?: number | undefined;
}

export async function fetchSelectionCategories(filters: SelectionCategoryFilters): Promise<SelectionCategoryPage> {
  if (DEMO_MODE) {
    return demoSelectionCategoryPage(filters.periodDays);
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  return apiFetch(`/api/selection/categories?${params.toString()}`);
}

export async function fetchSelectionCategoryOverview(
  periodDays: SelectionCategoryPeriod,
): Promise<SelectionCategoryOverview> {
  if (DEMO_MODE) {
    const page = demoSelectionCategoryPage(periodDays);
    return {
      snapshotId: page.snapshotId,
      collectedAt: page.collectedAt,
      source: "cloud",
      periodDays,
      categoryCount: page.total,
      totalGmv: { amount: String(page.items.reduce((sum, item) => sum + Number(item.gmv.amount), 0)), currency: "RUB" },
      totalOrderedUnits: page.items.reduce((sum, item) => sum + item.orderedUnits, 0),
      summaries: page.facets.categoryLevel1.map((facet) => ({
        ...facet,
        categoryCount: page.items.filter((item) => item.categoryLevel1Id === facet.id).length,
        gmv: { amount: String(page.items.filter((item) => item.categoryLevel1Id === facet.id).reduce((sum, item) => sum + Number(item.gmv.amount), 0)), currency: "RUB" },
        orderedUnits: page.items.filter((item) => item.categoryLevel1Id === facet.id).reduce((sum, item) => sum + item.orderedUnits, 0),
      })),
    };
  }
  return apiFetch(`/api/selection/categories/overview?periodDays=${periodDays}`);
}

export async function fetchSelectionCategorySync(): Promise<SelectionCategorySyncView> {
  if (DEMO_MODE) {
    return { id: null, status: "idle", totalSteps: 62, completedSteps: 62, currentCategory: null, error: null, cloudPublished: true, startedAt: null, finishedAt: null };
  }
  return apiFetch("/api/selection/categories/sync");
}

export async function startSelectionCategorySync(): Promise<SelectionCategorySyncView> {
  return apiFetch("/api/selection/categories/sync", { method: "POST" });
}

export async function refreshSelectionCategoriesFromCloud(): Promise<SelectionCategorySyncView> {
  return apiFetch("/api/selection/categories/cloud-refresh", { method: "POST" });
}

export async function fetchSelectionCategorySettings(): Promise<SelectionCategorySourceSettingsView> {
  if (DEMO_MODE) {
    return { collectorEnabled: false, opencliPath: "/usr/local/bin/opencli", cloudBaseUrl: "https://categories.example.com", hasUploadToken: false };
  }
  return apiFetch("/api/selection/sources/categories");
}

export async function updateSelectionCategorySettings(
  input: SelectionCategorySourceSettingsInput,
): Promise<SelectionCategorySourceSettingsView> {
  return apiFetch("/api/selection/sources/categories", { method: "PUT", body: JSON.stringify(input) });
}

function demoSelectionCategoryPage(periodDays: SelectionCategoryPeriod): SelectionCategoryPage {
  const categories = [
    ["93055", "裤子", "15621031", "服装", 5_229_481_281, 0.23, 1_776_836, 2943, 15_262, 0.807, 0.076],
    ["91248", "运动鞋", "15621032", "鞋类", 4_638_292_467, 0.16, 1_181_016, 3927, 11_042, 0.793, 0.258],
    ["17028764", "果汁、水、饮料", "17027496", "食品", 2_252_953_076, 0.0298, 3_512_371, 641, 8171, 0.9659, 0.3332],
    ["95139", "智能手机", "15621042", "电子产品", 2_731_878_671, -0.32, 97_320, 28_071, 1148, 0.85, 0.346],
  ] as const;
  const items = categories.map(([id, name, categoryLevel1Id, categoryLevel1Name, gmv, growth, units, price, sellers, buyout, leader]) => ({
    id, name, categoryLevel1Id, categoryLevel1Name, periodDays,
    gmv: { amount: String(periodDays === 7 ? gmv : gmv * 3.7), currency: "RUB" },
    gmvGrowth: growth, orderedUnits: periodDays === 7 ? units : Math.round(units * 3.7),
    averagePrice: { amount: String(price), currency: "RUB" }, averagePriceGrowth: -0.01,
    sellerCount: sellers, brandCount: Math.round(sellers * 0.3), clusterCount: 0,
    buyoutRate: buyout, topFiveSellerShare: leader, categoryShare: 0.01,
    rating: 4.7, maximumRating: 5,
  }));
  const facets = [...new Map(items.map((item) => [item.categoryLevel1Id, { id: item.categoryLevel1Id, name: item.categoryLevel1Name }])).values()];
  return { items, facets: { categoryLevel1: facets }, page: 1, pageSize: 50, total: items.length, snapshotId: "demo-category-snapshot", collectedAt: "2026-08-12T00:00:00.000Z" };
}

const demoSelectionKeywords: SelectionKeywordPage["items"] = [
  { id: "demo-keyword-1", phrase: "органайзер для кухни", snapshotDate: "2026-08-10", searchCount: 12400, cartRate: 0.186, orderRate: 0.072, averagePrice: { amount: "1699.00", currency: "RUB" }, demandScore: 92, wordstatStatus: "ready" },
  { id: "demo-keyword-2", phrase: "полка для ванной", snapshotDate: "2026-08-10", searchCount: 8600, cartRate: 0.151, orderRate: 0.058, averagePrice: { amount: "1290.00", currency: "RUB" }, demandScore: 78, wordstatStatus: "missing" },
];
const demoSelectionKeywordDetails: SelectionKeywordDetail[] = demoSelectionKeywords.map((keyword, index) => ({
  ...keyword,
  wordstat: index === 0 ? {
    fetchedAt: new Date().toISOString(), totalCount30d: 38600, growth3m: 0.24, growth12m: 0.41, trend: "rising",
    topRequests: [{ phrase: keyword.phrase, count: 38600 }],
    associations: [{ phrase: "хранение на кухне", count: 9200 }],
    dynamics: Array.from({ length: 12 }, (_, point) => ({
      date: new Date(Date.UTC(2025, 8 + point, 1)).toISOString(),
      count: 1200 + point * 140,
      share: 0.01,
    })),
  } : null,
}));
const demoSelectionCandidates: SelectionCandidate[] = [];
const demoSelectionMarketProducts: SelectionMarketProductPage["items"] = [{
  id: "demo-product-1", ozonProductId: "1710550744", name: "VOIS Hair Shampoo, 2000 ml",
  ozonUrl: "https://www.ozon.ru/product/1710550744", seller: "VOIS", brand: "VOIS",
  categoryLevel1: "Beauty & Hygiene", categoryLevel3: "洗发水", productFlags: ["Лидер по продажам"],
  snapshotDate: "2026-08-11", reportPeriodDays: 28,
  orderedAmount: { amount: "82753618.00", currency: "RUB" }, turnoverGrowth: 0.33,
  orderedUnits: 79193, averagePrice: { amount: "1045.00", currency: "RUB" },
  impressionToOrderRate: 0.042, missedSales: 0, outOfStockDays: 4,
}];
const demoSelectionMarketFacets: SelectionMarketProductPage["facets"] = {
  categoryLevel1: ["Beauty & Hygiene"], categoryLevel3: ["洗发水"], productFlags: ["Лидер по продажам"],
};
const demoSelectionMarketProductDetails: SelectionMarketProductDetail[] = demoSelectionMarketProducts.map((product) => {
  const snapshot = {
    ...product, minimumPrice: { amount: "999.00", currency: "RUB" as const }, purchaseRate: 0.911,
    dailySalesAmount: { amount: "2357414.00", currency: "RUB" as const }, dailySalesUnits: 2269,
    endingInventoryUnits: 179251, fulfillmentScheme: "FBO", volumeLiters: 6.5, impressions: 4820000,
    searchCatalogViews: 1200000, cardViews: 840000, searchCatalogCartRate: 0.132, cardCartRate: 0.168,
    promotionDiscountRate: 0.12, promotedOrderShare: 0.64, promotionDays: 24, advertisedDays: 27,
    advertisingCostShare: 0.083, productCardCreatedDate: "2024-09-10",
  };
  return { ...snapshot, history: [snapshot] };
});
const demoSelectionImports: SelectionImportView[] = [{
  id: "demo-import-1", kind: "keyword", fileName: "ozon-popular-queries.xlsx", snapshotDate: "2026-08-10",
  sheetName: "热门查询", reportPeriodDays: null, validRows: 120, skippedRows: 2, createdAt: new Date().toISOString(),
}];
const demoSelectionOverview: SelectionOverview = {
  keywordCount: 120,
  scoredKeywordCount: 118,
  marketProductCount: 1,
  latestMarketProductSnapshotDate: "2026-08-11",
  wordstatReadyCount: 36,
  candidateCounts: { watching: 5, recommended: 2, rejected: 3 },
  lastImportAt: new Date().toISOString(),
};
