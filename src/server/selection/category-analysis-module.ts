import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  SelectionCategoryCloudMetric,
  SelectionCategoryCloudSnapshot,
  SelectionCategoryOverview,
  SelectionCategoryPage,
  SelectionCategoryPeriod,
  SelectionCategorySort,
  SelectionCategorySourceSettingsInput,
  SelectionCategorySourceSettingsView,
  SelectionCategorySyncView,
} from "../../shared/contracts";
import { canonicalJson } from "../../shared/canonical-json";
import type { AppConfig } from "../config";
import type { AppDatabase } from "../db/database";
import { minorUnitsToAmount } from "../db/money-storage";
import { SettingsRepository } from "../db/settings-repository";
import { decryptSecret, encryptSecret } from "../security/encryption";
import { CategoryCloudClient, type CategoryCloudPort, type CategoryFetch } from "./category-cloud-client";
import {
  OpenCliCategoryCollector,
  type CategoryCollectorPort,
} from "./opencli-category-collector";

const COLLECTOR_ENABLED_KEY = "selection.categories.collector_enabled";
const OPENCLI_PATH_KEY = "selection.categories.opencli_path";
const CLOUD_BASE_URL_KEY = "selection.categories.cloud_base_url";
const UPLOAD_TOKEN_KEY = "selection.categories.upload_token_ciphertext";

export interface SelectionCategoryQuery {
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

interface CategoryBatchRow {
  id: string;
  snapshot_id: string;
  collected_at_ms: number;
  source: "collector" | "cloud";
}

interface CategoryMetricRow {
  id: string;
  name: string;
  category_level_1_id: string;
  category_level_1_name: string;
  period_days: SelectionCategoryPeriod;
  gmv_minor: number;
  gmv_growth: number | null;
  ordered_units: number;
  average_price_minor: number;
  average_price_growth: number | null;
  seller_count: number | null;
  brand_count: number | null;
  cluster_count: number | null;
  buyout_rate: number | null;
  top_five_seller_share: number | null;
  category_share: number | null;
  rating: number | null;
  maximum_rating: number | null;
}

interface CategorySummaryRow {
  id: string;
  name: string;
  category_count: number;
  gmv_minor: number;
  ordered_units: number;
}

interface CategoryJobRow {
  id: string;
  status: SelectionCategorySyncView["status"];
  total_steps: number;
  completed_steps: number;
  current_category: string | null;
  staging_json: string;
  error_message: string | null;
  cloud_published: number;
  created_at_ms: number;
  finished_at_ms: number | null;
}

interface CategoryStagingData {
  metrics: SelectionCategoryCloudMetric[];
  completedKeys: string[];
}

interface CategoryModuleOptions {
  collectorFactory?: (executable: string, sessionName: string) => CategoryCollectorPort;
  cloudFactory?: (baseUrl: string) => CategoryCloudPort;
  fetchImplementation?: CategoryFetch;
}

function normalizedSearch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU");
}

function asIso(milliseconds: number | null): string | null {
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function metricHash(metrics: SelectionCategoryCloudMetric[]): string {
  const stable = [...metrics].sort((left, right) => (
    left.periodDays - right.periodDays || left.id.localeCompare(right.id)
  ));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function toMetric(row: CategoryMetricRow): SelectionCategoryPage["items"][number] {
  return {
    id: row.id,
    name: row.name,
    categoryLevel1Id: row.category_level_1_id,
    categoryLevel1Name: row.category_level_1_name,
    periodDays: row.period_days,
    gmv: { amount: minorUnitsToAmount(row.gmv_minor), currency: "RUB" },
    gmvGrowth: row.gmv_growth,
    orderedUnits: row.ordered_units,
    averagePrice: { amount: minorUnitsToAmount(row.average_price_minor), currency: "RUB" },
    averagePriceGrowth: row.average_price_growth,
    sellerCount: row.seller_count,
    brandCount: row.brand_count,
    clusterCount: row.cluster_count,
    buyoutRate: row.buyout_rate,
    topFiveSellerShare: row.top_five_seller_share,
    categoryShare: row.category_share,
    rating: row.rating,
    maximumRating: row.maximum_rating,
  };
}

/** Owns local category snapshots, low-frequency collection and cloud cache refresh. */
export class CategoryAnalysisModule {
  private readonly settings: SettingsRepository;
  private readonly options: CategoryModuleOptions;
  private activeTask: Promise<void> | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    options: CategoryModuleOptions = {},
  ) {
    this.settings = new SettingsRepository(database);
    this.options = options;
    this.database.function("unicode_search", (text: unknown, needle: unknown) => {
      return normalizedSearch(String(text ?? "")).includes(String(needle ?? "")) ? 1 : 0;
    });
  }

  /** Converts an interrupted in-process task into a resumable failed job. */
  public start(): void {
    this.database.prepare(
      `UPDATE selection_category_sync_jobs
       SET status = 'failed', error_message = ?, finished_at_ms = ?
       WHERE status = 'running'`,
    ).run("应用重启导致同步中断，可再次点击同步继续", Date.now());
  }

  public async stop(): Promise<void> {
    await this.activeTask?.catch(() => undefined);
  }

  public viewSettings(): SelectionCategorySourceSettingsView {
    const defaultPath = join(homedir(), ".npm-global", "bin", "opencli");
    return {
      collectorEnabled: this.settings.get(COLLECTOR_ENABLED_KEY) === "true",
      opencliPath: this.settings.get(OPENCLI_PATH_KEY) ?? defaultPath,
      cloudBaseUrl: this.settings.get(CLOUD_BASE_URL_KEY) ?? this.config.CATEGORY_CLOUD_BASE_URL,
      hasUploadToken: Boolean(this.settings.get(UPLOAD_TOKEN_KEY)),
    };
  }

  public updateSettings(input: SelectionCategorySourceSettingsInput): SelectionCategorySourceSettingsView {
    this.settings.set(COLLECTOR_ENABLED_KEY, String(input.collectorEnabled));
    this.settings.set(OPENCLI_PATH_KEY, input.opencliPath.trim());
    if (input.cloudBaseUrl) {
      this.settings.set(CLOUD_BASE_URL_KEY, input.cloudBaseUrl.replace(/\/$/, ""));
    } else if (input.cloudBaseUrl === null) {
      this.settings.delete(CLOUD_BASE_URL_KEY);
    }
    if (input.uploadToken) {
      this.settings.set(UPLOAD_TOKEN_KEY, encryptSecret(input.uploadToken, this.config.ENCRYPTION_KEY));
    }
    return this.viewSettings();
  }

  public getSync(): SelectionCategorySyncView {
    const row = this.database.prepare(
      "SELECT * FROM selection_category_sync_jobs ORDER BY created_at_ms DESC LIMIT 1",
    ).get() as CategoryJobRow | undefined;
    if (!row) {
      return {
        id: null, status: "idle", totalSteps: 0, completedSteps: 0, currentCategory: null,
        error: null, cloudPublished: false, startedAt: null, finishedAt: null,
      };
    }
    return this.mapJob(row);
  }

  public startSync(): SelectionCategorySyncView {
    if (this.activeTask) {
      throw new Error("类目同步正在进行中");
    }
    const settings = this.viewSettings();
    if (!settings.collectorEnabled) {
      throw new Error("当前设备是只读客户端，请先在数据源中启用主采集机");
    }
    const resume = this.latestResumableStaging();
    const id = randomUUID();
    const now = Date.now();
    this.database.prepare(
      `INSERT INTO selection_category_sync_jobs
       (id, status, total_steps, completed_steps, current_category, staging_json,
        error_message, cloud_published, created_at_ms, finished_at_ms)
       VALUES (?, 'running', 0, 0, NULL, ?, NULL, 0, ?, NULL)`,
    ).run(id, JSON.stringify(resume), now);
    this.activeTask = this.runSync(id, settings, resume).finally(() => {
      this.activeTask = null;
    });
    return this.getSync();
  }

  public async refreshCloud(): Promise<SelectionCategorySyncView> {
    const settings = this.viewSettings();
    if (!settings.cloudBaseUrl) {
      throw new Error("请先配置类目云端服务地址");
    }
    const snapshot = await this.cloud(settings.cloudBaseUrl).downloadLatest();
    this.persistSnapshot(snapshot, "cloud");
    return this.getSync();
  }

  public list(query: SelectionCategoryQuery): SelectionCategoryPage {
    const batch = this.latestBatch();
    if (!batch) {
      return { items: [], facets: { categoryLevel1: [] }, page: query.page, pageSize: query.pageSize, total: 0, snapshotId: null, collectedAt: null };
    }
    const conditions = ["m.batch_id = ?", "m.period_days = ?"];
    const parameters: Array<string | number> = [batch.id, query.periodDays];
    if (query.search) {
      conditions.push("unicode_search(c.name, ?) = 1");
      parameters.push(normalizedSearch(query.search));
    }
    if (query.categoryLevel1Id) {
      conditions.push("c.category_level_1_id = ?");
      parameters.push(query.categoryLevel1Id);
    }
    this.addRange(conditions, parameters, "m.average_price_minor", query.minimumPrice, query.maximumPrice, 100);
    this.addRange(conditions, parameters, "m.gmv_minor", query.minimumGmv, query.maximumGmv, 100);
    this.addRange(conditions, parameters, "m.gmv_growth", query.minimumGrowth, query.maximumGrowth, 0.01);
    if (query.maximumSellerCount !== undefined) {
      conditions.push("m.seller_count <= ?");
      parameters.push(query.maximumSellerCount);
    }
    if (query.minimumBuyoutRate !== undefined) {
      conditions.push("m.buyout_rate >= ?");
      parameters.push(query.minimumBuyoutRate / 100);
    }
    if (query.maximumLeaderShare !== undefined) {
      conditions.push("m.top_five_seller_share <= ?");
      parameters.push(query.maximumLeaderShare / 100);
    }
    const where = conditions.join(" AND ");
    const total = (this.database.prepare(
      `SELECT COUNT(*) AS count FROM selection_category_metrics m
       JOIN selection_categories c ON c.id = m.category_id WHERE ${where}`,
    ).get(...parameters) as { count: number }).count;
    const sortSql: Record<SelectionCategorySort, string> = {
      gmv: "m.gmv_minor DESC",
      growth: "m.gmv_growth DESC NULLS LAST",
      averagePrice: "m.average_price_minor DESC",
      competition: "m.seller_count ASC NULLS LAST",
      concentration: "m.top_five_seller_share ASC NULLS LAST",
    };
    const rows = this.database.prepare(
      `SELECT c.id, c.name, c.category_level_1_id, c.category_level_1_name,
              m.period_days, m.gmv_minor, m.gmv_growth, m.ordered_units,
              m.average_price_minor, m.average_price_growth, m.seller_count,
              m.brand_count, m.cluster_count, m.buyout_rate,
              m.top_five_seller_share, m.category_share, m.rating, m.maximum_rating
       FROM selection_category_metrics m JOIN selection_categories c ON c.id = m.category_id
       WHERE ${where} ORDER BY ${sortSql[query.sort]}, c.name ASC LIMIT ? OFFSET ?`,
    ).all(...parameters, query.pageSize, (query.page - 1) * query.pageSize) as CategoryMetricRow[];
    const facets = this.database.prepare(
      `SELECT DISTINCT c.category_level_1_id AS id, c.category_level_1_name AS name
       FROM selection_category_metrics m JOIN selection_categories c ON c.id = m.category_id
       WHERE m.batch_id = ? AND m.period_days = ? ORDER BY name`,
    ).all(batch.id, query.periodDays) as Array<{ id: string; name: string }>;
    return {
      items: rows.map(toMetric), facets: { categoryLevel1: facets }, page: query.page,
      pageSize: query.pageSize, total, snapshotId: batch.snapshot_id,
      collectedAt: new Date(batch.collected_at_ms).toISOString(),
    };
  }

  public overview(periodDays: SelectionCategoryPeriod): SelectionCategoryOverview {
    const batch = this.latestBatch();
    if (!batch) {
      return { snapshotId: null, collectedAt: null, source: null, periodDays, categoryCount: 0, totalGmv: { amount: "0.00", currency: "RUB" }, totalOrderedUnits: 0, summaries: [] };
    }
    const rows = this.database.prepare(
      `SELECT c.category_level_1_id AS id, c.category_level_1_name AS name,
              COUNT(*) AS category_count, SUM(m.gmv_minor) AS gmv_minor,
              SUM(m.ordered_units) AS ordered_units
       FROM selection_category_metrics m JOIN selection_categories c ON c.id = m.category_id
       WHERE m.batch_id = ? AND m.period_days = ?
       GROUP BY c.category_level_1_id, c.category_level_1_name ORDER BY gmv_minor DESC`,
    ).all(batch.id, periodDays) as CategorySummaryRow[];
    const totalGmvMinor = rows.reduce((sum, row) => sum + row.gmv_minor, 0);
    return {
      snapshotId: batch.snapshot_id,
      collectedAt: new Date(batch.collected_at_ms).toISOString(),
      source: batch.source,
      periodDays,
      categoryCount: rows.reduce((sum, row) => sum + row.category_count, 0),
      totalGmv: { amount: minorUnitsToAmount(totalGmvMinor), currency: "RUB" },
      totalOrderedUnits: rows.reduce((sum, row) => sum + row.ordered_units, 0),
      summaries: rows.map((row) => ({
        id: row.id, name: row.name, categoryCount: row.category_count,
        gmv: { amount: minorUnitsToAmount(row.gmv_minor), currency: "RUB" },
        orderedUnits: row.ordered_units,
      })),
    };
  }

  private async runSync(
    jobId: string,
    settings: SelectionCategorySourceSettingsView,
    staging: CategoryStagingData,
  ): Promise<void> {
    try {
      const collector = this.options.collectorFactory
        ? this.options.collectorFactory(settings.opencliPath, `ozon-category-${jobId}`)
        : new OpenCliCategoryCollector({ executable: settings.opencliPath, sessionName: `ozon-category-${jobId}` });
      const metrics = await collector.collect({
        resumeMetrics: staging.metrics,
        resumeCompletedKeys: staging.completedKeys,
        onProgress: (progress) => {
          this.database.prepare(
            `UPDATE selection_category_sync_jobs SET total_steps = ?, completed_steps = ?,
             current_category = ?, staging_json = ? WHERE id = ?`,
          ).run(progress.totalSteps, progress.completedSteps, progress.currentCategory, JSON.stringify({ metrics: progress.metrics, completedKeys: progress.completedKeys }), jobId);
        },
      });
      const snapshot = this.createSnapshot(metrics);
      this.persistSnapshot(snapshot, "collector");
      let cloudPublished = false;
      if (settings.cloudBaseUrl && settings.hasUploadToken) {
        const ciphertext = this.settings.get(UPLOAD_TOKEN_KEY)!;
        await this.cloud(settings.cloudBaseUrl).upload(snapshot, decryptSecret(ciphertext, this.config.ENCRYPTION_KEY));
        cloudPublished = true;
      }
      this.database.prepare(
        `UPDATE selection_category_sync_jobs SET status = 'completed', completed_steps = total_steps,
         current_category = NULL, error_message = NULL, cloud_published = ?, finished_at_ms = ? WHERE id = ?`,
      ).run(cloudPublished ? 1 : 0, Date.now(), jobId);
    } catch (error) {
      this.database.prepare(
        `UPDATE selection_category_sync_jobs SET status = 'failed', current_category = NULL,
         error_message = ?, finished_at_ms = ? WHERE id = ?`,
      ).run(error instanceof Error ? error.message : "类目同步失败", Date.now(), jobId);
    }
  }

  private createSnapshot(metrics: SelectionCategoryCloudMetric[]): SelectionCategoryCloudSnapshot {
    const periods = new Set(metrics.map((metric) => metric.periodDays));
    if (!periods.has(7) || !periods.has(28)) {
      throw new Error("7 天和 28 天数据未全部采集完成，未发布快照");
    }
    const collectedAt = new Date().toISOString();
    const snapshotId = createHash("sha256").update(canonicalJson({ collectedAt, periods: [7, 28], metrics })).digest("hex");
    return {
      schemaVersion: 1,
      snapshotId,
      collectedAt,
      periods: [7, 28],
      rowCount: metrics.length,
      metrics,
    };
  }

  private persistSnapshot(snapshot: SelectionCategoryCloudSnapshot, source: "collector" | "cloud"): void {
    if (snapshot.schemaVersion !== 1 || snapshot.rowCount !== snapshot.metrics.length) {
      throw new Error("类目快照结构或行数不正确");
    }
    const save = this.database.transaction(() => {
      const existing = this.database.prepare(
        "SELECT id FROM selection_category_batches WHERE snapshot_id = ?",
      ).get(snapshot.snapshotId) as { id: string } | undefined;
      if (existing) {
        return;
      }
      const batchId = randomUUID();
      const now = Date.now();
      this.database.prepare(
        `INSERT INTO selection_category_batches
         (id, snapshot_id, collected_at_ms, source, row_count, sha256, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(batchId, snapshot.snapshotId, Date.parse(snapshot.collectedAt), source, snapshot.rowCount, metricHash(snapshot.metrics), now);
      const saveCategory = this.database.prepare(
        `INSERT INTO selection_categories
         (id, name, category_level_1_id, category_level_1_name, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
           category_level_1_id = excluded.category_level_1_id,
           category_level_1_name = excluded.category_level_1_name,
           updated_at_ms = excluded.updated_at_ms`,
      );
      const saveMetric = this.database.prepare(
        `INSERT INTO selection_category_metrics
         (id, batch_id, category_id, period_days, gmv_minor, gmv_growth, ordered_units,
          average_price_minor, average_price_growth, seller_count, brand_count, cluster_count,
          buyout_rate, top_five_seller_share, category_share, rating, maximum_rating)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const metric of snapshot.metrics) {
        saveCategory.run(metric.id, metric.name, metric.categoryLevel1Id, metric.categoryLevel1Name, now);
        saveMetric.run(
          randomUUID(), batchId, metric.id, metric.periodDays, Number(metric.gmvMinor), metric.gmvGrowth,
          metric.orderedUnits, Number(metric.averagePriceMinor), metric.averagePriceGrowth,
          metric.sellerCount, metric.brandCount, metric.clusterCount, metric.buyoutRate,
          metric.topFiveSellerShare, metric.categoryShare, metric.rating, metric.maximumRating,
        );
      }
    });
    save();
  }

  private latestBatch(): CategoryBatchRow | null {
    return (this.database.prepare(
      "SELECT id, snapshot_id, collected_at_ms, source FROM selection_category_batches ORDER BY collected_at_ms DESC LIMIT 1",
    ).get() as CategoryBatchRow | undefined) ?? null;
  }

  private latestResumableStaging(): CategoryStagingData {
    const row = this.database.prepare(
      `SELECT staging_json FROM selection_category_sync_jobs
       WHERE status = 'failed' ORDER BY created_at_ms DESC LIMIT 1`,
    ).get() as { staging_json: string } | undefined;
    if (!row) {
      return { metrics: [], completedKeys: [] };
    }
    try {
      return JSON.parse(row.staging_json) as CategoryStagingData;
    } catch {
      return { metrics: [], completedKeys: [] };
    }
  }

  private cloud(baseUrl: string): CategoryCloudPort {
    if (this.options.cloudFactory) {
      return this.options.cloudFactory(baseUrl);
    }
    return new CategoryCloudClient(baseUrl, this.options.fetchImplementation);
  }

  private addRange(
    conditions: string[],
    parameters: Array<string | number>,
    column: string,
    minimum: number | undefined,
    maximum: number | undefined,
    multiplier: number,
  ): void {
    if (minimum !== undefined) {
      conditions.push(`${column} >= ?`);
      parameters.push(minimum * multiplier);
    }
    if (maximum !== undefined) {
      conditions.push(`${column} <= ?`);
      parameters.push(maximum * multiplier);
    }
  }

  private mapJob(row: CategoryJobRow): SelectionCategorySyncView {
    return {
      id: row.id,
      status: row.status,
      totalSteps: row.total_steps,
      completedSteps: row.completed_steps,
      currentCategory: row.current_category,
      error: row.error_message,
      cloudPublished: row.cloud_published === 1,
      startedAt: asIso(row.created_at_ms),
      finishedAt: asIso(row.finished_at_ms),
    };
  }
}
