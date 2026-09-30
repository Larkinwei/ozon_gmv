import { spawn } from "node:child_process";

import type {
  SelectionCategoryCloudMetric,
  SelectionCategoryPeriod,
} from "../../shared/contracts";

const CATEGORY_URL = "https://seller.ozon.ru/app/analytics/what-to-sell/categories-comparison?category=null&period=week&group=group_category3&metric=metricGmv&minPrice=1&maxPrice=30&showMyShop=false&showMyCategories=false&sortingColumn=metricGmv&sortingOrder=direction_desc&myShopSortingColumn=metricGmv_self&myShopSortingOrder=direction_desc";
const REQUEST_DELAYS_MS = [30_000, 60_000, 120_000] as const;

export interface OzonCategoryLevel1 {
  id: string;
  name: string;
}

export interface CategoryCollectionProgress {
  totalSteps: number;
  completedSteps: number;
  currentCategory: string;
  metrics: SelectionCategoryCloudMetric[];
  completedKeys: string[];
}

export interface CategoryCollectorInput {
  resumeMetrics: SelectionCategoryCloudMetric[];
  resumeCompletedKeys: string[];
  onProgress: (progress: CategoryCollectionProgress) => void;
}

export interface CategoryCollectorPort {
  collect: (input: CategoryCollectorInput) => Promise<SelectionCategoryCloudMetric[]>;
}

export interface OpenCliCategoryCollectorOptions {
  executable: string;
  sessionName: string;
  requestDelayMs?: number;
  runCommand?: ((argumentsList: string[]) => Promise<string>) | undefined;
  delayImplementation?: ((milliseconds: number) => Promise<void>) | undefined;
}

interface BootstrapResult {
  companyId: string;
  categories: OzonCategoryLevel1[];
  status: number;
  message?: string;
}

interface RawCategoryMetric {
  key: string;
  label: string;
  metric_gmv: number;
  metric_gmv_growth: number | null;
  metric_items: string;
  metric_aiv: number;
  metric_aiv_growth: number | null;
  metric_sellers: string;
  metric_brands: string;
  metric_clusters: string;
  metric_buyout: number | null;
  metric_leader_share: number | null;
  metric_category_share: number | null;
  rating: string | null;
  max_rating: string | null;
}

interface FetchResult {
  status: number;
  items?: RawCategoryMetric[];
  message?: string;
}

/** Identifies transient Seller failures that may succeed on a later attempt. */
function isRetryableStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRate(value: number | null): number | null {
  return value === null ? null : value / 100;
}

function metricKey(metric: Pick<SelectionCategoryCloudMetric, "id" | "periodDays">): string {
  return `${metric.periodDays}:${metric.id}`;
}

function normalizeMetric(
  item: RawCategoryMetric,
  category: OzonCategoryLevel1,
  periodDays: SelectionCategoryPeriod,
): SelectionCategoryCloudMetric {
  return {
    id: String(item.key),
    name: String(item.label),
    categoryLevel1Id: category.id,
    categoryLevel1Name: category.name,
    periodDays,
    gmvMinor: String(Math.round(Number(item.metric_gmv) * 100)),
    gmvGrowth: normalizeRate(normalizeNullableNumber(item.metric_gmv_growth)),
    orderedUnits: Math.round(normalizeNullableNumber(item.metric_items) ?? 0),
    averagePriceMinor: String(Math.round(Number(item.metric_aiv) * 100)),
    averagePriceGrowth: normalizeRate(normalizeNullableNumber(item.metric_aiv_growth)),
    sellerCount: normalizeNullableNumber(item.metric_sellers),
    brandCount: normalizeNullableNumber(item.metric_brands),
    clusterCount: normalizeNullableNumber(item.metric_clusters),
    buyoutRate: normalizeRate(normalizeNullableNumber(item.metric_buyout)),
    topFiveSellerShare: normalizeRate(normalizeNullableNumber(item.metric_leader_share)),
    categoryShare: normalizeRate(normalizeNullableNumber(item.metric_category_share)),
    rating: normalizeNullableNumber(item.rating),
    maximumRating: normalizeNullableNumber(item.max_rating),
  };
}

/** Uses OpenCLI's fixed argument interface so the user's Chrome cookies never enter this process. */
export class OpenCliCategoryCollector implements CategoryCollectorPort {
  private readonly requestDelayMs: number;

  public constructor(private readonly options: OpenCliCategoryCollectorOptions) {
    this.requestDelayMs = options.requestDelayMs ?? 1_000;
  }

  public async collect(input: CategoryCollectorInput): Promise<SelectionCategoryCloudMetric[]> {
    await this.run(["browser", this.options.sessionName, "open", CATEGORY_URL]);
    await this.run(["browser", this.options.sessionName, "wait", "time", "5"]);
    try {
      const bootstrap = await this.fetchBootstrapWithRetry();
      const completed = new Map(input.resumeMetrics.map((metric) => [metricKey(metric), metric]));
      const completedKeys = new Set(input.resumeCompletedKeys);
      const totalSteps = bootstrap.categories.length * 2;
      let completedSteps = completedKeys.size;

      for (const periodDays of [7, 28] as const) {
        for (const category of bootstrap.categories) {
          const prefix = `${periodDays}:`;
          const stepKey = `${periodDays}:${category.id}`;
          if (completedKeys.has(stepKey)) {
            continue;
          }
          const items = await this.fetchWithRetry(bootstrap.companyId, category, periodDays);
          for (const item of items) {
            const metric = normalizeMetric(item, category, periodDays);
            completed.set(`${prefix}${metric.id}`, metric);
          }
          completedKeys.add(stepKey);
          completedSteps += 1;
          input.onProgress({
            totalSteps,
            completedSteps,
            currentCategory: `${category.name} · 近 ${periodDays} 天`,
            metrics: [...completed.values()],
            completedKeys: [...completedKeys],
          });
          await this.sleep(this.requestDelayMs);
        }
      }
      return [...completed.values()];
    } finally {
      await this.run(["browser", this.options.sessionName, "tab", "close"]).catch(() => undefined);
      await this.run(["browser", this.options.sessionName, "close"]).catch(() => undefined);
    }
  }

  private async fetchWithRetry(
    companyId: string,
    category: OzonCategoryLevel1,
    periodDays: SelectionCategoryPeriod,
  ): Promise<RawCategoryMetric[]> {
    for (let attempt = 0; attempt <= REQUEST_DELAYS_MS.length; attempt += 1) {
      const result = await this.runJson<FetchResult>(this.fetchScript(companyId, category.id, periodDays));
      if (result.status === 200 && result.items) {
        return result.items;
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error("Ozon 登录已失效，请在 Chrome 重新登录 Seller 后再同步");
      }
      if (!isRetryableStatus(result.status) || attempt === REQUEST_DELAYS_MS.length) {
        throw new Error(result.message ?? `Ozon 类目接口返回 ${result.status}`);
      }
      await this.sleep(REQUEST_DELAYS_MS[attempt]!);
    }
    throw new Error("Ozon 类目接口重试失败");
  }

  /** Reads root categories from Seller's category tree instead of page markup. */
  private async fetchBootstrapWithRetry(): Promise<BootstrapResult> {
    for (let attempt = 0; attempt <= REQUEST_DELAYS_MS.length; attempt += 1) {
      const result = await this.runJson<BootstrapResult>(this.bootstrapScript());
      if (!result.companyId) {
        throw new Error("Chrome 中未找到 Ozon Seller 登录状态，请重新登录");
      }
      if (result.status === 401 || result.status === 403) {
        throw new Error("Ozon 登录或类目读取权限已失效，请重新登录 Seller 并确认账号可访问类目分析");
      }
      if (result.status === 200) {
        if (result.categories.length === 0) {
          throw new Error("Ozon 类目树接口未返回一级类目，请检查 Seller 类目权限或接口响应");
        }
        return result;
      }
      if (!isRetryableStatus(result.status) || attempt === REQUEST_DELAYS_MS.length) {
        throw new Error(result.message ?? `Ozon 类目树接口返回 ${result.status}`);
      }
      await this.sleep(REQUEST_DELAYS_MS[attempt]!);
    }
    throw new Error("Ozon 类目树接口重试失败");
  }

  private bootstrapScript(): string {
    return `(async () => {
      const state = JSON.parse(localStorage.getItem("vuex") || "{}");
      const companyId = String(state && state.user && state.user.contentId || "");
      if (!companyId) return { companyId, categories: [], status: 0 };
      const headers = { Accept: "application/json, text/plain, */*", "Content-Type": "application/json",
        "accept-language": "ru", "x-o3-app-name": "seller-ui", "x-o3-company-id": companyId, "x-o3-language": "ru" };
      try {
        const response = await fetch("/api/v1/seller-tree/get", { method: "POST", headers, body: "{}" });
        const payload = await response.json().catch(() => ({})) || {};
        const categories = Object.values(payload.result || {}).flatMap((item) => {
          const id = String(item?.descriptionCategoryId || "");
          const name = String(item?.descriptionCategoryName || "");
          return /^\\d+$/.test(id) && name ? [{ id, name }] : [];
        });
        return { companyId, categories, status: response.status,
          message: payload.error && (payload.error.detail || payload.error.message) };
      } catch (error) {
        return { companyId, categories: [], status: 0, message: String(error) };
      }
    })()`;
  }

  private fetchScript(companyId: string, categoryId: string, periodDays: SelectionCategoryPeriod): string {
    const period = periodDays === 7 ? "period_week" : "period_month";
    return `(async () => {
      const body = {
        filter: { sex: [], brand_ids: [], seller_ids: [], category: {
          category_type: "category1", id: ${JSON.stringify(Number(categoryId))}, is_own: false
        }, price_segment: { from: 1, to: 30 }, seller_country: "" },
        group: "group_category3", period_slice: "slice_day", period: ${JSON.stringify(period)},
        sort: { direction: "direction_desc", metric: "metric_gmv" }, is_premium: false
      };
      try {
        const response = await fetch("/api/site/exar-api/v2/gb/seller/metrics", {
          method: "POST", headers: {
            Accept: "application/json, text/plain, */*", "Content-Type": "application/json",
            "accept-language": "zh-Hans", "x-o3-app-name": "seller-ui",
            "x-o3-company-id": ${JSON.stringify(companyId)}, "x-o3-language": "zh-Hans",
            "x-o3-page-type": "analytics_other_domain"
          }, body: JSON.stringify(body)
        });
        const payload = await response.json().catch(() => ({}));
        return { status: response.status, items: payload.items,
          message: payload.error && (payload.error.detail || payload.error.message) };
      } catch (error) {
        return { status: 0, message: String(error) };
      }
    })()`;
  }

  private runJson<T>(script: string): Promise<T> {
    return this.run(["browser", this.options.sessionName, "eval", script])
      .then((output) => this.parseJson<T>(output));
  }

  private parseJson<T>(output: string): T {
    const start = Math.min(...[output.indexOf("{"), output.indexOf("[")].filter((index) => index >= 0));
    const end = Math.max(output.lastIndexOf("}"), output.lastIndexOf("]"));
    if (!Number.isFinite(start) || end < start) {
      throw new Error("OpenCLI 未返回可解析的数据");
    }
    return JSON.parse(output.slice(start, end + 1)) as T;
  }

  private run(argumentsList: string[]): Promise<string> {
    if (this.options.runCommand) {
      return this.options.runCommand(argumentsList);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.executable, argumentsList, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", () => reject(new Error("OpenCLI 无法启动，请检查路径和 Chrome 扩展连接")));
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `OpenCLI 退出码 ${code}`));
          return;
        }
        resolve(Buffer.concat(stdout).toString("utf8"));
      });
    });
  }

  private sleep(milliseconds: number): Promise<void> {
    return this.options.delayImplementation?.(milliseconds) ?? delay(milliseconds);
  }
}
