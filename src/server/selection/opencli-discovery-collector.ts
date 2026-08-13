import { spawn } from "node:child_process";

import type {
  SelectionCategoryLink,
  SelectionCategoryMetric,
  SelectionCategoryPeriod,
  SelectionDiscoveryProductRanking,
  SelectionDiscoveryQueryRanking,
} from "../../shared/contracts";

const BESTSELLERS_URL = "https://seller.ozon.ru/app/analytics/what-to-sell/ozon-bestsellers";
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const;
const EXPLICIT_QUERY_GROUPS: Record<string, string[]> = {
  "200001388": ["Ozon fresh"],
  "17027489": ["Красота и здоровье"],
  "17027493": ["Аксессуары", "Одежда обувь и аксессуары"],
  "92120918": ["Автомобили"],
  "17027495": ["Автотовары"],
  "76902590": ["Ювелирные украшения"],
  "92130764": ["Музыка и видео"],
  "75021418": ["Бытовая химия", "Бытовая химия и гигиена"],
  "99999999": ["Музыка и видео", "Игры и консоли", "Всё для игр", "Цифровые товары"],
};

interface TreeNode {
  descriptionCategoryId: string;
  descriptionCategoryName: string;
  descriptionTypeId: string;
  nodes: Record<string, TreeNode>;
}

interface BootstrapResult {
  companyId: string;
  tree: Record<string, TreeNode>;
  groups: string[];
  error?: string;
}

interface RawProduct {
  sku?: string | number;
  name?: string;
  skuName?: string;
  link?: string;
  photo?: string;
  sellerName?: string;
  sellerId?: string | number;
  brand?: string;
  brandId?: string | number;
  category1?: string;
  category1Id?: string | number;
  category3?: string;
  category3Id?: string | number;
  gmvSum?: number;
  soldSum?: number;
  soldCount?: string | number;
  salesDynamics?: number | null;
  avgGmv?: number;
  avgPrice?: number;
  minSellerPrice?: number;
  nullableRedemptionRate?: number | null;
  sumMissedGmv?: number;
  daysInStock?: string | number;
  stock?: string | number;
  fboStock?: string | number;
  fbsStock?: string | number;
  salesSchema?: string;
  volume?: number;
  views?: string | number;
  sessionCountSearch?: string | number;
  qtyViewPdp?: string | number;
  convViewToOrder?: number;
  convToCartSearch?: number;
  convToCartPdp?: number;
  discount?: number;
  promoRevenueShare?: number;
  daysInPromo?: number;
  daysWithTrafarets?: number;
  drr?: number;
  nullableCreateDate?: string | null;
}

interface RawQuery {
  query?: string;
  count?: number;
  uniqQueriesWCa?: number;
  ca?: number;
  ord?: number;
  searchUsersToOrdUsers?: number;
  gmv?: number;
  avgCaRub?: number;
  itemsViews?: number;
  uniqSellers?: number;
  usersWithoutInterectionCount?: number;
  usersWithoutInterectionShare?: number;
  zrCount?: number;
  zrShare?: number;
  avgCountItems?: number;
}

interface PageResult<T> {
  status: number;
  items: T[];
  total: number;
  message?: string;
}

export interface DiscoveryStagePage {
  pageKey: string;
  stage: "products" | "queries" | "links";
  currentItem: string;
  payload: SelectionDiscoveryProductRanking[] | SelectionDiscoveryQueryRanking[] | SelectionCategoryLink[];
}

export interface DiscoveryMarketCollection {
  products: SelectionDiscoveryProductRanking[];
  queries: SelectionDiscoveryQueryRanking[];
  links: SelectionCategoryLink[];
  totalSteps: number;
}

export interface DiscoveryMarketCollectorInput {
  categories: SelectionCategoryMetric[];
  resumePages: Map<string, DiscoveryStagePage["payload"]>;
  onPage: (page: DiscoveryStagePage, completedSteps: number, totalSteps: number) => void;
}

export interface DiscoveryMarketCollectorPort {
  collect: (input: DiscoveryMarketCollectorInput) => Promise<DiscoveryMarketCollection>;
}

export interface OpenCliDiscoveryCollectorOptions {
  executable: string;
  sessionName: string;
  requestDelayMs?: number;
  runCommand?: (argumentsList: string[]) => Promise<string>;
  delayImplementation?: (milliseconds: number) => Promise<void>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function rate(value: unknown): number {
  return finite(value) / 100;
}

function moneyMinor(value: unknown): string {
  return String(Math.round(finite(value) * 100));
}

function normalizedPhrase(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
}

function productFromRaw(
  item: RawProduct,
  scope: "global" | "category",
  scopeCategoryId: string | null,
  periodDays: SelectionCategoryPeriod,
  rank: number,
): SelectionDiscoveryProductRanking | null {
  const ozonProductId = String(item.sku ?? "").trim();
  const name = String(item.name ?? item.skuName ?? "").trim();
  if (!ozonProductId || !name) return null;
  return {
    ozonProductId,
    name,
    ozonUrl: String(item.link ?? `https://www.ozon.ru/product/${ozonProductId}`),
    photoUrl: item.photo ? String(item.photo) : null,
    seller: String(item.sellerName ?? ""),
    sellerId: item.sellerId === undefined ? null : String(item.sellerId),
    brand: String(item.brand ?? ""),
    brandId: item.brandId === undefined ? null : String(item.brandId),
    categoryLevel1Id: String(item.category1Id ?? ""),
    categoryLevel1: String(item.category1 ?? ""),
    categoryLevel3Id: String(item.category3Id ?? ""),
    categoryLevel3: String(item.category3 ?? ""),
    scope,
    scopeCategoryId,
    periodDays,
    rank,
    orderedAmountMinor: moneyMinor(item.gmvSum ?? item.soldSum),
    orderedUnits: Math.round(finite(item.soldCount)),
    turnoverGrowth: item.salesDynamics === null || item.salesDynamics === undefined ? null : rate(item.salesDynamics),
    averagePriceMinor: moneyMinor(item.avgGmv ?? item.avgPrice),
    minimumPriceMinor: moneyMinor(item.minSellerPrice),
    purchaseRate: item.nullableRedemptionRate === null || item.nullableRedemptionRate === undefined ? null : rate(item.nullableRedemptionRate),
    missedSalesMinor: moneyMinor(item.sumMissedGmv),
    outOfStockDays: nullableInteger(item.daysInStock),
    stock: nullableInteger(item.stock),
    fboStock: nullableInteger(item.fboStock),
    fbsStock: nullableInteger(item.fbsStock),
    fulfillmentScheme: String(item.salesSchema ?? ""),
    volumeLiters: item.volume === undefined ? null : finite(item.volume),
    impressions: Math.round(finite(item.views)),
    searchViews: Math.round(finite(item.sessionCountSearch)),
    cardViews: Math.round(finite(item.qtyViewPdp)),
    impressionToOrderRate: rate(item.convViewToOrder),
    searchToCartRate: rate(item.convToCartSearch),
    cardToCartRate: rate(item.convToCartPdp),
    promotionDiscountRate: rate(item.discount),
    promotedOrderShare: rate(item.promoRevenueShare),
    promotionDays: Math.round(finite(item.daysInPromo)),
    advertisedDays: Math.round(finite(item.daysWithTrafarets)),
    advertisingCostShare: rate(item.drr),
    productCardCreatedDate: item.nullableCreateDate ?? null,
  };
}

function queryFromRaw(
  item: RawQuery,
  scope: "global" | "group",
  groupName: string | null,
  rank: number,
): SelectionDiscoveryQueryRanking | null {
  const phrase = String(item.query ?? "").trim();
  if (!phrase) return null;
  return {
    phrase,
    normalizedPhrase: normalizedPhrase(phrase),
    scope,
    groupName,
    periodDays: 7,
    rank,
    searchCount: Math.round(finite(item.count)),
    searchesWithCart: Math.round(finite(item.uniqQueriesWCa)),
    cartRate: rate(item.ca),
    orderedUnits: Math.round(finite(item.ord)),
    orderRate: rate(item.searchUsersToOrdUsers),
    orderedAmountMinor: moneyMinor(item.gmv),
    averagePriceMinor: moneyMinor(item.avgCaRub),
    productViews: Math.round(finite(item.itemsViews)),
    competingSellers: Math.round(finite(item.uniqSellers)),
    noInteractionCount: Math.round(finite(item.usersWithoutInterectionCount)),
    noInteractionRate: rate(item.usersWithoutInterectionShare),
    noResultCount: Math.round(finite(item.zrCount)),
    noResultRate: rate(item.zrShare),
    averageProductCount: finite(item.avgCountItems),
  };
}

/** Collects official bestseller and market-query pages through OpenCLI's logged-in Chrome session. */
export class OpenCliDiscoveryCollector implements DiscoveryMarketCollectorPort {
  private readonly requestDelayMs: number;

  public constructor(private readonly options: OpenCliDiscoveryCollectorOptions) {
    // 每次接口已批量返回最多 50 条；短间隔串行请求，并由 429 退避承担限流保护。
    this.requestDelayMs = options.requestDelayMs ?? 200;
  }

  public async collect(input: DiscoveryMarketCollectorInput): Promise<DiscoveryMarketCollection> {
    await this.run(["browser", this.options.sessionName, "open", BESTSELLERS_URL]);
    await this.run(["browser", this.options.sessionName, "wait", "time", "5"]);
    try {
      const bootstrap = await this.runJson<BootstrapResult>(this.bootstrapScript());
      if (!bootstrap.companyId) throw new Error("Chrome 中未找到 Ozon Seller 登录状态，请重新登录");
      if (bootstrap.error) throw new Error(bootstrap.error);
      const links = this.buildLinks(input.categories, bootstrap.tree, bootstrap.groups);
      const productSteps = 40 + links.filter((link) => link.productTypeIds.length > 0).length * 2;
      const queryGroups = [...new Set(links.flatMap((link) => link.queryGroups))];
      const totalSteps = productSteps + 200 + queryGroups.length + 1;
      let completedSteps = input.resumePages.size;
      await this.savePage(input, { pageKey: "links:all", stage: "links", currentItem: "类目关联映射", payload: links }, ++completedSteps, totalSteps);

      for (const periodDays of [7, 28] as const) {
        for (let offset = 0; offset < 1_000; offset += 50) {
          const key = `products:global:${periodDays}:${offset}`;
          if (input.resumePages.has(key)) continue;
          const result = await this.fetchPage<RawProduct>(this.productScript(bootstrap.companyId, periodDays, [], offset));
          const payload = result.items.map((item, index) => productFromRaw(item, "global", null, periodDays, offset + index + 1)).filter((item): item is SelectionDiscoveryProductRanking => item !== null);
          await this.savePage(input, { pageKey: key, stage: "products", currentItem: `全站热销商品 · 近 ${periodDays} 天 · ${offset + 1}-${offset + 50}`, payload }, ++completedSteps, totalSteps);
        }
        for (const link of links) {
          if (link.productTypeIds.length === 0) continue;
          const key = `products:category:${link.categoryId}:${periodDays}:0`;
          if (input.resumePages.has(key)) continue;
          const result = await this.fetchPage<RawProduct>(this.productScript(bootstrap.companyId, periodDays, link.productTypeIds, 0));
          const payload = result.items.slice(0, 50).map((item, index) => productFromRaw(item, "category", link.categoryId, periodDays, index + 1)).filter((item): item is SelectionDiscoveryProductRanking => item !== null);
          await this.savePage(input, { pageKey: key, stage: "products", currentItem: `${link.categoryName} · 热销商品 · 近 ${periodDays} 天`, payload }, ++completedSteps, totalSteps);
        }
      }

      for (let offset = 0; offset < 10_000; offset += 50) {
        const key = `queries:global:7:${offset}`;
        if (input.resumePages.has(key)) continue;
        const result = await this.fetchPage<RawQuery>(this.queryScript(bootstrap.companyId, offset, null));
        const payload = result.items.map((item, index) => queryFromRaw(item, "global", null, offset + index + 1)).filter((item): item is SelectionDiscoveryQueryRanking => item !== null);
        await this.savePage(input, { pageKey: key, stage: "queries", currentItem: `全站热搜词 · ${offset + 1}-${offset + 50}`, payload }, ++completedSteps, totalSteps);
      }
      for (const groupName of queryGroups) {
        const key = `queries:group:${groupName}:7:0`;
        if (input.resumePages.has(key)) continue;
        const result = await this.fetchPage<RawQuery>(this.queryScript(bootstrap.companyId, 0, groupName));
        const payload = result.items.slice(0, 50).map((item, index) => queryFromRaw(item, "group", groupName, index + 1)).filter((item): item is SelectionDiscoveryQueryRanking => item !== null);
        await this.savePage(input, { pageKey: key, stage: "queries", currentItem: `${groupName} · 所属一级类目热词`, payload }, ++completedSteps, totalSteps);
      }

      const pages = input.resumePages;
      return {
        products: [...pages.entries()].filter(([key]) => key.startsWith("products:")).flatMap(([, payload]) => payload as SelectionDiscoveryProductRanking[]),
        queries: [...pages.entries()].filter(([key]) => key.startsWith("queries:")).flatMap(([, payload]) => payload as SelectionDiscoveryQueryRanking[]),
        links,
        totalSteps,
      };
    } finally {
      await this.run(["browser", this.options.sessionName, "tab", "close"]).catch(() => undefined);
      await this.run(["browser", this.options.sessionName, "close"]).catch(() => undefined);
    }
  }

  private async savePage(
    input: DiscoveryMarketCollectorInput,
    page: DiscoveryStagePage,
    completedSteps: number,
    totalSteps: number,
  ): Promise<void> {
    if (!input.resumePages.has(page.pageKey)) {
      input.resumePages.set(page.pageKey, page.payload);
      input.onPage(page, completedSteps, totalSteps);
      await this.sleep(this.requestDelayMs);
    }
  }

  private buildLinks(categories: SelectionCategoryMetric[], tree: Record<string, TreeNode>, groups: string[]): SelectionCategoryLink[] {
    const unique = new Map(categories.map((category) => [category.id, category]));
    const groupSet = new Set(groups);
    const rootsById = new Map(Object.values(tree).map((root) => [String(root.descriptionCategoryId), root]));
    return [...unique.values()].map((category) => {
      const nodes = this.findNodes(tree, category.id);
      const productTypeIds = [...new Set(nodes.flatMap((node) => this.descendantTypeIds(node)))];
      const rootName = rootsById.get(category.categoryLevel1Id)?.descriptionCategoryName;
      const configured = EXPLICIT_QUERY_GROUPS[category.categoryLevel1Id] ?? (rootName ? [rootName] : []);
      const queryGroups = configured.filter((name) => groupSet.has(name));
      return {
        categoryId: category.id,
        categoryName: category.name,
        categoryLevel1Id: category.categoryLevel1Id,
        categoryLevel1Name: category.categoryLevel1Name,
        productTypeIds,
        queryGroups,
        queryScope: queryGroups.length > 0 ? "category_level_1" : "unavailable",
      };
    });
  }

  private findNodes(tree: Record<string, TreeNode>, categoryId: string): TreeNode[] {
    const matches: TreeNode[] = [];
    const visit = (node: TreeNode): void => {
      if (String(node.descriptionCategoryId) === categoryId) matches.push(node);
      Object.values(node.nodes ?? {}).forEach(visit);
    };
    Object.values(tree).forEach(visit);
    return matches;
  }

  private descendantTypeIds(node: TreeNode): string[] {
    const own = node.descriptionTypeId && node.descriptionTypeId !== "0" ? [String(node.descriptionTypeId)] : [];
    return own.concat(Object.values(node.nodes ?? {}).flatMap((child) => this.descendantTypeIds(child)));
  }

  private async fetchPage<T>(script: string): Promise<PageResult<T>> {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const result = await this.runJson<PageResult<T>>(script);
      if (result.status === 200) return result;
      if (result.status === 401 || result.status === 403) {
        throw new Error("Ozon 登录或分析权限已失效，请在 Chrome 重新登录 Seller 后再同步");
      }
      if (result.status !== 429 || attempt === RETRY_DELAYS_MS.length) {
        throw new Error(result.message ?? `Ozon 市场接口返回 ${result.status}`);
      }
      await this.sleep(RETRY_DELAYS_MS[attempt]!);
    }
    throw new Error("Ozon 市场接口重试失败");
  }

  private bootstrapScript(): string {
    return `(async () => {
      const state = JSON.parse(localStorage.getItem("vuex") || "{}");
      const companyId = String(state && state.user && state.user.contentId || "");
      if (!companyId) return { companyId: "", tree: {}, groups: [] };
      const headers = { Accept: "application/json, text/plain, */*", "Content-Type": "application/json",
        "accept-language": "ru", "x-o3-app-name": "seller-ui", "x-o3-company-id": companyId, "x-o3-language": "ru" };
      const treeResponse = await fetch("/api/v1/seller-tree/get", { method: "POST", headers, body: "{}" });
      const treePayload = await treeResponse.json();
      if (!treeResponse.ok) return { companyId, tree: {}, groups: [], error: "Ozon 商品类目树读取失败（" + treeResponse.status + "）" };
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const groupResponse = await fetch("/api/site/searchstat/Stats/queries/groups", { method: "POST", headers, body: "{}" });
      const groupPayload = await groupResponse.json();
      if (!groupResponse.ok) return { companyId, tree: {}, groups: [], error: "Ozon 热词分组读取失败（" + groupResponse.status + "）" };
      return { companyId, tree: treePayload.result || {}, groups: (groupPayload.groups || []).map((item) => String(item.name)) };
    })()`;
  }

  private productScript(companyId: string, periodDays: SelectionCategoryPeriod, typeIds: string[], offset: number): string {
    return `(async () => {
      const headers = { Accept: "application/json, text/plain, */*", "Content-Type": "application/json",
        "accept-language": "zh-Hans", "x-o3-app-name": "seller-ui", "x-o3-company-id": ${JSON.stringify(companyId)}, "x-o3-language": "zh-Hans" };
      const body = { limit: "50", offset: ${JSON.stringify(String(offset))}, filter: {
        stock: "any_stock", period: ${JSON.stringify(periodDays === 7 ? "weekly" : "monthly")},
        categories: ${JSON.stringify(typeIds)}, brand_ids: [], seller_ids: []
      }, sort: { key: "sum_gmv_desc" } };
      const response = await fetch("/api/site/seller-analytics/what_to_sell/data/v3", { method: "POST", headers, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      return { status: response.status, items: payload.items || [], total: Number(payload.totals || 0),
        message: payload.error && (payload.error.detail || payload.error.message) };
    })()`;
  }

  private queryScript(companyId: string, offset: number, groupName: string | null): string {
    return `(async () => {
      const headers = { Accept: "application/json, text/plain, */*", "Content-Type": "application/json",
        "accept-language": "ru", "x-o3-app-name": "seller-ui", "x-o3-company-id": ${JSON.stringify(companyId)}, "x-o3-language": "ru" };
      const body = { text: "", limit: "50", offset: ${JSON.stringify(String(offset))}, sort_by: "count", sort_dir: "desc",
        period: "days_7"${groupName ? `, group_name: ${JSON.stringify(groupName)}` : ""} };
      const response = await fetch("/api/site/searchteam/Stats/queries/search/v2", { method: "POST", headers, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      return { status: response.status, items: payload.data || [], total: Number(payload.total || 0),
        message: payload.error && (payload.error.detail || payload.error.message) };
    })()`;
  }

  private runJson<T>(script: string): Promise<T> {
    return this.run(["browser", this.options.sessionName, "eval", script]).then((output) => this.parseJson<T>(output));
  }

  private parseJson<T>(output: string): T {
    const indexes = [output.indexOf("{"), output.indexOf("[")].filter((index) => index >= 0);
    const start = indexes.length > 0 ? Math.min(...indexes) : -1;
    const end = Math.max(output.lastIndexOf("}"), output.lastIndexOf("]"));
    if (start < 0 || end < start) throw new Error("OpenCLI 未返回可解析的数据");
    return JSON.parse(output.slice(start, end + 1)) as T;
  }

  private run(argumentsList: string[]): Promise<string> {
    if (this.options.runCommand) return this.options.runCommand(argumentsList);
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.executable, argumentsList, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", () => reject(new Error("OpenCLI 无法启动，请检查路径和 Chrome 扩展连接")));
      child.once("close", (code) => code === 0
        ? resolve(Buffer.concat(stdout).toString("utf8"))
        : reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `OpenCLI 退出码 ${code}`)));
    });
  }

  private sleep(milliseconds: number): Promise<void> {
    return this.options.delayImplementation?.(milliseconds) ?? delay(milliseconds);
  }
}
