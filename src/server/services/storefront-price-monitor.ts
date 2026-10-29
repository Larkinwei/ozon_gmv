import { randomUUID } from "node:crypto";

import type { AppDatabase } from "../db/database";

export type StorefrontPriceJobStatus = "queued" | "running" | "paused" | "completed" | "cancelled";
export type StorefrontPriceItemStatus = "queued" | "running" | "success" | "failed" | "no_data" | "cancelled";

export interface StorefrontPriceProduct {
  productId: string;
  sku: string | null;
  offerId: string;
  productName: string | null;
  imageUrl: string | null;
  backendPrice: string | null;
  currencyCode: string | null;
}

export interface StorefrontPriceJobItemView extends StorefrontPriceProduct {
  id: string;
  status: StorefrontPriceItemStatus;
  greenPrice: string | null;
  blackPrice: string | null;
  error: string | null;
  capturedAt: string | null;
}

export interface StorefrontPriceJobView {
  id: string;
  storeId: string;
  storeName: string;
  status: StorefrontPriceJobStatus;
  totalCount: number;
  completedCount: number;
  successCount: number;
  failedCount: number;
  noDataCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  itemPage: number;
  itemPageSize: number;
  itemTotal: number;
  items: StorefrontPriceJobItemView[];
}

export type StorefrontPriceJobSummary = Omit<StorefrontPriceJobView, "items" | "itemPage" | "itemPageSize" | "itemTotal">;

export interface StorefrontPriceSnapshotView extends StorefrontPriceProduct {
  id: string;
  greenPrice: string | null;
  blackPrice: string | null;
  capturedAt: string;
}

export interface StorefrontPriceQueueItem {
  id: string;
  sku: string;
}

interface JobRow {
  id: string;
  store_id: string;
  store_name: string;
  status: StorefrontPriceJobStatus;
  total_count: number;
  completed_count: number;
  success_count: number;
  failed_count: number;
  no_data_count: number;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
}

interface ItemRow {
  id: string;
  product_id: string;
  sku: string | null;
  offer_id: string;
  product_name: string | null;
  image_url: string | null;
  backend_price: string | null;
  currency_code: string | null;
  status: StorefrontPriceItemStatus;
  green_price: string | null;
  black_price: string | null;
  error: string | null;
  captured_at_ms: number | null;
}

interface SnapshotRow extends Omit<ItemRow, "status" | "error"> {
  captured_at_ms: number;
}

interface OzonPricePayload {
  sku?: string | number;
  greenPrice?: string | number | null;
  blackPrice?: string | number | null;
  widgetStates?: Record<string, string>;
  widgetState?: Record<string, string>;
  pageInfo?: { analyticsInfo?: { sku?: string | number } };
  seo?: { script?: Array<{ type?: string; innerHTML?: string }> };
}

interface PriceParseResult {
  sku: string | null;
  greenPrice: string | null;
  blackPrice: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numericPrice(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value.toFixed(2) : null;
  if (typeof value !== "string") return null;
  const match = value.match(/\d[\d\s\u00a0\u202f.,]*/u)?.[0];
  if (!match) return null;
  let normalized = match.replace(/[\s\u00a0\u202f]/gu, "").replace(/\.(?=.*\.)/gu, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.lastIndexOf(",") > normalized.lastIndexOf(".")
      ? normalized.replace(/\./gu, "").replace(",", ".")
      : normalized.replace(/,/gu, "");
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(",", ".");
  }
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount.toFixed(2) : null;
}

function valuePrice(value: unknown, depth = 0): string | null {
  if (depth > 5) return null;
  const direct = numericPrice(value);
  if (direct !== null) return direct;
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["price", "value", "text", "amount", "label"]) {
    const price = valuePrice(record[key], depth + 1);
    if (price !== null) return price;
  }
  return null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function readWidget(widgetStates: Record<string, string> | undefined, prefix: string): Record<string, unknown> | null {
  if (!widgetStates) return null;
  const entry = Object.entries(widgetStates).find(([key]) => key.split("-")[0] === prefix)?.[1];
  return asRecord(parseJson(entry));
}

function readSku(payload: OzonPricePayload, widgetStates: Record<string, string> | undefined): string | null {
  const detail = readWidget(widgetStates, "webDetailSKU");
  const fromDetail = detail?.copyText;
  if (typeof fromDetail === "string" || typeof fromDetail === "number") return String(fromDetail).trim() || null;
  const analyticsSku = payload.pageInfo?.analyticsInfo?.sku;
  if (typeof analyticsSku === "string" || typeof analyticsSku === "number") return String(analyticsSku).trim() || null;
  for (const script of payload.seo?.script ?? []) {
    if (script.type !== "application/ld+json" || !script.innerHTML) continue;
    const parsed = asRecord(parseJson(script.innerHTML));
    const sku = parsed?.sku;
    if (typeof sku === "string" || typeof sku === "number") return String(sku).trim() || null;
  }
  return null;
}

/** Parses only Ozon's storefront price widgets and an explicit SKU identity field. */
export function parseOzonStorefrontPricePayload(input: unknown): PriceParseResult {
  const payload = asRecord(input) as OzonPricePayload | null;
  if (!payload) return { sku: null, greenPrice: null, blackPrice: null };
  if (payload.sku !== undefined) {
    return {
      sku: String(payload.sku).trim() || null,
      greenPrice: numericPrice(payload.greenPrice),
      blackPrice: numericPrice(payload.blackPrice),
    };
  }
  const states = payload.widgetStates ?? payload.widgetState;
  const priceWidget = readWidget(states, "webPrice");
  return {
    sku: readSku(payload, states),
    greenPrice: valuePrice(priceWidget?.cardPrice),
    blackPrice: valuePrice(priceWidget?.price),
  };
}

function jobView(row: JobRow, itemRows: ItemRow[], itemPage: number, itemPageSize: number): StorefrontPriceJobView {
  return {
    id: row.id,
    storeId: row.store_id,
    storeName: row.store_name,
    status: row.status,
    totalCount: row.total_count,
    completedCount: row.completed_count,
    successCount: row.success_count,
    failedCount: row.failed_count,
    noDataCount: row.no_data_count,
    createdAt: new Date(row.created_at_ms).toISOString(),
    startedAt: row.started_at_ms === null ? null : new Date(row.started_at_ms).toISOString(),
    finishedAt: row.finished_at_ms === null ? null : new Date(row.finished_at_ms).toISOString(),
    itemPage,
    itemPageSize,
    itemTotal: row.total_count,
    items: itemRows.map((item) => ({
      id: item.id,
      productId: item.product_id,
      sku: item.sku,
      offerId: item.offer_id,
      productName: item.product_name,
      imageUrl: item.image_url,
      backendPrice: item.backend_price,
      currencyCode: item.currency_code,
      status: item.status,
      greenPrice: item.green_price,
      blackPrice: item.black_price,
      error: item.error,
      capturedAt: item.captured_at_ms === null ? null : new Date(item.captured_at_ms).toISOString(),
    })),
  };
}

/** Persists storefront jobs; Ozon page requests are performed by the collector extension. */
export class StorefrontPriceMonitorService {
  public constructor(private readonly database: AppDatabase) {
    database.prepare("UPDATE storefront_price_job_items SET status = 'queued' WHERE status = 'running'").run();
    database.prepare("UPDATE storefront_price_jobs SET status = 'queued' WHERE status = 'running'").run();
  }

  public start(): void {}

  public async stop(): Promise<void> {}

  public createJob(store: { id: string; name: string }, products: StorefrontPriceProduct[]): StorefrontPriceJobView {
    if (products.length === 0) throw new Error("没有可采集的在线商品");
    if (products.length > 20_000) throw new Error("单次最多采集 20000 个在线商品");
    const now = Date.now();
    const jobId = randomUUID();
    const insertJob = this.database.prepare(
      "INSERT INTO storefront_price_jobs (id, store_id, store_name, status, total_count, created_at_ms) VALUES (?, ?, ?, 'queued', ?, ?)",
    );
    const insertItem = this.database.prepare(
      `INSERT INTO storefront_price_job_items
       (id, job_id, product_id, sku, offer_id, product_name, image_url, backend_price, currency_code, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.database.transaction(() => {
      insertJob.run(jobId, store.id, store.name, products.length, now);
      for (const product of products) {
        const validSku = product.sku && /^\d+$/.test(product.sku.trim()) ? product.sku.trim() : null;
        insertItem.run(
          randomUUID(), jobId, product.productId, validSku, product.offerId, product.productName, product.imageUrl,
          product.backendPrice, product.currencyCode,
          validSku ? "queued" : "failed",
          validSku ? null : "Seller 未返回有效 Ozon SKU，无法安全查询前台价格",
        );
      }
      this.recount(jobId);
    })();
    return this.getJob(jobId)!;
  }

  /** Activates a job after the authorized browser extension accepts its queue. */
  public activateJob(id: string): StorefrontPriceJobView | null {
    const now = Date.now();
    this.database.prepare("UPDATE storefront_price_jobs SET status = 'running', started_at_ms = COALESCE(started_at_ms, ?), finished_at_ms = NULL WHERE id = ? AND status = 'queued'").run(now, id);
    return this.getJob(id);
  }

  public listQueuedItems(jobId: string): StorefrontPriceQueueItem[] {
    return this.database.prepare("SELECT id, sku FROM storefront_price_job_items WHERE job_id = ? AND status = 'queued' AND sku IS NOT NULL ORDER BY rowid ASC")
      .all(jobId) as StorefrontPriceQueueItem[];
  }

  /** Saves one result returned by the Ozon-authorized browser extension. */
  public recordBrowserResult(jobId: string, itemId: string, payload: unknown, fetchError: string | null): boolean {
    const item = this.database.prepare(
      `SELECT i.*, j.store_id FROM storefront_price_job_items i
       JOIN storefront_price_jobs j ON j.id = i.job_id WHERE i.job_id = ? AND i.id = ?`,
    ).get(jobId, itemId) as (ItemRow & { job_id: string; store_id: string }) | undefined;
    if (!item || ["success", "failed", "no_data", "cancelled"].includes(item.status)) return false;
    if (item.status === "queued") {
      this.database.prepare("UPDATE storefront_price_job_items SET status = 'running' WHERE id = ?").run(item.id);
    }
    if (fetchError) {
      this.finishItem(item, "failed", null, null, fetchError, null);
      return true;
    }
    const parsed = parseOzonStorefrontPricePayload(payload);
    if (parsed.sku !== item.sku) {
      this.finishItem(item, "failed", null, null, parsed.sku ? `页面 SKU ${parsed.sku} 与目标 SKU ${item.sku} 不一致` : "页面未返回可核对的 Ozon SKU", null);
      return true;
    }
    if (parsed.greenPrice === null && parsed.blackPrice === null) {
      this.finishItem(item, "no_data", null, null, "页面未显示绿标价或黑标价", null);
    } else {
      this.finishItem(item, "success", parsed.greenPrice, parsed.blackPrice, null, Date.now());
    }
    return true;
  }

  public retryItem(jobId: string, itemId: string): { job: StorefrontPriceJobView; item: StorefrontPriceQueueItem } | null {
    const item = this.database.prepare("SELECT status, sku FROM storefront_price_job_items WHERE job_id = ? AND id = ?").get(jobId, itemId) as { status: StorefrontPriceItemStatus; sku: string | null } | undefined;
    if (!item || !["failed", "no_data"].includes(item.status) || !item.sku) return null;
    this.database.prepare("UPDATE storefront_price_job_items SET status = 'queued', green_price = NULL, black_price = NULL, error = NULL, captured_at_ms = NULL WHERE job_id = ? AND id = ?")
      .run(jobId, itemId);
    this.database.prepare("UPDATE storefront_price_jobs SET status = 'queued', finished_at_ms = NULL WHERE id = ?").run(jobId);
    this.recount(jobId);
    const job = this.getJob(jobId);
    return job ? { job, item: { id: itemId, sku: item.sku } } : null;
  }

  public deleteFailedItem(jobId: string, itemId: string): StorefrontPriceJobView | null {
    const result = this.database.prepare("DELETE FROM storefront_price_job_items WHERE job_id = ? AND id = ? AND status IN ('failed', 'no_data')").run(jobId, itemId);
    if (result.changes === 0) return null;
    this.database.prepare("UPDATE storefront_price_jobs SET total_count = MAX(0, total_count - 1) WHERE id = ?").run(jobId);
    this.recount(jobId);
    return this.getJob(jobId);
  }

  public listJobs(limit = 20): StorefrontPriceJobSummary[] {
    const rows = this.database.prepare("SELECT * FROM storefront_price_jobs ORDER BY created_at_ms DESC LIMIT ?").all(limit) as JobRow[];
    return rows.map((row) => ({
      id: row.id,
      storeId: row.store_id,
      storeName: row.store_name,
      status: row.status,
      totalCount: row.total_count,
      completedCount: row.completed_count,
      successCount: row.success_count,
      failedCount: row.failed_count,
      noDataCount: row.no_data_count,
      createdAt: new Date(row.created_at_ms).toISOString(),
      startedAt: row.started_at_ms === null ? null : new Date(row.started_at_ms).toISOString(),
      finishedAt: row.finished_at_ms === null ? null : new Date(row.finished_at_ms).toISOString(),
    }));
  }

  public getJob(id: string, itemPage = 1, itemPageSize = 100): StorefrontPriceJobView | null {
    const row = this.database.prepare("SELECT * FROM storefront_price_jobs WHERE id = ?").get(id) as JobRow | undefined;
    if (!row) return null;
    const items = this.database.prepare("SELECT * FROM storefront_price_job_items WHERE job_id = ? ORDER BY rowid ASC LIMIT ? OFFSET ?")
      .all(id, itemPageSize, (itemPage - 1) * itemPageSize) as ItemRow[];
    return jobView(row, items, itemPage, itemPageSize);
  }

  public setJobState(id: string, action: "pause" | "resume" | "cancel"): StorefrontPriceJobView | null {
    const row = this.database.prepare("SELECT status FROM storefront_price_jobs WHERE id = ?").get(id) as { status: StorefrontPriceJobStatus } | undefined;
    if (!row) return null;
    const now = Date.now();
    if (action === "pause" && ["queued", "running"].includes(row.status)) {
      this.database.transaction(() => {
        this.database.prepare("UPDATE storefront_price_job_items SET status = 'queued' WHERE job_id = ? AND status = 'running'").run(id);
        this.database.prepare("UPDATE storefront_price_jobs SET status = 'paused' WHERE id = ?").run(id);
      })();
    } else if (action === "resume" && row.status === "paused") {
      this.database.prepare("UPDATE storefront_price_jobs SET status = 'queued' WHERE id = ?").run(id);
    } else if (action === "cancel" && !["completed", "cancelled"].includes(row.status)) {
      this.database.transaction(() => {
        this.database.prepare("UPDATE storefront_price_job_items SET status = 'cancelled' WHERE job_id = ? AND status IN ('queued', 'running')").run(id);
        this.database.prepare("UPDATE storefront_price_jobs SET status = 'cancelled', finished_at_ms = ? WHERE id = ?").run(now, id);
        this.recount(id);
      })();
    }
    return this.getJob(id);
  }

  public listLatest(input: { storeId: string; search: string; page: number; pageSize: number }): { items: StorefrontPriceSnapshotView[]; total: number } {
    const pattern = `%${input.search.trim()}%`;
    const rows = this.database.prepare(
      `WITH ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY captured_at_ms DESC) AS row_number
         FROM storefront_price_snapshots WHERE store_id = ?
       ) SELECT * FROM ranked WHERE row_number = 1 AND (sku LIKE ? OR offer_id LIKE ? OR COALESCE(product_name, '') LIKE ?)
       ORDER BY captured_at_ms DESC LIMIT ? OFFSET ?`,
    ).all(input.storeId, pattern, pattern, pattern, input.pageSize, (input.page - 1) * input.pageSize) as SnapshotRow[];
    const total = this.database.prepare(
      `WITH ranked AS (
         SELECT product_id, sku, offer_id, product_name, ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY captured_at_ms DESC) AS row_number
         FROM storefront_price_snapshots WHERE store_id = ?
       ) SELECT COUNT(*) AS total FROM ranked WHERE row_number = 1 AND (sku LIKE ? OR offer_id LIKE ? OR COALESCE(product_name, '') LIKE ?)`
    ).get(input.storeId, pattern, pattern, pattern) as { total: number };
    return { items: rows.map((row) => this.snapshotView(row)), total: total.total };
  }

  public listHistory(storeId: string, productId: string, limit = 100): StorefrontPriceSnapshotView[] {
    const rows = this.database.prepare(
      "SELECT * FROM storefront_price_snapshots WHERE store_id = ? AND product_id = ? ORDER BY captured_at_ms DESC LIMIT ?",
    ).all(storeId, productId, limit) as SnapshotRow[];
    return rows.map((row) => this.snapshotView(row));
  }

  private snapshotView(row: SnapshotRow): StorefrontPriceSnapshotView {
    return {
      id: row.id,
      productId: row.product_id,
      sku: row.sku,
      offerId: row.offer_id,
      productName: row.product_name,
      imageUrl: row.image_url,
      backendPrice: row.backend_price,
      currencyCode: row.currency_code,
      greenPrice: row.green_price,
      blackPrice: row.black_price,
      capturedAt: new Date(row.captured_at_ms).toISOString(),
    };
  }

  private finishItem(item: ItemRow & { job_id: string; store_id: string }, status: "success" | "failed" | "no_data", greenPrice: string | null, blackPrice: string | null, error: string | null, capturedAt: number | null): void {
    this.database.transaction(() => {
      this.database.prepare(
        "UPDATE storefront_price_job_items SET status = ?, green_price = ?, black_price = ?, error = ?, captured_at_ms = ? WHERE id = ?",
      ).run(status, greenPrice, blackPrice, error, capturedAt, item.id);
      if (status === "success" && capturedAt !== null && item.sku) {
        this.database.prepare(
          `INSERT INTO storefront_price_snapshots
           (id, store_id, product_id, sku, offer_id, product_name, image_url, backend_price, green_price, black_price, currency_code, captured_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), item.store_id, item.product_id, item.sku, item.offer_id, item.product_name, item.image_url, item.backend_price, greenPrice, blackPrice, item.currency_code, capturedAt);
      }
      this.recount(item.job_id);
    })();
  }

  private recount(jobId: string): void {
    this.database.prepare(
      `UPDATE storefront_price_jobs SET
         completed_count = (SELECT COUNT(*) FROM storefront_price_job_items WHERE job_id = ? AND status IN ('success', 'failed', 'no_data', 'cancelled')),
         success_count = (SELECT COUNT(*) FROM storefront_price_job_items WHERE job_id = ? AND status = 'success'),
         failed_count = (SELECT COUNT(*) FROM storefront_price_job_items WHERE job_id = ? AND status = 'failed'),
         no_data_count = (SELECT COUNT(*) FROM storefront_price_job_items WHERE job_id = ? AND status = 'no_data')
       WHERE id = ?`,
    ).run(jobId, jobId, jobId, jobId, jobId);
    const job = this.database.prepare("SELECT status, total_count, completed_count FROM storefront_price_jobs WHERE id = ?").get(jobId) as { status: StorefrontPriceJobStatus; total_count: number; completed_count: number } | undefined;
    if (job && job.completed_count >= job.total_count && job.status !== "cancelled") {
      this.database.prepare("UPDATE storefront_price_jobs SET status = 'completed', finished_at_ms = ? WHERE id = ?").run(Date.now(), jobId);
    }
  }
}
