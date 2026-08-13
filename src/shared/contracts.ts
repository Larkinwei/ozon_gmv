export const fulfillmentModes = ["FBO", "FBS", "RFBS"] as const;
export type FulfillmentMode = (typeof fulfillmentModes)[number];

export const dashboardRanges = ["today", "yesterday", "7d", "30d", "custom"] as const;
export type DashboardRange = (typeof dashboardRanges)[number];

export type SyncHealth = "healthy" | "delayed" | "error" | "never";

export interface Money {
  amount: string;
  currency: string;
}

export interface StoreView {
  id: string;
  name: string;
  clientId: string;
  color: string;
  enabled: boolean;
  fulfillmentModes: FulfillmentMode[];
  apiKeyExpiresAt: string | null;
  lastSyncStartedAt: string | null;
  lastSyncFinishedAt: string | null;
  lastSyncError: string | null;
  syncHealth: SyncHealth;
}

export interface DashboardKpis {
  orders: number;
  gmv: Money[];
  averageOrderValue: Money[];
  cancelledOrders: number;
  cancelledGmv: Money[];
}

export interface TimeSeriesPoint {
  bucket: string;
  label: string;
  orders: number;
  gmv: Money[];
  stores: StoreTimeSeriesValue[];
}

export interface StoreTimeSeriesValue {
  storeId: string;
  storeName: string;
  color: string;
  orders: number;
  gmv: Money[];
}

export interface StoreBreakdown {
  storeId: string;
  storeName: string;
  color: string;
  orders: number;
  gmv: Money[];
}

export interface RecentOrder {
  id: string;
  postingNumber: string;
  storeId: string;
  storeName: string;
  storeColor: string;
  orderAt: string;
  amount: Money;
  itemCount: number;
  productNames: string[];
  fulfillment: FulfillmentMode;
  status: string;
  cancelled: boolean;
}

export interface OrderDetailItem {
  id: string;
  sku: string;
  offerId: string;
  name: string;
  imageUrl: string | null;
  quantity: number;
  unitPrice: Money;
  subtotal: Money;
}

export interface OrderDetail {
  id: string;
  postingNumber: string;
  orderNumber: string;
  storeId: string;
  storeName: string;
  storeColor: string;
  orderAt: string;
  fulfillment: FulfillmentMode;
  status: string;
  substatus: string | null;
  cancelled: boolean;
  cancelledAt: string | null;
  amount: Money;
  items: OrderDetailItem[];
}

export interface DashboardSnapshot {
  generatedAt: string;
  timezone: "Asia/Shanghai";
  range: DashboardRange;
  from: string;
  to: string;
  granularity: "15m" | "hour" | "day";
  kpis: DashboardKpis;
  timeSeries: TimeSeriesPoint[];
  stores: StoreBreakdown[];
  recentOrders: RecentOrder[];
  sync: StoreView[];
}

export type DashboardEventType = "posting.created" | "posting.updated" | "sync.status";

export interface DashboardEvent<T = unknown> {
  id: string;
  type: DashboardEventType;
  occurredAt: string;
  data: T;
}

export interface SessionView {
  authenticated: boolean;
  username?: string;
  setupRequired?: boolean;
}

export type ProxyMode = "auto" | "manual" | "direct";

export interface NetworkSettingsView {
  mode: ProxyMode;
  manualProxy: string | null;
  detectedProxy: string | null;
  hasManualCredentials: boolean;
}

export interface ProxyTestResult {
  ok: boolean;
  mode: ProxyMode;
  proxy: string | null;
  latencyMs: number;
  message: string;
}

export interface WallboardPairingView {
  expiresAt: string;
  links: string[];
  qrCodeDataUrl: string;
}

export interface RuntimeView {
  role: "admin" | "wallboard";
}

export interface UpdateManifest {
  schemaVersion: 1;
  version: string;
  publishedAt: string;
  notes: string;
  size: number;
  sha256: string;
  urls: [ossUrl: string, githubUrl: string];
}

export type UpdateState =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "failed"
  | "unsupported";

export interface UpdateView {
  supported: boolean;
  currentVersion: string;
  latestVersion: string | null;
  state: UpdateState;
  notes: string | null;
  publishedAt: string | null;
  downloadedBytes: number;
  totalBytes: number;
  lastCheckedAt: string | null;
  error: string | null;
}

export interface OrderNotificationSettings {
  supported: boolean;
  enabled: boolean;
  agentConnected: boolean;
  lastDeliveredAt: string | null;
  lastError: string | null;
}

export interface OrderNotificationEvent {
  id: string;
  kind: "order" | "test";
  occurredAt: string;
  orderId: string | null;
  storeName: string;
  storeColor: string;
  amount: Money;
  orderAt: string;
  fulfillment: FulfillmentMode;
  productName: string;
  imageUrl: string | null;
  itemCount: number;
}

export interface StoreCreateInput {
  name: string;
  clientId: string;
  apiKey: string;
  color: string;
  fulfillmentModes: FulfillmentMode[];
}

export interface StoreCreateResult {
  store: StoreView;
  backfillDays: number;
  pollIntervalSeconds: number;
}

export const selectionImportKinds = ["keyword", "market_product"] as const;
export type SelectionImportKind = (typeof selectionImportKinds)[number];

export interface SelectionImportPreview {
  kind: SelectionImportKind;
  fileName: string;
  fileType: "csv" | "xlsx";
  sheets: string[];
  selectedSheet: string;
  detectedSnapshotDate: string | null;
  reportPeriodDays: number | null;
  headers: string[];
  sampleRows: string[][];
  totalDataRows: number;
}

export type SelectionRateUnit = "percent" | "fraction";

export interface SelectionImportMapping {
  phrase: string;
  searchCount: string;
  cartRate: string;
  cartRateUnit: SelectionRateUnit;
  orderRate: string;
  orderRateUnit: SelectionRateUnit;
  averagePrice?: string | undefined;
}

export interface SelectionImportError {
  row: number;
  message: string;
}

export interface SelectionImportResult {
  id: string;
  kind: SelectionImportKind;
  validRows: number;
  skippedRows: number;
  errors: SelectionImportError[];
}

export const selectionKeywordSorts = ["demandScore", "searchCount", "cartRate", "orderRate", "averagePrice"] as const;
export type SelectionKeywordSort = (typeof selectionKeywordSorts)[number];

export interface SelectionKeywordListItem {
  id: string;
  phrase: string;
  snapshotDate: string;
  searchCount: number;
  cartRate: number;
  orderRate: number;
  averagePrice: Money | null;
  demandScore: number | null;
  wordstatStatus: "missing" | "ready" | "failed" | "queued";
}

export interface SelectionKeywordPage {
  items: SelectionKeywordListItem[];
  page: number;
  pageSize: number;
  total: number;
}

export type WordstatTrend = "rising" | "stable" | "falling";

export interface WordstatPhraseCount {
  phrase: string;
  count: number;
}

export interface WordstatDynamicsPoint {
  date: string;
  count: number;
  share: number;
}

export interface SelectionWordstatView {
  fetchedAt: string;
  totalCount30d: number;
  growth3m: number | null;
  growth12m: number | null;
  trend: WordstatTrend;
  topRequests: WordstatPhraseCount[];
  associations: WordstatPhraseCount[];
  dynamics: WordstatDynamicsPoint[];
}

export interface SelectionKeywordDetail extends SelectionKeywordListItem {
  wordstat: SelectionWordstatView | null;
}

export const selectionMarketProductSorts = [
  "orderedAmount",
  "orderedUnits",
  "turnoverGrowth",
  "missedSales",
  "conversionRate",
  "averagePrice",
] as const;
export type SelectionMarketProductSort = (typeof selectionMarketProductSorts)[number];

export interface SelectionMarketProductListItem {
  id: string;
  ozonProductId: string;
  name: string;
  ozonUrl: string;
  seller: string;
  brand: string;
  categoryLevel1: string;
  categoryLevel3: string;
  productFlags: string[];
  snapshotDate: string;
  reportPeriodDays: number;
  orderedAmount: Money;
  turnoverGrowth: number | null;
  orderedUnits: number;
  averagePrice: Money;
  impressionToOrderRate: number;
  missedSales: number;
  outOfStockDays: number | null;
}

export interface SelectionMarketProductFacets {
  categoryLevel1: string[];
  categoryLevel3: string[];
  productFlags: string[];
}

export interface SelectionMarketProductPage {
  items: SelectionMarketProductListItem[];
  facets: SelectionMarketProductFacets;
  page: number;
  pageSize: number;
  total: number;
}

export interface SelectionMarketProductSnapshot extends SelectionMarketProductListItem {
  minimumPrice: Money;
  purchaseRate: number | null;
  dailySalesAmount: Money;
  dailySalesUnits: number;
  endingInventoryUnits: number;
  fulfillmentScheme: string;
  volumeLiters: number;
  impressions: number;
  searchCatalogViews: number;
  cardViews: number;
  searchCatalogCartRate: number;
  cardCartRate: number;
  promotionDiscountRate: number;
  promotedOrderShare: number;
  promotionDays: number;
  advertisedDays: number;
  advertisingCostShare: number;
  productCardCreatedDate: string | null;
}

export interface SelectionMarketProductDetail extends SelectionMarketProductSnapshot {
  history: SelectionMarketProductSnapshot[];
}

export interface WordstatSettingsView {
  configured: boolean;
  folderId: string | null;
  hasApiKey: boolean;
}

export type WordstatJobStatus = "queued" | "running" | "completed" | "partial" | "failed";

export interface WordstatJobView {
  id: string;
  status: WordstatJobStatus;
  total: number;
  completed: number;
  failed: number;
  createdAt: string;
  finishedAt: string | null;
}

export const selectionCandidateStatuses = ["watching", "recommended", "rejected"] as const;
export type SelectionCandidateStatus = (typeof selectionCandidateStatuses)[number];

export interface SelectionCandidateKeyword {
  id: string;
  phrase: string;
  demandScore: number | null;
}

export interface SelectionCandidate {
  id: string;
  name: string;
  ozonUrl: string | null;
  category: string | null;
  targetPrice: Money | null;
  status: SelectionCandidateStatus;
  decisionReason: string | null;
  note: string | null;
  keyword: SelectionCandidateKeyword | null;
  marketProduct: SelectionMarketProductListItem | null;
  createdAt: string;
  updatedAt: string;
}

export interface SelectionCandidateCreateInput {
  keywordId?: string | undefined;
  marketProductId?: string | undefined;
  name: string;
  ozonUrl?: string | undefined;
  category?: string | undefined;
  targetPrice?: string | undefined;
  note?: string | undefined;
}

export interface SelectionCandidateUpdateInput {
  keywordId?: string | null | undefined;
  marketProductId?: string | null | undefined;
  name?: string | undefined;
  ozonUrl?: string | null | undefined;
  category?: string | null | undefined;
  targetPrice?: string | null | undefined;
  status?: SelectionCandidateStatus | undefined;
  decisionReason?: string | null | undefined;
  note?: string | null | undefined;
}

export interface SelectionImportView {
  id: string;
  kind: SelectionImportKind;
  fileName: string;
  snapshotDate: string;
  sheetName: string;
  reportPeriodDays: number | null;
  validRows: number;
  skippedRows: number;
  createdAt: string;
}

export interface SelectionOverview {
  keywordCount: number;
  scoredKeywordCount: number;
  marketProductCount: number;
  latestMarketProductSnapshotDate: string | null;
  wordstatReadyCount: number;
  candidateCounts: Record<SelectionCandidateStatus, number>;
  lastImportAt: string | null;
}

export const selectionCategoryPeriods = [7, 28] as const;
export type SelectionCategoryPeriod = (typeof selectionCategoryPeriods)[number];

export const selectionCategorySorts = [
  "gmv",
  "growth",
  "averagePrice",
  "competition",
  "concentration",
] as const;
export type SelectionCategorySort = (typeof selectionCategorySorts)[number];

export interface SelectionCategoryMetric {
  id: string;
  name: string;
  categoryLevel1Id: string;
  categoryLevel1Name: string;
  periodDays: SelectionCategoryPeriod;
  gmv: Money;
  gmvGrowth: number | null;
  orderedUnits: number;
  averagePrice: Money;
  averagePriceGrowth: number | null;
  sellerCount: number | null;
  brandCount: number | null;
  clusterCount: number | null;
  buyoutRate: number | null;
  topFiveSellerShare: number | null;
  categoryShare: number | null;
  rating: number | null;
  maximumRating: number | null;
}

export interface SelectionCategoryFacets {
  categoryLevel1: Array<{ id: string; name: string }>;
}

export interface SelectionCategoryPage {
  items: SelectionCategoryMetric[];
  facets: SelectionCategoryFacets;
  page: number;
  pageSize: number;
  total: number;
  snapshotId: string | null;
  collectedAt: string | null;
}

export interface SelectionCategoryLevel1Summary {
  id: string;
  name: string;
  categoryCount: number;
  gmv: Money;
  orderedUnits: number;
}

export interface SelectionCategoryOverview {
  snapshotId: string | null;
  collectedAt: string | null;
  source: "collector" | "cloud" | null;
  periodDays: SelectionCategoryPeriod;
  categoryCount: number;
  totalGmv: Money;
  totalOrderedUnits: number;
  summaries: SelectionCategoryLevel1Summary[];
}

export type SelectionCategorySyncStatus = "idle" | "running" | "completed" | "failed";

export interface SelectionCategorySyncView {
  id: string | null;
  status: SelectionCategorySyncStatus;
  totalSteps: number;
  completedSteps: number;
  currentCategory: string | null;
  error: string | null;
  cloudPublished: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SelectionCategorySourceSettingsView {
  collectorEnabled: boolean;
  opencliPath: string;
  cloudBaseUrl: string | null;
  hasUploadToken: boolean;
}

export interface SelectionCategorySourceSettingsInput {
  collectorEnabled: boolean;
  opencliPath: string;
  cloudBaseUrl?: string | null | undefined;
  uploadToken?: string | undefined;
}

export interface SelectionCategoryCloudMetric {
  id: string;
  name: string;
  categoryLevel1Id: string;
  categoryLevel1Name: string;
  periodDays: SelectionCategoryPeriod;
  gmvMinor: string;
  gmvGrowth: number | null;
  orderedUnits: number;
  averagePriceMinor: string;
  averagePriceGrowth: number | null;
  sellerCount: number | null;
  brandCount: number | null;
  clusterCount: number | null;
  buyoutRate: number | null;
  topFiveSellerShare: number | null;
  categoryShare: number | null;
  rating: number | null;
  maximumRating: number | null;
}

export interface SelectionCategoryCloudSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  collectedAt: string;
  periods: [7, 28];
  rowCount: number;
  metrics: SelectionCategoryCloudMetric[];
  products?: SelectionDiscoveryProductRanking[];
  queries?: SelectionDiscoveryQueryRanking[];
  categoryLinks?: SelectionCategoryLink[];
  discoveryCounts?: SelectionDiscoverySnapshot["counts"];
}

export interface SelectionCategoryCloudManifest {
  schemaVersion: 1;
  snapshotId: string;
  collectedAt: string;
  rowCount: number;
  sha256: string;
  downloadUrl: string;
  expiresAt: string;
}

export type SelectionDiscoveryStage = "categories" | "products" | "queries" | "publishing";

export interface SelectionDiscoverySyncJob {
  id: string | null;
  source: "collector" | "cloud" | null;
  status: SelectionCategorySyncStatus;
  stage: SelectionDiscoveryStage | null;
  totalSteps: number;
  completedSteps: number;
  currentItem: string | null;
  stageProgress: Record<"categories" | "products" | "queries", { completed: number; total: number }>;
  error: string | null;
  cloudPublished: boolean;
  resumable: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SelectionDiscoverySourceSettings extends SelectionCategorySourceSettingsView {
  estimatedDurationMinutes: [number, number];
}

export interface SelectionDiscoverySourceSettingsInput extends SelectionCategorySourceSettingsInput {}

export interface SelectionCategoryLink {
  categoryId: string;
  categoryName: string;
  categoryLevel1Id: string;
  categoryLevel1Name: string;
  productTypeIds: string[];
  queryGroups: string[];
  queryScope: "category_level_1" | "unavailable";
}

/** Normalized Ozon bestseller row stored in an immutable discovery snapshot. */
export interface SelectionDiscoveryProductRanking {
  ozonProductId: string;
  name: string;
  ozonUrl: string;
  photoUrl: string | null;
  seller: string;
  sellerId: string | null;
  brand: string;
  brandId: string | null;
  categoryLevel1Id: string;
  categoryLevel1: string;
  categoryLevel3Id: string;
  categoryLevel3: string;
  scope: "global" | "category";
  scopeCategoryId: string | null;
  periodDays: SelectionCategoryPeriod;
  rank: number;
  orderedAmountMinor: string;
  orderedUnits: number;
  turnoverGrowth: number | null;
  averagePriceMinor: string;
  minimumPriceMinor: string;
  purchaseRate: number | null;
  missedSalesMinor: string;
  outOfStockDays: number | null;
  stock: number | null;
  fboStock: number | null;
  fbsStock: number | null;
  fulfillmentScheme: string;
  volumeLiters: number | null;
  impressions: number;
  searchViews: number;
  cardViews: number;
  impressionToOrderRate: number;
  searchToCartRate: number;
  cardToCartRate: number;
  promotionDiscountRate: number;
  promotedOrderShare: number;
  promotionDays: number;
  advertisedDays: number;
  advertisingCostShare: number;
  productCardCreatedDate: string | null;
}

/** Normalized Ozon market-query row. Query metrics are currently limited to seven days. */
export interface SelectionDiscoveryQueryRanking {
  phrase: string;
  normalizedPhrase: string;
  scope: "global" | "group";
  groupName: string | null;
  periodDays: 7;
  rank: number;
  searchCount: number;
  searchesWithCart: number;
  cartRate: number;
  orderedUnits: number;
  orderRate: number;
  orderedAmountMinor: string;
  averagePriceMinor: string;
  productViews: number;
  competingSellers: number;
  noInteractionCount: number;
  noInteractionRate: number;
  noResultCount: number;
  noResultRate: number;
  averageProductCount: number;
}

export interface SelectionDiscoverySnapshot {
  snapshotId: string;
  collectedAt: string;
  source: "collector" | "cloud";
  counts: {
    categoryMetrics: number;
    productRankings: number;
    queryRankings: number;
    categoryLinks: number;
  };
}

export const selectionMarketRankingSorts = [
  "orderedAmount",
  "orderedUnits",
  "turnoverGrowth",
  "missedSales",
  "conversionRate",
  "averagePrice",
] as const;
export type SelectionMarketRankingSort = (typeof selectionMarketRankingSorts)[number];

export interface SelectionMarketProductRankingListItem extends SelectionMarketProductListItem {
  photoUrl: string | null;
  rank: number;
  scope: "global" | "category";
  scopeCategoryId: string | null;
  stock: number | null;
}

export interface SelectionMarketProductRankingPage {
  items: SelectionMarketProductRankingListItem[];
  facets: SelectionMarketProductFacets;
  page: number;
  pageSize: number;
  total: number;
  periodDays: SelectionCategoryPeriod;
  scope: "global" | "category";
  categoryId: string | null;
  snapshotId: string | null;
  collectedAt: string | null;
}

export interface SelectionMarketProductRankingDetail extends SelectionMarketProductRankingListItem {
  minimumPrice: Money;
  purchaseRate: number | null;
  stock: number | null;
  fboStock: number | null;
  fbsStock: number | null;
  fulfillmentScheme: string;
  volumeLiters: number | null;
  impressions: number;
  searchViews: number;
  cardViews: number;
  searchToCartRate: number;
  cardToCartRate: number;
  promotionDiscountRate: number;
  promotedOrderShare: number;
  promotionDays: number;
  advertisedDays: number;
  advertisingCostShare: number;
  productCardCreatedDate: string | null;
}

export const selectionMarketQuerySorts = [
  "searchCount",
  "cartRate",
  "orderedUnits",
  "orderRate",
  "orderedAmount",
  "competition",
] as const;
export type SelectionMarketQuerySort = (typeof selectionMarketQuerySorts)[number];

export interface SelectionMarketQueryListItem {
  id: string;
  phrase: string;
  rank: number;
  scope: "global" | "group";
  groupName: string | null;
  searchCount: number;
  searchesWithCart: number;
  cartRate: number;
  orderedUnits: number;
  orderRate: number;
  orderedAmount: Money;
  averagePrice: Money;
  productViews: number;
  competingSellers: number;
  noInteractionCount: number;
  noInteractionRate: number;
  noResultCount: number;
  noResultRate: number;
  averageProductCount: number;
  wordstatStatus: SelectionKeywordListItem["wordstatStatus"];
}

export interface SelectionMarketQueryPage {
  items: SelectionMarketQueryListItem[];
  groups: string[];
  page: number;
  pageSize: number;
  total: number;
  periodDays: 7;
  scope: "global" | "group";
  categoryId: string | null;
  categoryLink: SelectionCategoryLink | null;
  snapshotId: string | null;
  collectedAt: string | null;
}

export interface SelectionMarketQueryDetail extends SelectionMarketQueryListItem {
  wordstat: SelectionWordstatView | null;
}
