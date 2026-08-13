import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type {
  SelectionCategoryCloudMetric,
  SelectionCategoryCloudSnapshot,
  SelectionCategoryLink,
  SelectionCategoryMetric,
  SelectionCategoryPeriod,
  SelectionDiscoveryProductRanking,
  SelectionDiscoveryQueryRanking,
  SelectionDiscoverySourceSettings,
  SelectionDiscoverySourceSettingsInput,
  SelectionDiscoverySyncJob,
  SelectionMarketProductRankingDetail,
  SelectionMarketProductRankingPage,
  SelectionMarketQueryDetail,
  SelectionMarketQueryPage,
  SelectionMarketQuerySort,
  SelectionMarketRankingSort,
} from "../../shared/contracts";
import { canonicalJson } from "../../shared/canonical-json";
import type { AppConfig } from "../config";
import type { AppDatabase } from "../db/database";
import { minorUnitsToAmount } from "../db/money-storage";
import { SettingsRepository } from "../db/settings-repository";
import { decryptSecret, encryptSecret } from "../security/encryption";
import { CategoryCloudClient, type CategoryCloudPort, type CategoryFetch } from "./category-cloud-client";
import { OpenCliCategoryCollector, type CategoryCollectorPort } from "./opencli-category-collector";
import {
  OpenCliDiscoveryCollector,
  type DiscoveryMarketCollectorPort,
  type DiscoveryStagePage,
} from "./opencli-discovery-collector";

const COLLECTOR_ENABLED_KEY = "selection.categories.collector_enabled";
const OPENCLI_PATH_KEY = "selection.categories.opencli_path";
const CLOUD_BASE_URL_KEY = "selection.categories.cloud_base_url";
const UPLOAD_TOKEN_KEY = "selection.categories.upload_token_ciphertext";

interface DiscoveryModuleOptions {
  categoryCollectorFactory?: (executable: string, sessionName: string) => CategoryCollectorPort;
  marketCollectorFactory?: (executable: string, sessionName: string) => DiscoveryMarketCollectorPort;
  cloudFactory?: (baseUrl: string) => CategoryCloudPort;
  fetchImplementation?: CategoryFetch;
}

interface DiscoveryJobRow {
  id: string;
  status: SelectionDiscoverySyncJob["status"];
  stage: SelectionDiscoverySyncJob["stage"];
  total_steps: number;
  completed_steps: number;
  current_item: string | null;
  stage_progress_json: string;
  error_message: string | null;
  cloud_published: number;
  created_at_ms: number;
  finished_at_ms: number | null;
}

interface StagePageRow {
  page_key: string;
  stage: DiscoveryStagePage["stage"] | "categories";
  payload_json: string;
}

interface DiscoveryBatchRow {
  id: string;
  snapshot_id: string;
  collected_at_ms: number;
}

export interface ProductRankingQuery {
  page: number;
  pageSize: number;
  periodDays: SelectionCategoryPeriod;
  sort: SelectionMarketRankingSort;
  search?: string | undefined;
  categoryId?: string | undefined;
  minimumPrice?: number | undefined;
  maximumPrice?: number | undefined;
}

export interface MarketQueryQuery {
  page: number;
  pageSize: number;
  sort: SelectionMarketQuerySort;
  search?: string | undefined;
  groupName?: string | undefined;
  categoryId?: string | undefined;
  minimumSearchCount?: number | undefined;
  minimumCartRate?: number | undefined;
  minimumOrderRate?: number | undefined;
  maximumCompetition?: number | undefined;
}

function iso(milliseconds: number | null): string | null {
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
}

function parseProgress(value: string): SelectionDiscoverySyncJob["stageProgress"] {
  try {
    const parsed = JSON.parse(value) as SelectionDiscoverySyncJob["stageProgress"];
    return {
      categories: parsed.categories ?? { completed: 0, total: 0 },
      products: parsed.products ?? { completed: 0, total: 0 },
      queries: parsed.queries ?? { completed: 0, total: 0 },
    };
  } catch {
    return { categories: { completed: 0, total: 0 }, products: { completed: 0, total: 0 }, queries: { completed: 0, total: 0 } };
  }
}

function categoryMetricForCollector(metric: SelectionCategoryCloudMetric): SelectionCategoryMetric {
  return {
    id: metric.id,
    name: metric.name,
    categoryLevel1Id: metric.categoryLevel1Id,
    categoryLevel1Name: metric.categoryLevel1Name,
    periodDays: metric.periodDays,
    gmv: { amount: minorUnitsToAmount(Number(metric.gmvMinor)), currency: "RUB" },
    gmvGrowth: metric.gmvGrowth,
    orderedUnits: metric.orderedUnits,
    averagePrice: { amount: minorUnitsToAmount(Number(metric.averagePriceMinor)), currency: "RUB" },
    averagePriceGrowth: metric.averagePriceGrowth,
    sellerCount: metric.sellerCount,
    brandCount: metric.brandCount,
    clusterCount: metric.clusterCount,
    buyoutRate: metric.buyoutRate,
    topFiveSellerShare: metric.topFiveSellerShare,
    categoryShare: metric.categoryShare,
    rating: metric.rating,
    maximumRating: metric.maximumRating,
  };
}

/** Owns the unified categories, bestseller and market-query synchronization boundary. */
export class DiscoveryModule {
  private readonly settings: SettingsRepository;
  private activeTask: Promise<void> | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly options: DiscoveryModuleOptions = {},
  ) {
    this.settings = new SettingsRepository(database);
    this.database.function("discovery_search", (text: unknown, needle: unknown) => (
      normalizeSearch(String(text ?? "")).includes(String(needle ?? "")) ? 1 : 0
    ));
  }

  /** Marks an interrupted task resumable after an application restart. */
  public start(): void {
    this.database.prepare(
      `UPDATE selection_discovery_jobs SET status = 'failed', error_message = ?, finished_at_ms = ?
       WHERE status = 'running'`,
    ).run("应用重启导致同步中断，已保留分页进度", Date.now());
  }

  public async stop(): Promise<void> {
    await this.activeTask?.catch(() => undefined);
  }

  public viewSettings(): SelectionDiscoverySourceSettings {
    return {
      collectorEnabled: this.settings.get(COLLECTOR_ENABLED_KEY) === "true",
      opencliPath: this.settings.get(OPENCLI_PATH_KEY) ?? join(homedir(), ".npm-global", "bin", "opencli"),
      cloudBaseUrl: this.settings.get(CLOUD_BASE_URL_KEY) ?? this.config.CATEGORY_CLOUD_BASE_URL,
      hasUploadToken: Boolean(this.settings.get(UPLOAD_TOKEN_KEY)),
      estimatedDurationMinutes: [8, 15],
    };
  }

  public updateSettings(input: SelectionDiscoverySourceSettingsInput): SelectionDiscoverySourceSettings {
    this.settings.set(COLLECTOR_ENABLED_KEY, String(input.collectorEnabled));
    this.settings.set(OPENCLI_PATH_KEY, input.opencliPath.trim());
    if (input.cloudBaseUrl) this.settings.set(CLOUD_BASE_URL_KEY, input.cloudBaseUrl.replace(/\/$/, ""));
    else if (input.cloudBaseUrl === null) this.settings.delete(CLOUD_BASE_URL_KEY);
    if (input.uploadToken) this.settings.set(UPLOAD_TOKEN_KEY, encryptSecret(input.uploadToken, this.config.ENCRYPTION_KEY));
    return this.viewSettings();
  }

  public getSync(): SelectionDiscoverySyncJob {
    const row = this.database.prepare(
      "SELECT * FROM selection_discovery_jobs ORDER BY created_at_ms DESC LIMIT 1",
    ).get() as DiscoveryJobRow | undefined;
    if (!row) {
      return {
        id: null, status: "idle", stage: null, totalSteps: 0, completedSteps: 0, currentItem: null,
        stageProgress: { categories: { completed: 0, total: 0 }, products: { completed: 0, total: 0 }, queries: { completed: 0, total: 0 } },
        error: null, cloudPublished: false, resumable: false, startedAt: null, finishedAt: null,
      };
    }
    return {
      id: row.id,
      status: row.status,
      stage: row.stage,
      totalSteps: row.total_steps,
      completedSteps: row.completed_steps,
      currentItem: row.current_item,
      stageProgress: parseProgress(row.stage_progress_json),
      error: row.error_message,
      cloudPublished: row.cloud_published === 1,
      resumable: row.status === "failed" && this.stagePageCount(row.id) > 0,
      startedAt: iso(row.created_at_ms),
      finishedAt: iso(row.finished_at_ms),
    };
  }

  public startSync(): SelectionDiscoverySyncJob {
    if (this.activeTask) throw new Error("Ozon 市场数据同步正在进行中");
    const settings = this.viewSettings();
    if (!settings.collectorEnabled) throw new Error("当前设备是只读客户端，请在主采集机发起同步");
    const previous = this.latestResumableJob();
    const jobId = randomUUID();
    this.database.prepare(
      `INSERT INTO selection_discovery_jobs
       (id, status, stage, total_steps, completed_steps, current_item, stage_progress_json,
        error_message, cloud_published, created_at_ms, finished_at_ms)
       VALUES (?, 'running', 'categories', 0, 0, NULL, '{}', NULL, 0, ?, NULL)`,
    ).run(jobId, Date.now());
    if (previous) {
      this.database.prepare(
        `INSERT INTO selection_discovery_stage_pages (job_id, page_key, stage, payload_json, created_at_ms)
         SELECT ?, page_key, stage, payload_json, created_at_ms
         FROM selection_discovery_stage_pages WHERE job_id = ?`,
      ).run(jobId, previous.id);
    }
    this.activeTask = this.runSync(jobId, settings).finally(() => { this.activeTask = null; });
    return this.getSync();
  }

  public async refreshCloud(): Promise<SelectionDiscoverySyncJob> {
    const settings = this.viewSettings();
    if (!settings.cloudBaseUrl) throw new Error("请先配置市场数据云端服务地址");
    const snapshot = await this.cloud(settings.cloudBaseUrl).downloadLatest();
    this.persistSnapshot(snapshot, "cloud");
    return this.getSync();
  }

  public listProducts(query: ProductRankingQuery): SelectionMarketProductRankingPage {
    const batch = this.latestBatch();
    const scope = query.categoryId ? "category" : "global";
    if (!batch) return { items: [], facets: { categoryLevel1: [], categoryLevel3: [], productFlags: [] }, page: query.page, pageSize: query.pageSize, total: 0, periodDays: query.periodDays, scope, categoryId: query.categoryId ?? null, snapshotId: null, collectedAt: null };
    const conditions = ["r.batch_id = ?", "r.period_days = ?", "r.scope = ?"];
    const categoryLocalizationJoin = `LEFT JOIN selection_category_product_types type_map
      ON type_map.batch_id = r.batch_id AND type_map.product_type_id = r.category_level_3_id
      LEFT JOIN selection_categories c ON c.id = type_map.category_id`;
    const parameters: Array<string | number> = [batch.id, query.periodDays, scope];
    if (query.categoryId) { conditions.push("r.scope_category_id = ?"); parameters.push(query.categoryId); }
    if (query.search) {
      conditions.push("discovery_search(p.name || ' ' || p.brand || ' ' || p.seller || ' ' || p.category_level_1 || ' ' || p.category_level_3 || ' ' || COALESCE(c.name, '') || ' ' || COALESCE(c.category_level_1_name, ''), ?) = 1");
      parameters.push(normalizeSearch(query.search));
    }
    if (query.minimumPrice !== undefined) { conditions.push("r.average_price_minor >= ?"); parameters.push(query.minimumPrice * 100); }
    if (query.maximumPrice !== undefined) { conditions.push("r.average_price_minor <= ?"); parameters.push(query.maximumPrice * 100); }
    const where = conditions.join(" AND ");
    const total = (this.database.prepare(
      `SELECT COUNT(*) AS count FROM selection_market_product_rankings r
       JOIN selection_market_products p ON p.id = r.product_id
       ${categoryLocalizationJoin} WHERE ${where}`,
    ).get(...parameters) as { count: number }).count;
    const sortSql: Record<SelectionMarketRankingSort, string> = {
      orderedAmount: "r.ordered_amount_minor DESC", orderedUnits: "r.ordered_units DESC",
      turnoverGrowth: "r.turnover_growth DESC NULLS LAST", missedSales: "r.missed_sales_minor DESC",
      conversionRate: "r.impression_to_order_rate DESC", averagePrice: "r.average_price_minor DESC",
    };
    const rows = this.database.prepare(
      `SELECT r.*, p.id AS product_id, p.ozon_product_id, p.name, p.ozon_url, p.seller, p.brand,
              p.category_level_1, p.category_level_3, p.product_flags,
              c.name AS localized_category_level_3, c.category_level_1_name AS localized_category_level_1
       FROM selection_market_product_rankings r JOIN selection_market_products p ON p.id = r.product_id
       ${categoryLocalizationJoin}
       WHERE ${where} ORDER BY ${sortSql[query.sort]}, r.rank ASC LIMIT ? OFFSET ?`,
    ).all(...parameters, query.pageSize, (query.page - 1) * query.pageSize) as Array<Record<string, unknown>>;
    const facetRows = this.database.prepare(
      `SELECT DISTINCT COALESCE(c.category_level_1_name, p.category_level_1) AS category_level_1,
              COALESCE(c.name, p.category_level_3) AS category_level_3
       FROM selection_market_product_rankings r
       JOIN selection_market_products p ON p.id = r.product_id
       ${categoryLocalizationJoin}
       WHERE r.batch_id = ? AND r.period_days = ? AND r.scope = ?`,
    ).all(batch.id, query.periodDays, scope) as Array<{ category_level_1: string; category_level_3: string }>;
    return {
      items: rows.map((row) => this.mapProduct(row)),
      facets: {
        categoryLevel1: [...new Set(facetRows.map((row) => row.category_level_1))].filter(Boolean).sort(),
        categoryLevel3: [...new Set(facetRows.map((row) => row.category_level_3))].filter(Boolean).sort(),
        productFlags: [],
      },
      page: query.page, pageSize: query.pageSize, total, periodDays: query.periodDays, scope,
      categoryId: query.categoryId ?? null, snapshotId: batch.snapshot_id,
      collectedAt: new Date(batch.collected_at_ms).toISOString(),
    };
  }

  public getProduct(id: string): SelectionMarketProductRankingDetail | null {
    const batch = this.latestBatch();
    if (!batch) return null;
    const row = this.database.prepare(
      `SELECT r.*, p.id AS product_id, p.ozon_product_id, p.name, p.ozon_url, p.seller, p.brand,
              p.category_level_1, p.category_level_3, p.product_flags,
              c.name AS localized_category_level_3, c.category_level_1_name AS localized_category_level_1
       FROM selection_market_product_rankings r JOIN selection_market_products p ON p.id = r.product_id
       LEFT JOIN selection_category_product_types type_map
         ON type_map.batch_id = r.batch_id AND type_map.product_type_id = r.category_level_3_id
       LEFT JOIN selection_categories c ON c.id = type_map.category_id
       WHERE r.batch_id = ? AND p.id = ? ORDER BY r.period_days DESC, r.scope = 'global' DESC LIMIT 1`,
    ).get(batch.id, id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const item = this.mapProduct(row);
    return {
      ...item,
      minimumPrice: { amount: minorUnitsToAmount(Number(row.minimum_price_minor)), currency: "RUB" },
      purchaseRate: row.purchase_rate as number | null,
      stock: row.stock as number | null,
      fboStock: row.fbo_stock as number | null,
      fbsStock: row.fbs_stock as number | null,
      fulfillmentScheme: String(row.fulfillment_scheme),
      volumeLiters: row.volume_liters as number | null,
      impressions: Number(row.impressions), searchViews: Number(row.search_views), cardViews: Number(row.card_views),
      searchToCartRate: Number(row.search_to_cart_rate), cardToCartRate: Number(row.card_to_cart_rate),
      promotionDiscountRate: Number(row.promotion_discount_rate), promotedOrderShare: Number(row.promoted_order_share),
      promotionDays: Number(row.promotion_days), advertisedDays: Number(row.advertised_days),
      advertisingCostShare: Number(row.advertising_cost_share), productCardCreatedDate: row.product_card_created_date as string | null,
    };
  }

  public listQueries(query: MarketQueryQuery): SelectionMarketQueryPage {
    const batch = this.latestBatch();
    const categoryLink = query.categoryId && batch ? this.categoryLink(batch.id, query.categoryId) : null;
    const scope = query.categoryId || query.groupName ? "group" : "global";
    if (!batch) return { items: [], groups: [], page: query.page, pageSize: query.pageSize, total: 0, periodDays: 7, scope, categoryId: query.categoryId ?? null, categoryLink: null, snapshotId: null, collectedAt: null };
    const conditions = ["r.batch_id = ?", "r.scope = ?"];
    const parameters: Array<string | number> = [batch.id, scope];
    if (query.categoryId) {
      const groups = categoryLink?.queryGroups ?? [];
      if (groups.length === 0) conditions.push("1 = 0");
      else { conditions.push(`r.group_name IN (${groups.map(() => "?").join(",")})`); parameters.push(...groups); }
    } else if (query.groupName) { conditions.push("r.group_name = ?"); parameters.push(query.groupName); }
    if (query.search) { conditions.push("discovery_search(k.phrase, ?) = 1"); parameters.push(normalizeSearch(query.search)); }
    if (query.minimumSearchCount !== undefined) { conditions.push("r.search_count >= ?"); parameters.push(query.minimumSearchCount); }
    if (query.minimumCartRate !== undefined) { conditions.push("r.cart_rate >= ?"); parameters.push(query.minimumCartRate / 100); }
    if (query.minimumOrderRate !== undefined) { conditions.push("r.order_rate >= ?"); parameters.push(query.minimumOrderRate / 100); }
    if (query.maximumCompetition !== undefined) { conditions.push("r.competing_sellers <= ?"); parameters.push(query.maximumCompetition); }
    const where = conditions.join(" AND ");
    const total = (this.database.prepare(
      `SELECT COUNT(*) AS count FROM selection_market_query_rankings r JOIN selection_keywords k ON k.id = r.keyword_id WHERE ${where}`,
    ).get(...parameters) as { count: number }).count;
    const sortSql: Record<SelectionMarketQuerySort, string> = {
      searchCount: "r.search_count DESC", cartRate: "r.cart_rate DESC", orderedUnits: "r.ordered_units DESC",
      orderRate: "r.order_rate DESC", orderedAmount: "r.ordered_amount_minor DESC", competition: "r.competing_sellers ASC",
    };
    const rows = this.database.prepare(
      `SELECT r.*, k.id AS keyword_id, k.phrase,
        CASE WHEN EXISTS (SELECT 1 FROM selection_wordstat_job_items ji WHERE ji.keyword_id = k.id AND ji.status IN ('queued','running')) THEN 'queued'
             WHEN EXISTS (SELECT 1 FROM selection_wordstat_snapshots ws WHERE ws.keyword_id = k.id) THEN 'ready'
             WHEN EXISTS (SELECT 1 FROM selection_wordstat_job_items ji WHERE ji.keyword_id = k.id AND ji.status = 'failed') THEN 'failed'
             ELSE 'missing' END AS wordstat_status
       FROM selection_market_query_rankings r JOIN selection_keywords k ON k.id = r.keyword_id
       WHERE ${where} ORDER BY ${sortSql[query.sort]}, r.rank ASC LIMIT ? OFFSET ?`,
    ).all(...parameters, query.pageSize, (query.page - 1) * query.pageSize) as Array<Record<string, unknown>>;
    const groups = (this.database.prepare(
      "SELECT DISTINCT group_name FROM selection_market_query_rankings WHERE batch_id = ? AND group_name IS NOT NULL ORDER BY group_name",
    ).all(batch.id) as Array<{ group_name: string }>).map((row) => row.group_name);
    return {
      items: rows.map((row) => this.mapQuery(row)), groups, page: query.page, pageSize: query.pageSize,
      total, periodDays: 7, scope, categoryId: query.categoryId ?? null, categoryLink,
      snapshotId: batch.snapshot_id, collectedAt: new Date(batch.collected_at_ms).toISOString(),
    };
  }

  public getQuery(id: string): SelectionMarketQueryDetail | null {
    const batch = this.latestBatch();
    if (!batch) return null;
    const row = this.database.prepare(
      `SELECT r.*, k.id AS keyword_id, k.phrase,
       CASE WHEN EXISTS (SELECT 1 FROM selection_wordstat_snapshots ws WHERE ws.keyword_id = k.id) THEN 'ready' ELSE 'missing' END AS wordstat_status
       FROM selection_market_query_rankings r JOIN selection_keywords k ON k.id = r.keyword_id
       WHERE r.batch_id = ? AND k.id = ? ORDER BY r.scope = 'global' DESC, r.rank ASC LIMIT 1`,
    ).get(batch.id, id) as Record<string, unknown> | undefined;
    return row ? { ...this.mapQuery(row), wordstat: null } : null;
  }

  private async runSync(jobId: string, settings: SelectionDiscoverySourceSettings): Promise<void> {
    try {
      const resumePages = this.loadStagePages(jobId);
      const categoryMetrics = [...resumePages.entries()].filter(([key]) => key.startsWith("categories:")).flatMap(([, value]) => value as SelectionCategoryCloudMetric[]);
      const completedCategoryKeys = [...resumePages.keys()].filter((key) => key.startsWith("categories:")).map((key) => key.slice("categories:".length));
      const categoryCollector = this.options.categoryCollectorFactory
        ? this.options.categoryCollectorFactory(settings.opencliPath, `ozon-discovery-categories-${jobId}`)
        : new OpenCliCategoryCollector({ executable: settings.opencliPath, sessionName: `ozon-discovery-categories-${jobId}` });
      const metrics = await categoryCollector.collect({
        resumeMetrics: categoryMetrics,
        resumeCompletedKeys: completedCategoryKeys,
        onProgress: (progress) => {
          const stepKey = progress.completedKeys.at(-1)!;
          const [period, level1Id] = stepKey.split(":");
          const payload = progress.metrics.filter((metric) => String(metric.periodDays) === period && metric.categoryLevel1Id === level1Id);
          this.saveStagePage(jobId, `categories:${stepKey}`, "categories", payload);
          const stageProgress = parseProgress((this.jobRow(jobId)?.stage_progress_json) ?? "{}");
          stageProgress.categories = { completed: progress.completedSteps, total: progress.totalSteps };
          this.updateJob(jobId, "categories", progress.currentCategory, stageProgress);
        },
      });
      const refreshedPages = this.loadStagePages(jobId);
      const marketPages = new Map(
        [...refreshedPages].filter(([key]) => !key.startsWith("categories:")),
      ) as Map<string, DiscoveryStagePage["payload"]>;
      const marketCollector = this.options.marketCollectorFactory
        ? this.options.marketCollectorFactory(settings.opencliPath, `ozon-discovery-market-${jobId}`)
        : new OpenCliDiscoveryCollector({ executable: settings.opencliPath, sessionName: `ozon-discovery-market-${jobId}` });
      const market = await marketCollector.collect({
        categories: metrics.map(categoryMetricForCollector),
        resumePages: marketPages,
        onPage: (page, completed, total) => {
          this.saveStagePage(jobId, page.pageKey, page.stage, page.payload);
          const stageProgress = parseProgress((this.jobRow(jobId)?.stage_progress_json) ?? "{}");
          const links = (marketPages.get("links:all") ?? []) as SelectionCategoryLink[];
          const groupCount = new Set(links.flatMap((link) => link.queryGroups)).size;
          const productTotal = Math.max(0, total - 200 - groupCount - 1);
          if (page.stage === "products") stageProgress.products = { completed: [...marketPages.keys()].filter((key) => key.startsWith("products:")).length, total: Math.max(productTotal, 1) };
          if (page.stage === "queries") stageProgress.queries = { completed: [...marketPages.keys()].filter((key) => key.startsWith("queries:")).length, total: 200 + groupCount };
          this.updateJob(jobId, page.stage === "queries" ? "queries" : "products", page.currentItem, stageProgress, total, completed + stageProgress.categories.completed);
        },
      });
      this.database.prepare("UPDATE selection_discovery_jobs SET stage = 'publishing', current_item = ? WHERE id = ?").run("校验并发布完整快照", jobId);
      const snapshot = this.createSnapshot(metrics, market.products, market.queries, market.links);
      this.persistSnapshot(snapshot, "collector");
      let cloudPublished = false;
      if (settings.cloudBaseUrl && settings.hasUploadToken) {
        const ciphertext = this.settings.get(UPLOAD_TOKEN_KEY)!;
        await this.cloud(settings.cloudBaseUrl).upload(snapshot, decryptSecret(ciphertext, this.config.ENCRYPTION_KEY));
        cloudPublished = true;
      }
      this.database.prepare(
        `UPDATE selection_discovery_jobs SET status = 'completed', stage = 'publishing', completed_steps = total_steps,
         current_item = NULL, error_message = NULL, cloud_published = ?, finished_at_ms = ? WHERE id = ?`,
      ).run(cloudPublished ? 1 : 0, Date.now(), jobId);
    } catch (error) {
      this.database.prepare(
        `UPDATE selection_discovery_jobs SET status = 'failed', error_message = ?, current_item = NULL, finished_at_ms = ? WHERE id = ?`,
      ).run(error instanceof Error ? error.message : "Ozon 市场数据同步失败", Date.now(), jobId);
    }
  }

  private createSnapshot(
    metrics: SelectionCategoryCloudMetric[],
    products: SelectionDiscoveryProductRanking[],
    queries: SelectionDiscoveryQueryRanking[],
    categoryLinks: SelectionCategoryLink[],
  ): SelectionCategoryCloudSnapshot {
    const periods = new Set(metrics.map((metric) => metric.periodDays));
    if (!periods.has(7) || !periods.has(28) || products.length === 0 || queries.length === 0 || categoryLinks.length === 0) {
      throw new Error("类目、商品或热词数据不完整，未覆盖上一份有效快照");
    }
    const collectedAt = new Date().toISOString();
    const content = { collectedAt, periods: [7, 28] as const, metrics, products, queries, categoryLinks };
    const snapshotId = createHash("sha256").update(canonicalJson(content)).digest("hex");
    return {
      schemaVersion: 1, snapshotId, collectedAt, periods: [7, 28], rowCount: metrics.length, metrics,
      products, queries, categoryLinks,
      discoveryCounts: { categoryMetrics: metrics.length, productRankings: products.length, queryRankings: queries.length, categoryLinks: categoryLinks.length },
    };
  }

  private persistSnapshot(snapshot: SelectionCategoryCloudSnapshot, source: "collector" | "cloud"): void {
    if (snapshot.schemaVersion !== 1 || snapshot.rowCount !== snapshot.metrics.length) throw new Error("市场快照结构或类目行数不正确");
    const products = snapshot.products ?? [];
    const queries = snapshot.queries ?? [];
    const links = snapshot.categoryLinks ?? [];
    const save = this.database.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM selection_discovery_batches WHERE snapshot_id = ?").get(snapshot.snapshotId)) return;
      let categoryBatch = this.database.prepare("SELECT id FROM selection_category_batches WHERE snapshot_id = ?").get(snapshot.snapshotId) as { id: string } | undefined;
      if (!categoryBatch) {
        const categoryBatchId = randomUUID();
        this.database.prepare(
          `INSERT INTO selection_category_batches (id, snapshot_id, collected_at_ms, source, row_count, sha256, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(categoryBatchId, snapshot.snapshotId, Date.parse(snapshot.collectedAt), source, snapshot.rowCount, createHash("sha256").update(canonicalJson(snapshot.metrics)).digest("hex"), Date.now());
        const categoryStatement = this.database.prepare(
          `INSERT INTO selection_categories (id, name, category_level_1_id, category_level_1_name, updated_at_ms)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name,
             category_level_1_id = excluded.category_level_1_id, category_level_1_name = excluded.category_level_1_name,
             updated_at_ms = excluded.updated_at_ms`,
        );
        const metricStatement = this.database.prepare(
          `INSERT INTO selection_category_metrics
           (id, batch_id, category_id, period_days, gmv_minor, gmv_growth, ordered_units, average_price_minor,
            average_price_growth, seller_count, brand_count, cluster_count, buyout_rate, top_five_seller_share,
            category_share, rating, maximum_rating) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const metric of snapshot.metrics) {
          categoryStatement.run(metric.id, metric.name, metric.categoryLevel1Id, metric.categoryLevel1Name, Date.now());
          metricStatement.run(randomUUID(), categoryBatchId, metric.id, metric.periodDays, Number(metric.gmvMinor), metric.gmvGrowth, metric.orderedUnits, Number(metric.averagePriceMinor), metric.averagePriceGrowth, metric.sellerCount, metric.brandCount, metric.clusterCount, metric.buyoutRate, metric.topFiveSellerShare, metric.categoryShare, metric.rating, metric.maximumRating);
        }
        categoryBatch = { id: categoryBatchId };
      }
      const batchId = randomUUID();
      this.database.prepare(
        `INSERT INTO selection_discovery_batches
         (id, snapshot_id, collected_at_ms, source, category_batch_id, product_ranking_count, query_ranking_count, category_link_count, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(batchId, snapshot.snapshotId, Date.parse(snapshot.collectedAt), source, categoryBatch.id, products.length, queries.length, links.length, Date.now());
      this.persistProducts(batchId, products);
      this.persistQueries(batchId, queries);
      const statement = this.database.prepare(
        `INSERT INTO selection_category_links (batch_id, category_id, product_type_ids_json, query_groups_json, query_scope)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const productTypeStatement = this.database.prepare(
        `INSERT OR IGNORE INTO selection_category_product_types (batch_id, product_type_id, category_id)
         VALUES (?, ?, ?)`,
      );
      links.forEach((link) => {
        statement.run(batchId, link.categoryId, JSON.stringify(link.productTypeIds), JSON.stringify(link.queryGroups), link.queryScope);
        link.productTypeIds.forEach((productTypeId) => productTypeStatement.run(batchId, productTypeId, link.categoryId));
      });
    });
    save();
  }

  private persistProducts(batchId: string, products: SelectionDiscoveryProductRanking[]): void {
    const find = this.database.prepare("SELECT id FROM selection_market_products WHERE ozon_product_id = ?");
    const upsert = this.database.prepare(
      `INSERT INTO selection_market_products
       (id, ozon_product_id, name, ozon_url, seller, brand, category_level_1, category_level_3, product_flags, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
       ON CONFLICT(ozon_product_id) DO UPDATE SET name = excluded.name, ozon_url = excluded.ozon_url,
         seller = excluded.seller, brand = excluded.brand, category_level_1 = excluded.category_level_1,
         category_level_3 = excluded.category_level_3, updated_at_ms = excluded.updated_at_ms`,
    );
    const ranking = this.database.prepare(
      `INSERT INTO selection_market_product_rankings
       (id, batch_id, product_id, scope, scope_category_id, period_days, rank, photo_url,
        category_level_1_id, category_level_3_id, seller_id, brand_id, ordered_amount_minor, ordered_units,
        turnover_growth, average_price_minor, minimum_price_minor, purchase_rate, missed_sales_minor,
        out_of_stock_days, stock, fbo_stock, fbs_stock, fulfillment_scheme, volume_liters, impressions,
        search_views, card_views, impression_to_order_rate, search_to_cart_rate, card_to_cart_rate,
        promotion_discount_rate, promoted_order_share, promotion_days, advertised_days,
        advertising_cost_share, product_card_created_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of products) {
      const existing = find.get(item.ozonProductId) as { id: string } | undefined;
      const productId = existing?.id ?? randomUUID();
      const now = Date.now();
      upsert.run(productId, item.ozonProductId, item.name, item.ozonUrl, item.seller, item.brand, item.categoryLevel1, item.categoryLevel3, now, now);
      ranking.run(randomUUID(), batchId, productId, item.scope, item.scopeCategoryId, item.periodDays, item.rank, item.photoUrl, item.categoryLevel1Id, item.categoryLevel3Id, item.sellerId, item.brandId, Number(item.orderedAmountMinor), item.orderedUnits, item.turnoverGrowth, Number(item.averagePriceMinor), Number(item.minimumPriceMinor), item.purchaseRate, Number(item.missedSalesMinor), item.outOfStockDays, item.stock, item.fboStock, item.fbsStock, item.fulfillmentScheme, item.volumeLiters, item.impressions, item.searchViews, item.cardViews, item.impressionToOrderRate, item.searchToCartRate, item.cardToCartRate, item.promotionDiscountRate, item.promotedOrderShare, item.promotionDays, item.advertisedDays, item.advertisingCostShare, item.productCardCreatedDate);
    }
  }

  private persistQueries(batchId: string, queries: SelectionDiscoveryQueryRanking[]): void {
    const find = this.database.prepare("SELECT id FROM selection_keywords WHERE normalized_phrase = ?");
    const insert = this.database.prepare(
      "INSERT INTO selection_keywords (id, phrase, normalized_phrase, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)",
    );
    const ranking = this.database.prepare(
      `INSERT INTO selection_market_query_rankings
       (id, batch_id, keyword_id, scope, group_name, period_days, rank, search_count, searches_with_cart,
        cart_rate, ordered_units, order_rate, ordered_amount_minor, average_price_minor, product_views,
        competing_sellers, no_interaction_count, no_interaction_rate, no_result_count, no_result_rate,
        average_product_count) VALUES (?, ?, ?, ?, ?, 7, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of queries) {
      const existing = find.get(item.normalizedPhrase) as { id: string } | undefined;
      const keywordId = existing?.id ?? randomUUID();
      if (!existing) insert.run(keywordId, item.phrase, item.normalizedPhrase, Date.now(), Date.now());
      ranking.run(randomUUID(), batchId, keywordId, item.scope, item.groupName, item.rank, item.searchCount, item.searchesWithCart, item.cartRate, item.orderedUnits, item.orderRate, Number(item.orderedAmountMinor), Number(item.averagePriceMinor), item.productViews, item.competingSellers, item.noInteractionCount, item.noInteractionRate, item.noResultCount, item.noResultRate, item.averageProductCount);
    }
  }

  private mapProduct(row: Record<string, unknown>): SelectionMarketProductRankingPage["items"][number] {
    const collectedAt = this.latestBatch()?.collected_at_ms ?? Date.now();
    const reportedCategoryLevel3 = String(row.category_level_3);
    const localizedCategoryLevel3 = String(row.localized_category_level_3 ?? reportedCategoryLevel3);
    return {
      id: String(row.product_id), ozonProductId: String(row.ozon_product_id), name: String(row.name),
      ozonUrl: String(row.ozon_url), photoUrl: row.photo_url as string | null, seller: String(row.seller), brand: String(row.brand),
      categoryLevel1: String(row.localized_category_level_1 ?? row.category_level_1),
      // 新快照优先保留 Ozon 返回的精确中文商品类型；旧快照回退到中文类目映射。
      categoryLevel3: /\p{Script=Han}/u.test(reportedCategoryLevel3) ? reportedCategoryLevel3 : localizedCategoryLevel3,
      productFlags: [],
      snapshotDate: new Date(collectedAt).toISOString().slice(0, 10), reportPeriodDays: Number(row.period_days),
      orderedAmount: { amount: minorUnitsToAmount(Number(row.ordered_amount_minor)), currency: "RUB" },
      turnoverGrowth: row.turnover_growth as number | null, orderedUnits: Number(row.ordered_units),
      averagePrice: { amount: minorUnitsToAmount(Number(row.average_price_minor)), currency: "RUB" },
      impressionToOrderRate: Number(row.impression_to_order_rate), missedSales: Number(row.missed_sales_minor) / 100,
      outOfStockDays: row.out_of_stock_days as number | null, rank: Number(row.rank), scope: row.scope as "global" | "category",
      scopeCategoryId: row.scope_category_id as string | null, stock: row.stock as number | null,
    };
  }

  private mapQuery(row: Record<string, unknown>): SelectionMarketQueryPage["items"][number] {
    return {
      id: String(row.keyword_id), phrase: String(row.phrase), rank: Number(row.rank), scope: row.scope as "global" | "group",
      groupName: row.group_name as string | null, searchCount: Number(row.search_count), searchesWithCart: Number(row.searches_with_cart),
      cartRate: Number(row.cart_rate), orderedUnits: Number(row.ordered_units), orderRate: Number(row.order_rate),
      orderedAmount: { amount: minorUnitsToAmount(Number(row.ordered_amount_minor)), currency: "RUB" },
      averagePrice: { amount: minorUnitsToAmount(Number(row.average_price_minor)), currency: "RUB" },
      productViews: Number(row.product_views), competingSellers: Number(row.competing_sellers),
      noInteractionCount: Number(row.no_interaction_count), noInteractionRate: Number(row.no_interaction_rate),
      noResultCount: Number(row.no_result_count), noResultRate: Number(row.no_result_rate),
      averageProductCount: Number(row.average_product_count),
      wordstatStatus: row.wordstat_status as SelectionMarketQueryPage["items"][number]["wordstatStatus"],
    };
  }

  private categoryLink(batchId: string, categoryId: string): SelectionCategoryLink | null {
    const row = this.database.prepare(
      `SELECT l.*, c.name, c.category_level_1_id, c.category_level_1_name
       FROM selection_category_links l JOIN selection_categories c ON c.id = l.category_id
       WHERE l.batch_id = ? AND l.category_id = ?`,
    ).get(batchId, categoryId) as Record<string, unknown> | undefined;
    return row ? {
      categoryId, categoryName: String(row.name), categoryLevel1Id: String(row.category_level_1_id),
      categoryLevel1Name: String(row.category_level_1_name), productTypeIds: JSON.parse(String(row.product_type_ids_json)) as string[],
      queryGroups: JSON.parse(String(row.query_groups_json)) as string[], queryScope: row.query_scope as SelectionCategoryLink["queryScope"],
    } : null;
  }

  private saveStagePage(jobId: string, pageKey: string, stage: StagePageRow["stage"], payload: unknown): void {
    this.database.prepare(
      `INSERT INTO selection_discovery_stage_pages (job_id, page_key, stage, payload_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id, page_key) DO NOTHING`,
    ).run(jobId, pageKey, stage, JSON.stringify(payload), Date.now());
  }

  private loadStagePages(jobId: string): Map<string, DiscoveryStagePage["payload"] | SelectionCategoryCloudMetric[]> {
    const rows = this.database.prepare(
      "SELECT page_key, stage, payload_json FROM selection_discovery_stage_pages WHERE job_id = ? ORDER BY created_at_ms",
    ).all(jobId) as StagePageRow[];
    return new Map(rows.map((row) => [row.page_key, JSON.parse(row.payload_json) as DiscoveryStagePage["payload"] | SelectionCategoryCloudMetric[]]));
  }

  private updateJob(
    jobId: string,
    stage: SelectionDiscoverySyncJob["stage"],
    currentItem: string,
    progress: SelectionDiscoverySyncJob["stageProgress"],
    marketTotal = 0,
    completed = 0,
  ): void {
    const total = progress.categories.total + marketTotal;
    const done = completed || progress.categories.completed + progress.products.completed + progress.queries.completed;
    this.database.prepare(
      `UPDATE selection_discovery_jobs SET stage = ?, current_item = ?, total_steps = ?, completed_steps = ?, stage_progress_json = ? WHERE id = ?`,
    ).run(stage, currentItem, total, done, JSON.stringify(progress), jobId);
  }

  private jobRow(jobId: string): DiscoveryJobRow | null {
    return (this.database.prepare("SELECT * FROM selection_discovery_jobs WHERE id = ?").get(jobId) as DiscoveryJobRow | undefined) ?? null;
  }

  private stagePageCount(jobId: string): number {
    return (this.database.prepare("SELECT COUNT(*) AS count FROM selection_discovery_stage_pages WHERE job_id = ?").get(jobId) as { count: number }).count;
  }

  private latestResumableJob(): DiscoveryJobRow | null {
    return (this.database.prepare(
      `SELECT j.* FROM selection_discovery_jobs j WHERE j.status = 'failed'
       AND EXISTS (SELECT 1 FROM selection_discovery_stage_pages p WHERE p.job_id = j.id)
       ORDER BY j.created_at_ms DESC LIMIT 1`,
    ).get() as DiscoveryJobRow | undefined) ?? null;
  }

  private latestBatch(): DiscoveryBatchRow | null {
    return (this.database.prepare(
      "SELECT id, snapshot_id, collected_at_ms FROM selection_discovery_batches ORDER BY collected_at_ms DESC LIMIT 1",
    ).get() as DiscoveryBatchRow | undefined) ?? null;
  }

  private cloud(baseUrl: string): CategoryCloudPort {
    return this.options.cloudFactory?.(baseUrl) ?? new CategoryCloudClient(baseUrl, this.options.fetchImplementation);
  }
}
