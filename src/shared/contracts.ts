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
