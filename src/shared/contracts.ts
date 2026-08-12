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
