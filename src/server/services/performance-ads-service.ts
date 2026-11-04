import Decimal from "decimal.js";

import type { AppConfig } from "../config";
import type { AppDatabase } from "../db/database";
import type { StoreRecord, StoresRepository } from "../db/stores-repository";
import type { ProxySettingsService } from "./proxy-settings-service";
import { decryptSecret, encryptSecret } from "../security/encryption";
import { SettingsRepository } from "../db/settings-repository";

const API_BASE = "https://api-performance.ozon.ru";
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUEST_GAP_MS = 750;
const RATE_LIMIT_RETRY_COUNT = 4;
const RATE_LIMIT_RETRY_BASE_MS = 2_000;

interface Campaign {
  id: string;
  name: string;
  state: string;
  type: string;
}

interface AdMetric {
  date: string;
  campaignId: string;
  sku: string;
  impressions: number;
  clicks: number;
  expense: string;
  orders: number;
  sales: string;
}

interface Credentials {
  clientId: string;
  clientSecret: string;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

function settingKey(storeId: string, field: "client_id" | "client_secret"): string {
  return `performance.ads.${storeId}.${field}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstArray(data: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) if (Array.isArray(data[key])) return data[key] as unknown[];
  return [];
}

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function amount(value: unknown): string {
  try { return new Decimal(String(value ?? 0).replace(",", ".")).toFixed(2); }
  catch { return "0.00"; }
}

function parseCampaigns(payload: unknown): Campaign[] {
  const root = asRecord(payload);
  return firstArray(root, ["campaigns", "list", "items"]).map((item) => {
    const row = asRecord(item);
    return {
      id: String(row.id ?? row.campaignId ?? row.campaign_id ?? ""),
      name: String(row.title ?? row.name ?? "未命名活动"),
      state: String(row.state ?? row.status ?? "unknown").toLowerCase(),
      type: String(row.advObjectType ?? row.type ?? row.campaignType ?? ""),
    };
  }).filter((item) => item.id.length > 0);
}

function parseMetrics(payload: unknown, defaultCampaignId = ""): AdMetric[] {
  const root = asRecord(payload);
  const rows = firstArray(root, ["rows", "items", "data", "report", "daily", "statistics"]);
  const flattened = rows.length ? rows : asArray(root.result);
  return flattened.map((item) => {
    const row = asRecord(item);
    return {
      date: String(row.date ?? row.dateFrom ?? row.day ?? row.statDate ?? "").slice(0, 10),
      // The daily report names the campaign key `id`; SKU reports use `campaignId`.
      campaignId: String(row.campaignId ?? row.campaign_id ?? row.id ?? defaultCampaignId),
      sku: String(row.sku ?? row.offerId ?? row.offer_id ?? ""),
      impressions: asNumber(row.impressions ?? row.views),
      clicks: asNumber(row.clicks),
      expense: amount(row.moneySpent ?? row.expense ?? row.spend),
      orders: asNumber(row.orders ?? row.ordersCount ?? row.attributedOrders),
      sales: amount(row.revenue ?? row.sales ?? row.ordersMoney),
    };
  }).filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.campaignId);
}

function unwrapMetricPayload(payload: unknown): unknown {
  const root = asRecord(payload);
  return root.data ?? root.result ?? root;
}

/** Stores encrypted Performance credentials and idempotent, store-scoped ad report data. */
export class PerformanceAdsService {
  private readonly settings: SettingsRepository;
  private readonly tokens = new Map<string, TokenCache>();
  private readonly running = new Set<string>();
  private readonly requestQueues = new Map<string, Promise<void>>();
  private readonly lastRequestFinishedAt = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly stores: StoresRepository,
    private readonly proxySettings: ProxySettingsService,
    settings?: SettingsRepository,
  ) {
    this.settings = settings ?? new SettingsRepository(database);
  }

  public async view(storeId: string): Promise<Record<string, unknown>> {
    const store = await this.requireStore(storeId);
    const clientId = this.readSecret(settingKey(storeId, "client_id"));
    const clientSecret = this.readSecret(settingKey(storeId, "client_secret"));
    const state = this.database.prepare("SELECT * FROM performance_ad_sync_state WHERE store_id = ?").get(storeId) as Record<string, unknown> | undefined;
    return {
      storeId, storeName: store.name, configured: Boolean(clientId && clientSecret),
      clientIdMasked: clientId ? `${clientId.slice(0, 3)}•••${clientId.slice(-3)}` : null,
      status: state?.status ?? "idle", lastStartedAt: state?.last_started_at_ms ? new Date(Number(state.last_started_at_ms)).toISOString() : null,
      lastFinishedAt: state?.last_finished_at_ms ? new Date(Number(state.last_finished_at_ms)).toISOString() : null,
      lastError: state?.last_error ?? null, initialBackfillDone: Boolean(state?.initial_backfill_done),
    };
  }

  public async save(storeId: string, input: { clientId?: string; clientSecret?: string }): Promise<Record<string, unknown>> {
    await this.requireStore(storeId);
    const oldClientId = this.readSecret(settingKey(storeId, "client_id"));
    const clientId = input.clientId?.trim() || oldClientId;
    if (!clientId) throw new Error("首次配置需要填写 Performance API Client ID");
    const oldSecret = this.readSecret(settingKey(storeId, "client_secret"));
    const secret = input.clientSecret?.trim() || oldSecret;
    if (!secret) throw new Error("首次配置需要填写 Performance API Client Secret");
    if (input.clientId?.trim()) this.settings.set(settingKey(storeId, "client_id"), encryptSecret(clientId, this.config.ENCRYPTION_KEY));
    if (input.clientSecret?.trim()) this.settings.set(settingKey(storeId, "client_secret"), encryptSecret(secret, this.config.ENCRYPTION_KEY));
    this.tokens.delete(storeId);
    return this.view(storeId);
  }

  public async test(storeId: string): Promise<{ ok: true; message: string }> {
    const token = await this.accessToken(storeId);
    await this.request(storeId, "/api/client/campaign", { method: "GET" }, token);
    return { ok: true, message: "Performance API 连接成功" };
  }

  public async sync(storeId: string, from: string, to: string): Promise<Record<string, unknown>> {
    this.validateDates(from, to);
    return this.syncStore(storeId, from, to, false);
  }

  /** Queues the initial 30-day import without making the settings form wait for report generation. */
  public async startInitialBackfill(storeId: string): Promise<{ accepted: boolean; message: string }> {
    await this.requireStore(storeId);
    const state = this.database.prepare("SELECT initial_backfill_done FROM performance_ad_sync_state WHERE store_id = ?").get(storeId) as { initial_backfill_done?: number } | undefined;
    if (state?.initial_backfill_done) return { accepted: false, message: "首次 30 天回填已完成" };
    if (this.running.has(storeId)) return { accepted: false, message: "该店铺广告报表正在同步" };

    const from = this.daysAgo(30);
    const to = this.yesterday();
    void this.syncStore(storeId, from, to, true).catch(() => undefined);
    return { accepted: true, message: "已在后台开始首次 30 天广告报表同步" };
  }

  public async list(storeId: string, from: string, to: string, state?: string): Promise<Record<string, unknown>> {
    await this.requireStore(storeId);
    this.validateDates(from, to);
    const campaigns = this.database.prepare(`SELECT c.*, c.campaign_id AS campaignId,
      COALESCE(SUM(CAST(m.expense AS REAL)), 0) AS expense,
      COALESCE(SUM(CAST(m.sales AS REAL)), 0) AS sales, COALESCE(SUM(m.impressions), 0) AS impressions,
      COALESCE(SUM(m.clicks), 0) AS clicks, COALESCE(SUM(m.orders), 0) AS orders
      FROM performance_ad_campaigns c LEFT JOIN performance_ad_daily_metrics m
      ON m.store_id = c.store_id AND m.campaign_id = c.campaign_id AND m.metric_date BETWEEN ? AND ? AND m.sku = ''
      WHERE c.store_id = ? AND (? = '' OR c.state = ?) GROUP BY c.store_id, c.campaign_id ORDER BY expense DESC`).all(from, to, storeId, state ?? "", state ?? "") as Array<Record<string, unknown>>;
    const skus = this.database.prepare(`SELECT m.sku, m.campaign_id AS campaignId, c.name AS campaignName,
      SUM(m.impressions) AS impressions, SUM(m.clicks) AS clicks, SUM(m.orders) AS orders,
      SUM(CAST(m.expense AS REAL)) AS expense, SUM(CAST(m.sales AS REAL)) AS sales
      FROM performance_ad_daily_metrics m LEFT JOIN performance_ad_campaigns c
      ON c.store_id = m.store_id AND c.campaign_id = m.campaign_id
      WHERE m.store_id = ? AND m.metric_date BETWEEN ? AND ? AND m.sku <> ''
      GROUP BY m.sku, m.campaign_id ORDER BY expense DESC`).all(storeId, from, to) as Array<Record<string, unknown>>;
    const totals = campaigns.reduce<{ impressions: number; clicks: number; orders: number; expense: number; sales: number }>((sum, row) => ({
      impressions: sum.impressions + Number(row.impressions), clicks: sum.clicks + Number(row.clicks),
      orders: sum.orders + Number(row.orders), expense: sum.expense + Number(row.expense), sales: sum.sales + Number(row.sales),
    }), { impressions: 0, clicks: 0, orders: 0, expense: 0, sales: 0 });
    return {
      campaigns: campaigns.map((row) => this.formatMetricRow(row)),
      skus: skus.map((row) => this.formatMetricRow(row)), totals: this.formatMetricRow(totals),
      from, to, skuHistoryLimited: from < this.yesterday(),
    };
  }

  /** Starts 30-minute recent-data refreshes and a one-time 30-day backfill for configured stores. */
  public start(): void {
    if (this.timer) return;
    void this.syncConfiguredStores();
    this.timer = setInterval(() => void this.syncConfiguredStores(), REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async syncConfiguredStores(): Promise<void> {
    for (const store of await this.stores.listActive()) {
      if (store.platform !== "ozon" || !this.readSecret(settingKey(store.id, "client_secret"))) continue;
      const state = this.database.prepare("SELECT initial_backfill_done FROM performance_ad_sync_state WHERE store_id = ?").get(store.id) as { initial_backfill_done?: number } | undefined;
      const to = this.yesterday();
      const from = state?.initial_backfill_done ? this.daysAgo(2) : this.daysAgo(30);
      try { await this.syncStore(store.id, from, to, true); } catch { /* Per-store failures are persisted and do not stop other stores. */ }
    }
  }

  private async syncStore(storeId: string, from: string, to: string, scheduled: boolean): Promise<Record<string, unknown>> {
    if (this.running.has(storeId)) throw new Error("该店铺广告数据正在同步");
    this.running.add(storeId);
    const startedAt = Date.now();
    try {
      const store = await this.requireStore(storeId);
      this.setSyncState(storeId, "syncing", startedAt, null, null, false);
      const token = await this.accessToken(storeId);
      const campaignsPayload = await this.request(storeId, "/api/client/campaign", { method: "GET" }, token);
      const campaigns = parseCampaigns(campaignsPayload);
      const upsertCampaign = this.database.prepare(`INSERT INTO performance_ad_campaigns
        (store_id, campaign_id, name, state, campaign_type, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(store_id, campaign_id) DO UPDATE SET name=excluded.name, state=excluded.state,
        campaign_type=excluded.campaign_type, updated_at_ms=excluded.updated_at_ms`);
      for (const campaign of campaigns) upsertCampaign.run(storeId, campaign.id, campaign.name, campaign.state, campaign.type, Date.now());
      const allMetrics: AdMetric[] = [];
      if (campaigns.length) {
        const daily = await this.request(storeId, `/api/client/statistics/daily/json?dateFrom=${encodeURIComponent(from)}&dateTo=${encodeURIComponent(to)}`, { method: "GET" }, token);
        allMetrics.push(...parseMetrics(unwrapMetricPayload(daily)));
        const skuFrom = from < this.yesterday() ? this.yesterday() : from;
        if (skuFrom <= to) {
          const skuPayload = await this.request(storeId, "/api/client/statistics/products/sku", {
            method: "POST", body: JSON.stringify({ campaignIds: campaigns.map((campaign) => Number(campaign.id)), dateFrom: skuFrom, dateTo: to }),
          }, token);
          allMetrics.push(...parseMetrics(unwrapMetricPayload(skuPayload)));
        }
      }
      this.saveMetrics(storeId, allMetrics);
      const initialRangeCovered = from <= this.daysAgo(30) && to >= this.yesterday();
      this.setSyncState(storeId, "success", startedAt, Date.now(), null, initialRangeCovered);
      return { ok: true, storeId, storeName: store.name, campaigns: campaigns.length, rows: allMetrics.length, from, to, scheduled };
    } catch (error) {
      this.setSyncState(storeId, "failed", startedAt, Date.now(), error instanceof Error ? error.message : "广告数据同步失败", false);
      throw error;
    } finally {
      this.running.delete(storeId);
    }
  }

  private saveMetrics(storeId: string, metrics: AdMetric[]): void {
    const statement = this.database.prepare(`INSERT INTO performance_ad_daily_metrics
      (store_id, campaign_id, metric_date, sku, impressions, clicks, expense, orders, sales, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(store_id, campaign_id, metric_date, sku) DO UPDATE SET
      impressions=excluded.impressions, clicks=excluded.clicks, expense=excluded.expense, orders=excluded.orders,
      sales=excluded.sales, updated_at_ms=excluded.updated_at_ms`);
    this.database.transaction(() => {
      for (const metric of metrics) statement.run(storeId, metric.campaignId, metric.date, metric.sku, metric.impressions,
        metric.clicks, metric.expense, metric.orders, metric.sales, Date.now());
    })();
  }

  private async accessToken(storeId: string): Promise<string> {
    const cached = this.tokens.get(storeId);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return cached.token;
    const credentials = this.credentials(storeId);
    const response = await this.proxySettings.createFetch()(new URL("/api/client/token", API_BASE), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = asRecord(await this.readJson(response));
    const token = String(payload.access_token ?? "");
    if (!response.ok || !token) throw new Error(this.apiError(payload, response.status));
    this.tokens.set(storeId, { token, expiresAt: Date.now() + asNumber(payload.expires_in) * 1000 });
    return token;
  }

  private async request(storeId: string, path: string, init: RequestInit, token: string): Promise<unknown> {
    const clientId = this.credentials(storeId).clientId;
    return this.enqueueRequest(clientId, async () => this.requestWithRetry(path, init, token));
  }

  /** Serializes requests for one Performance account because Ozon allows only one active request. */
  private async enqueueRequest<T>(clientId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.requestQueues.get(clientId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      const lastFinishedAt = this.lastRequestFinishedAt.get(clientId) ?? 0;
      const remainingGap = REQUEST_GAP_MS - (Date.now() - lastFinishedAt);
      if (remainingGap > 0) await this.delay(remainingGap);
      try {
        return await operation();
      } finally {
        this.lastRequestFinishedAt.set(clientId, Date.now());
      }
    });
    const tail = queued.then(() => undefined, () => undefined);
    this.requestQueues.set(clientId, tail);
    try {
      return await queued;
    } finally {
      if (this.requestQueues.get(clientId) === tail) this.requestQueues.delete(clientId);
    }
  }

  /** Retries Ozon's transient single-active-request response without repeating other API errors. */
  private async requestWithRetry(path: string, init: RequestInit, token: string): Promise<unknown> {
    for (let attempt = 0; attempt < RATE_LIMIT_RETRY_COUNT; attempt += 1) {
      const response = await this.proxySettings.createFetch()(new URL(path, API_BASE), {
        ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(30_000),
      });
      const payload = await this.readJson(response);
      if (response.ok) return payload;
      if (response.status !== 429 || attempt === RATE_LIMIT_RETRY_COUNT - 1) {
        throw new Error(this.apiError(asRecord(payload), response.status));
      }
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const retryDelay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
        ? retryAfterSeconds * 1_000
        : RATE_LIMIT_RETRY_BASE_MS * 2 ** attempt;
      await this.delay(retryDelay);
    }
    throw new Error("Performance API 请求重试次数已用尽");
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    try { return text ? JSON.parse(text) as unknown : {}; }
    catch { throw new Error(`Performance API 返回非 JSON 响应（HTTP ${response.status}）`); }
  }

  private apiError(payload: Record<string, unknown>, status: number): string {
    const message = String(payload.message ?? payload.error_description ?? payload.error ?? "请求失败");
    return `Performance API HTTP ${status}: ${message}`;
  }

  private credentials(storeId: string): Credentials {
    const clientId = this.readSecret(settingKey(storeId, "client_id"));
    const clientSecret = this.readSecret(settingKey(storeId, "client_secret"));
    if (!clientId || !clientSecret) throw new Error("请先配置该店铺的 Performance API 凭据");
    return { clientId, clientSecret };
  }

  private readSecret(key: string): string | null {
    const value = this.settings.get(key);
    return value ? decryptSecret(value, this.config.ENCRYPTION_KEY) : null;
  }

  private async requireStore(storeId: string): Promise<StoreRecord> {
    const store = await this.stores.findById(storeId);
    if (!store || !store.enabled || store.platform !== "ozon") throw new Error("目标 Ozon 店铺不存在或已停用");
    return store;
  }

  private validateDates(from: string, to: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Error("日期范围无效");
  }

  private setSyncState(storeId: string, status: string, started: number, finished: number | null, error: string | null, complete: boolean): void {
    this.database.prepare(`INSERT INTO performance_ad_sync_state (store_id,status,last_started_at_ms,last_finished_at_ms,last_error,initial_backfill_done)
      VALUES (?,?,?,?,?,?) ON CONFLICT(store_id) DO UPDATE SET status=excluded.status,last_started_at_ms=excluded.last_started_at_ms,
      last_finished_at_ms=COALESCE(excluded.last_finished_at_ms,performance_ad_sync_state.last_finished_at_ms),
      last_error=excluded.last_error,initial_backfill_done=MAX(performance_ad_sync_state.initial_backfill_done,excluded.initial_backfill_done)`)
      .run(storeId, status, started, finished, error, Number(complete));
  }

  private formatMetricRow(row: Record<string, unknown>): Record<string, unknown> {
    const impressions = Number(row.impressions ?? 0), clicks = Number(row.clicks ?? 0);
    const expense = Number(row.expense ?? 0), sales = Number(row.sales ?? 0);
    return { ...row, expense: expense.toFixed(2), sales: sales.toFixed(2), ctr: impressions ? clicks / impressions * 100 : 0,
      avgCpc: clicks ? expense / clicks : 0, drr: sales ? expense / sales * 100 : null };
  }

  private yesterday(): string { return this.daysAgo(1); }

  /** Uses the dashboard's business timezone so report windows do not shift around UTC midnight. */
  private daysAgo(days: number): string {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const year = Number(parts.find((part) => part.type === "year")?.value);
    const month = Number(parts.find((part) => part.type === "month")?.value);
    const day = Number(parts.find((part) => part.type === "day")?.value);
    const date = new Date(Date.UTC(year, month - 1, day - days));
    return date.toISOString().slice(0, 10);
  }
}
