import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";

import type { Statement } from "better-sqlite3";
import { parse } from "csv-parse/sync";
import Decimal from "decimal.js";
import ExcelJS from "exceljs";

import type {
  SelectionImportError,
  SelectionImportMapping,
  SelectionImportPreview,
  SelectionImportResult,
  SelectionImportView,
  SelectionOverview,
  SelectionCandidate,
  SelectionCandidateCreateInput,
  SelectionCandidateStatus,
  SelectionCandidateUpdateInput,
  SelectionKeywordListItem,
  SelectionKeywordDetail,
  SelectionKeywordPage,
  SelectionKeywordSort,
  SelectionMarketProductDetail,
  SelectionMarketProductListItem,
  SelectionMarketProductPage,
  SelectionMarketProductSnapshot,
  SelectionMarketProductSort,
  SelectionRateUnit,
  SelectionWordstatView,
  WordstatJobStatus,
  WordstatJobView,
  WordstatSettingsView,
  WordstatTrend,
} from "../../shared/contracts";
import type { AppConfig } from "../config";
import type { AppDatabase } from "../db/database";
import { minorUnitsToAmount } from "../db/money-storage";
import { SettingsRepository } from "../db/settings-repository";
import { decryptSecret, encryptSecret } from "../security/encryption";
import {
  detectMarketProductReport,
  normalizeMarketProductRows,
  type MarketProductReportDetection,
  type NormalizedMarketProduct,
} from "./market-product-report";
import { WordstatClient, type WordstatProfile } from "./wordstat-client";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 50_000;
const SAMPLE_ROW_COUNT = 5;
const WORDSTAT_CACHE_MS = 24 * 60 * 60 * 1000;
const WORDSTAT_CONCURRENCY = 3;
const WORDSTAT_FOLDER_KEY = "selection.wordstat_folder_id";
const WORDSTAT_API_KEY = "selection.wordstat_api_key_ciphertext";

export interface SelectionImportFile {
  fileName: string;
  content: Buffer;
  sheetName?: string;
}

export interface SelectionImportRequest extends SelectionImportFile {
  snapshotDate: string;
  mapping?: SelectionImportMapping | undefined;
}

export interface SelectionKeywordQuery {
  page: number;
  pageSize: number;
  sort: SelectionKeywordSort;
  search?: string | undefined;
  minimumPrice?: number | undefined;
  maximumPrice?: number | undefined;
}

export interface SelectionMarketProductQuery {
  page: number;
  pageSize: number;
  sort: SelectionMarketProductSort;
  search?: string | undefined;
  categoryLevel1?: string | undefined;
  categoryLevel3?: string | undefined;
  productFlag?: string | undefined;
  minimumPrice?: number | undefined;
  maximumPrice?: number | undefined;
}

interface ParsedImport {
  sheets: string[];
  selectedSheet: string;
  rows: string[][];
  rowNumbers: number[];
}

interface NormalizedMetric {
  phrase: string;
  normalizedPhrase: string;
  searchCount: number;
  cartRate: number;
  orderRate: number;
  averagePriceMinor: number | null;
  demandScore: number | null;
}

interface KeywordListRow {
  id: string;
  phrase: string;
  snapshot_date: string;
  search_count: number;
  cart_rate: number;
  order_rate: number;
  average_price_minor: number | null;
  demand_score: number | null;
  wordstat_status?: SelectionKeywordListItem["wordstatStatus"];
}

interface WordstatSnapshotRow {
  fetched_at_ms: number;
  total_count_30d: number;
  top_requests_json: string;
  associations_json: string;
  dynamics_json: string;
  growth_3m: number | null;
  growth_12m: number | null;
  trend: WordstatTrend;
}

interface WordstatJobRow {
  id: string;
  status: WordstatJobStatus;
  created_at_ms: number;
  finished_at_ms: number | null;
  total: number;
  completed: number;
  failed: number;
}

interface WordstatJobItemRow {
  keyword_id: string;
  phrase: string;
}

interface CandidateRow {
  id: string;
  keyword_id: string | null;
  market_product_id: string | null;
  name: string;
  ozon_url: string | null;
  category: string | null;
  target_price_minor: number | null;
  status: SelectionCandidateStatus;
  decision_reason: string | null;
  note: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  keyword_phrase: string | null;
  keyword_demand_score: number | null;
  market_ozon_product_id: string | null;
  market_name: string | null;
  market_ozon_url: string | null;
  market_seller: string | null;
  market_brand: string | null;
  market_category_level_1: string | null;
  market_category_level_3: string | null;
  market_product_flags: string | null;
  market_snapshot_date: string | null;
  market_report_period_days: number | null;
  market_ordered_amount_minor: number | null;
  market_turnover_growth: number | null;
  market_ordered_units: number | null;
  market_average_price_minor: number | null;
  market_impression_to_order_rate: number | null;
  market_missed_sales: number | null;
  market_out_of_stock_days: number | null;
}

interface SelectionImportRow {
  id: string;
  kind: SelectionImportView["kind"];
  file_name: string;
  snapshot_date: string;
  sheet_name: string;
  report_period_days: number | null;
  valid_rows: number;
  skipped_rows: number;
  created_at_ms: number;
}

interface MarketProductRow {
  id: string;
  ozon_product_id: string;
  name: string;
  ozon_url: string;
  seller: string;
  brand: string;
  category_level_1: string;
  category_level_3: string;
  product_flags: string;
  snapshot_date: string;
  report_period_days: number;
  ordered_amount_minor: number;
  turnover_growth: number | null;
  ordered_units: number;
  average_price_minor: number;
  minimum_price_minor: number;
  purchase_rate: number | null;
  missed_sales: number;
  out_of_stock_days: number | null;
  daily_sales_amount_minor: number;
  daily_sales_units: number;
  ending_inventory_units: number;
  fulfillment_scheme: string;
  volume_liters: number;
  impressions: number;
  search_catalog_views: number;
  card_views: number;
  impression_to_order_rate: number;
  search_catalog_cart_rate: number;
  card_cart_rate: number;
  promotion_discount_rate: number;
  promoted_order_share: number;
  promotion_days: number;
  advertised_days: number;
  advertising_cost_share: number;
  product_card_created_date: string | null;
}

export interface WordstatPort {
  fetchProfile: (phrase: string) => Promise<WordstatProfile>;
  testConnection: () => Promise<void>;
}

interface SelectionModuleOptions {
  wordstatFactory?: (folderId: string, apiKey: string) => WordstatPort;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    if ("result" in value && value.result !== undefined) {
      return String(value.result);
    }
    if ("text" in value) {
      return String(value.text);
    }
    if ("richText" in value) {
      return value.richText.map((part) => part.text).join("");
    }
  }
  return String(value);
}

function trimTrailingEmptyCells(row: string[]): string[] {
  let lastIndex = row.length - 1;
  while (lastIndex >= 0 && row[lastIndex]?.trim() === "") {
    lastIndex -= 1;
  }
  return row.slice(0, lastIndex + 1);
}

function delimiterForCsv(content: string): string {
  const firstLine = content.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const candidates = [";", "\t", ","];
  let best = candidates[0] as string;
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function parseCsv(content: Buffer): string[][] {
  const text = content.toString("utf8");
  const rows = parse(text, {
    bom: true,
    delimiter: delimiterForCsv(text),
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
    to_line: MAX_IMPORT_ROWS + 2,
  }) as unknown[][];
  if (rows.length > MAX_IMPORT_ROWS + 1) {
    throw new Error(`导入文件不能超过 ${MAX_IMPORT_ROWS} 行`);
  }
  return rows.map((row) => trimTrailingEmptyCells(row.map((value) => String(value ?? ""))));
}

async function parseWorkbook(content: Buffer, selectedSheet?: string): Promise<{
  sheets: string[];
  selectedSheet: string;
  rows: string[][];
  rowNumbers: number[];
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(content as unknown as ExcelJS.Buffer);
  const sheets = workbook.worksheets.map((worksheet) => worksheet.name);
  const worksheet = selectedSheet ? workbook.getWorksheet(selectedSheet) : workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(selectedSheet ? `工作表不存在：${selectedSheet}` : "XLSX 文件没有工作表");
  }
  if (worksheet.rowCount > MAX_IMPORT_ROWS + 1) {
    throw new Error(`导入文件不能超过 ${MAX_IMPORT_ROWS} 行`);
  }
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    for (let column = 1; column <= row.cellCount; column += 1) {
      values.push(cellText(row.getCell(column).value).trim());
    }
    const normalized = trimTrailingEmptyCells(values);
    if (normalized.some(Boolean)) {
      rows.push(normalized);
      rowNumbers.push(row.number);
    }
  });
  return { sheets, selectedSheet: worksheet.name, rows, rowNumbers };
}

function validateImportFile(file: SelectionImportFile): "csv" | "xlsx" {
  if (file.content.byteLength > MAX_IMPORT_BYTES) {
    throw new Error("导入文件不能超过 10 MB");
  }
  const extension = extname(file.fileName).toLowerCase();
  if (extension === ".csv") {
    return "csv";
  }
  if (extension === ".xlsx") {
    return "xlsx";
  }
  throw new Error("仅支持 UTF-8 CSV 或 XLSX 文件");
}

async function parseImport(file: SelectionImportFile): Promise<ParsedImport & { fileType: "csv" | "xlsx" }> {
  const fileType = validateImportFile(file);
  if (fileType === "csv") {
    const rows = parseCsv(file.content);
    return { fileType, sheets: ["CSV"], selectedSheet: "CSV", rows, rowNumbers: rows.map((_, index) => index + 1) };
  }
  return { fileType, ...await parseWorkbook(file.content, file.sheetName) };
}

function columnIndex(headers: string[], columnName: string): number {
  const index = headers.indexOf(columnName);
  if (index < 0) {
    throw new Error(`找不到映射列：${columnName}`);
  }
  return index;
}

function decimalValue(value: string, label: string): Decimal {
  const normalized = value
    .replace(/[\s\u00A0₽]/g, "")
    .replace(/RUB/gi, "")
    .replace(/%/g, "")
    .replace(",", ".");
  const parsed = new Decimal(normalized || Number.NaN);
  if (!parsed.isFinite() || parsed.isNegative()) {
    throw new Error(`${label}不是有效的非负数`);
  }
  return parsed;
}

function integerValue(value: string, label: string): number {
  const parsed = decimalValue(value, label);
  if (!parsed.isInteger() || parsed.greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label}必须是整数`);
  }
  return parsed.toNumber();
}

function rateValue(value: string, unit: SelectionRateUnit, label: string): number {
  const parsed = decimalValue(value, label);
  const fraction = unit === "percent" ? parsed.dividedBy(100) : parsed;
  if (fraction.greaterThan(1)) {
    throw new Error(`${label}必须在 0% 到 100% 之间`);
  }
  return fraction.toNumber();
}

function moneyMinorUnits(value: string): number {
  const minorUnits = decimalValue(value, "买家平均价格").times(100).toDecimalPlaces(0);
  if (minorUnits.greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new Error("买家平均价格超出支持范围");
  }
  return minorUnits.toNumber();
}

function normalizePhrase(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
}

/** Implements Unicode-aware substring matching for imported Russian and Chinese report text. */
function containsNormalizedText(value: unknown, search: unknown): number {
  const normalizedSearch = normalizePhrase(String(search ?? ""));
  return normalizedSearch && normalizePhrase(String(value ?? "")).includes(normalizedSearch) ? 1 : 0;
}

function percentileRanks(values: number[]): number[] {
  if (values.length <= 1) {
    return values.map(() => 0);
  }
  const indexed = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value);
  const result = Array.from({ length: values.length }, () => 0);
  let position = 0;
  while (position < indexed.length) {
    let end = position;
    while (end + 1 < indexed.length && indexed[end + 1]?.value === indexed[position]?.value) {
      end += 1;
    }
    const averageRank = (position + end) / 2 / (indexed.length - 1);
    for (let current = position; current <= end; current += 1) {
      const originalIndex = indexed[current]?.index;
      if (originalIndex !== undefined) {
        result[originalIndex] = averageRank;
      }
    }
    position = end + 1;
  }
  return result;
}

function applyDemandScores(metrics: NormalizedMetric[]): void {
  if (metrics.length < 10) {
    return;
  }
  const searchRanks = percentileRanks(metrics.map((metric) => metric.searchCount));
  const cartRanks = percentileRanks(metrics.map((metric) => metric.cartRate));
  const orderRanks = percentileRanks(metrics.map((metric) => metric.orderRate));
  for (let index = 0; index < metrics.length; index += 1) {
    metrics[index]!.demandScore = Math.round(
      100 * (0.45 * searchRanks[index]! + 0.2 * cartRanks[index]! + 0.35 * orderRanks[index]!),
    );
  }
}

function normalizeRows(
  rows: string[][],
  mapping: SelectionImportMapping,
): { metrics: NormalizedMetric[]; errors: SelectionImportError[] } {
  const [headers = [], ...dataRows] = rows;
  const phraseIndex = columnIndex(headers, mapping.phrase);
  const searchIndex = columnIndex(headers, mapping.searchCount);
  const cartIndex = columnIndex(headers, mapping.cartRate);
  const orderIndex = columnIndex(headers, mapping.orderRate);
  const priceIndex = mapping.averagePrice ? columnIndex(headers, mapping.averagePrice) : null;
  const seen = new Set<string>();
  const metrics: NormalizedMetric[] = [];
  const errors: SelectionImportError[] = [];

  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index] ?? [];
    const rowNumber = index + 2;
    try {
      const phrase = (row[phraseIndex] ?? "").trim();
      const normalizedPhrase = normalizePhrase(phrase);
      if (!normalizedPhrase) {
        throw new Error("搜索词不能为空");
      }
      if (seen.has(normalizedPhrase)) {
        throw new Error("搜索词在文件中重复");
      }
      seen.add(normalizedPhrase);
      const averagePriceText = priceIndex === null ? "" : row[priceIndex] ?? "";
      metrics.push({
        phrase,
        normalizedPhrase,
        searchCount: integerValue(row[searchIndex] ?? "", "搜索次数"),
        cartRate: rateValue(row[cartIndex] ?? "", mapping.cartRateUnit, "加购转化率"),
        orderRate: rateValue(row[orderIndex] ?? "", mapping.orderRateUnit, "下单转化率"),
        averagePriceMinor: averagePriceText.trim() ? moneyMinorUnits(averagePriceText) : null,
        demandScore: null,
      });
    } catch (error) {
      errors.push({ row: rowNumber, message: error instanceof Error ? error.message : "无法解析该行" });
    }
  }
  applyDemandScores(metrics);
  return { metrics, errors };
}

function orderBy(sort: SelectionKeywordSort): string {
  const columns: Record<SelectionKeywordSort, string> = {
    demandScore: "s.demand_score DESC NULLS LAST, s.search_count DESC",
    searchCount: "s.search_count DESC",
    cartRate: "s.cart_rate DESC",
    orderRate: "s.order_rate DESC",
    averagePrice: "s.average_price_minor DESC NULLS LAST",
  };
  return columns[sort];
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function offsetMonthKey(date: Date, offset: number): string {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
}

function growth(current: number, previous: number | undefined): number | null {
  if (previous === undefined || previous === 0) {
    return null;
  }
  return (current - previous) / previous;
}

function profileGrowth(profile: WordstatProfile): { growth3m: number | null; growth12m: number | null; trend: WordstatTrend } {
  const sorted = [...profile.dynamics].sort((left, right) => left.date.localeCompare(right.date));
  const latest = sorted.at(-1);
  if (!latest) {
    return { growth3m: null, growth12m: null, trend: "stable" };
  }
  const values = new Map(sorted.map((point) => [monthKey(point.date), point.count]));
  const latestDate = new Date(latest.date);
  const growth3m = growth(latest.count, values.get(offsetMonthKey(latestDate, -3)));
  const growth12m = growth(latest.count, values.get(offsetMonthKey(latestDate, -12)));
  let trend: WordstatTrend = "stable";
  if (growth3m !== null && growth3m >= 0.15) {
    trend = "rising";
  } else if (growth3m !== null && growth3m <= -0.15) {
    trend = "falling";
  }
  return { growth3m, growth12m, trend };
}

function optionalText(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function normalizeOzonUrl(value: string | null | undefined): { url: string | null; productId: string | null } {
  const input = optionalText(value);
  if (!input) {
    return { url: null, productId: null };
  }
  const url = new URL(input);
  if (url.protocol !== "https:" || (url.hostname !== "ozon.ru" && !url.hostname.endsWith(".ozon.ru"))) {
    throw new Error("商品链接必须是 Ozon HTTPS 地址");
  }
  const productId = url.pathname.match(/(?:-|\/)(\d{6,})(?:\/|$)/)?.[1] ?? null;
  if (!productId) {
    throw new Error("无法从 Ozon 商品链接识别商品 ID");
  }
  url.search = "";
  url.hash = "";
  return { url: url.toString(), productId };
}

function candidateFromRow(row: CandidateRow): SelectionCandidate {
  const marketProduct = row.market_product_id && row.market_ozon_product_id && row.market_name
    && row.market_ozon_url && row.market_seller !== null && row.market_brand !== null
    && row.market_category_level_1 !== null && row.market_category_level_3 !== null
    && row.market_product_flags !== null && row.market_snapshot_date !== null
    && row.market_report_period_days !== null && row.market_ordered_amount_minor !== null
    && row.market_ordered_units !== null && row.market_average_price_minor !== null
    && row.market_impression_to_order_rate !== null && row.market_missed_sales !== null
    ? {
        id: row.market_product_id,
        ozonProductId: row.market_ozon_product_id,
        name: row.market_name,
        ozonUrl: row.market_ozon_url,
        seller: row.market_seller,
        brand: row.market_brand,
        categoryLevel1: row.market_category_level_1,
        categoryLevel3: row.market_category_level_3,
        productFlags: JSON.parse(row.market_product_flags) as string[],
        snapshotDate: row.market_snapshot_date,
        reportPeriodDays: row.market_report_period_days,
        orderedAmount: rubMoney(row.market_ordered_amount_minor),
        turnoverGrowth: row.market_turnover_growth,
        orderedUnits: row.market_ordered_units,
        averagePrice: rubMoney(row.market_average_price_minor),
        impressionToOrderRate: row.market_impression_to_order_rate,
        missedSales: row.market_missed_sales,
        outOfStockDays: row.market_out_of_stock_days,
      }
    : null;
  return {
    id: row.id,
    name: row.name,
    ozonUrl: row.ozon_url,
    category: row.category,
    targetPrice: row.target_price_minor === null
      ? null
      : { amount: minorUnitsToAmount(row.target_price_minor), currency: "RUB" },
    status: row.status,
    decisionReason: row.decision_reason,
    note: row.note,
    keyword: row.keyword_id && row.keyword_phrase ? {
      id: row.keyword_id,
      phrase: row.keyword_phrase,
      demandScore: row.keyword_demand_score,
    } : null,
    marketProduct,
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
}

function rubMoney(minorUnits: number): { amount: string; currency: "RUB" } {
  return { amount: minorUnitsToAmount(minorUnits), currency: "RUB" };
}

function marketProductListItem(row: MarketProductRow): SelectionMarketProductListItem {
  return {
    id: row.id,
    ozonProductId: row.ozon_product_id,
    name: row.name,
    ozonUrl: row.ozon_url,
    seller: row.seller,
    brand: row.brand,
    categoryLevel1: row.category_level_1,
    categoryLevel3: row.category_level_3,
    productFlags: JSON.parse(row.product_flags) as string[],
    snapshotDate: row.snapshot_date,
    reportPeriodDays: row.report_period_days,
    orderedAmount: rubMoney(row.ordered_amount_minor),
    turnoverGrowth: row.turnover_growth,
    orderedUnits: row.ordered_units,
    averagePrice: rubMoney(row.average_price_minor),
    impressionToOrderRate: row.impression_to_order_rate,
    missedSales: row.missed_sales,
    outOfStockDays: row.out_of_stock_days,
  };
}

function marketProductSnapshot(row: MarketProductRow): SelectionMarketProductSnapshot {
  return {
    ...marketProductListItem(row),
    minimumPrice: rubMoney(row.minimum_price_minor),
    purchaseRate: row.purchase_rate,
    dailySalesAmount: rubMoney(row.daily_sales_amount_minor),
    dailySalesUnits: row.daily_sales_units,
    endingInventoryUnits: row.ending_inventory_units,
    fulfillmentScheme: row.fulfillment_scheme,
    volumeLiters: row.volume_liters,
    impressions: row.impressions,
    searchCatalogViews: row.search_catalog_views,
    cardViews: row.card_views,
    searchCatalogCartRate: row.search_catalog_cart_rate,
    cardCartRate: row.card_cart_rate,
    promotionDiscountRate: row.promotion_discount_rate,
    promotedOrderShare: row.promoted_order_share,
    promotionDays: row.promotion_days,
    advertisedDays: row.advertised_days,
    advertisingCostShare: row.advertising_cost_share,
    productCardCreatedDate: row.product_card_created_date,
  };
}

function marketProductOrderBy(sort: SelectionMarketProductSort): string {
  const columns: Record<SelectionMarketProductSort, string> = {
    orderedAmount: "s.ordered_amount_minor DESC",
    orderedUnits: "s.ordered_units DESC",
    turnoverGrowth: "s.turnover_growth DESC NULLS LAST",
    missedSales: "s.missed_sales DESC",
    conversionRate: "s.impression_to_order_rate DESC",
    averagePrice: "s.average_price_minor DESC",
  };
  return columns[sort];
}

/** Owns report normalization, opportunity analysis, Wordstat enrichment, and candidate decisions. */
export class SelectionModule {
  private readonly settings: SettingsRepository;
  private readonly wordstatFactory: (folderId: string, apiKey: string) => WordstatPort;
  private readonly activeJobs = new Map<string, Promise<void>>();
  private started = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    options: SelectionModuleOptions = {},
  ) {
    this.settings = new SettingsRepository(database);
    this.wordstatFactory = options.wordstatFactory ?? ((folderId, apiKey) => new WordstatClient({ folderId, apiKey }));
    this.database.function("selection_contains", { deterministic: true }, containsNormalizedText);
  }

  /** Parses an import in memory and returns only the data needed for column mapping. */
  public async previewImport(file: SelectionImportFile): Promise<SelectionImportPreview> {
    const { fileType, sheets, selectedSheet, rows, rowNumbers } = await parseImport(file);
    const productReport = detectMarketProductReport(rows, file.fileName, rowNumbers);
    if (productReport) {
      const dataRows = productReport.dataRows.filter((row) => row[0]?.trim() !== "Среднее значение по товарам");
      return {
        kind: "market_product",
        fileName: file.fileName,
        fileType,
        sheets,
        selectedSheet,
        detectedSnapshotDate: productReport.detectedSnapshotDate,
        reportPeriodDays: productReport.reportPeriodDays,
        headers: productReport.headers,
        sampleRows: dataRows.slice(0, SAMPLE_ROW_COUNT),
        totalDataRows: dataRows.length,
      };
    }
    const [headers = [], ...dataRows] = rows;
    if (headers.length === 0) {
      throw new Error("导入文件没有可识别的表头");
    }
    return {
      kind: "keyword",
      fileName: file.fileName,
      fileType,
      sheets,
      selectedSheet,
      detectedSnapshotDate: null,
      reportPeriodDays: null,
      headers,
      sampleRows: dataRows.slice(0, SAMPLE_ROW_COUNT),
      totalDataRows: dataRows.length,
    };
  }

  /** Validates and atomically persists one immutable Ozon keyword snapshot. */
  public async commitImport(request: SelectionImportRequest): Promise<SelectionImportResult> {
    const parsed = await parseImport(request);
    const productReport = detectMarketProductReport(parsed.rows, request.fileName, parsed.rowNumbers);
    if (productReport) {
      return this.commitMarketProductImport(request, parsed.selectedSheet, productReport);
    }
    if (!request.mapping) {
      throw new Error("关键词报表必须完成字段映射");
    }
    const { metrics, errors } = normalizeRows(parsed.rows, request.mapping);
    if (metrics.length === 0) {
      throw new Error("导入文件没有有效数据行");
    }
    const fileHash = createHash("sha256").update(request.content).digest("hex");
    const importId = randomUUID();
    const now = Date.now();
    const persist = this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO selection_imports
          (id, kind, file_name, file_hash, snapshot_date, sheet_name, mapping_json,
           report_period_days, valid_rows, skipped_rows, created_at_ms)
         VALUES (?, 'keyword', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        importId,
        request.fileName,
        fileHash,
        request.snapshotDate,
        parsed.selectedSheet,
        JSON.stringify(request.mapping),
        metrics.length,
        errors.length,
        now,
      );
      const findKeyword = this.database.prepare<[string], { id: string }>(
        "SELECT id FROM selection_keywords WHERE normalized_phrase = ?",
      );
      const insertKeyword = this.database.prepare(
        `INSERT INTO selection_keywords (id, phrase, normalized_phrase, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      );
      const updateKeyword = this.database.prepare(
        "UPDATE selection_keywords SET phrase = ?, updated_at_ms = ? WHERE id = ?",
      );
      const insertSnapshot = this.database.prepare(
        `INSERT INTO selection_keyword_snapshots
          (id, keyword_id, import_id, search_count, cart_rate, order_rate, average_price_minor, demand_score, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const metric of metrics) {
        const existing = findKeyword.get(metric.normalizedPhrase);
        const keywordId = existing?.id ?? randomUUID();
        if (existing) {
          updateKeyword.run(metric.phrase, now, keywordId);
        } else {
          insertKeyword.run(keywordId, metric.phrase, metric.normalizedPhrase, now, now);
        }
        insertSnapshot.run(
          randomUUID(),
          keywordId,
          importId,
          metric.searchCount,
          metric.cartRate,
          metric.orderRate,
          metric.averagePriceMinor,
          metric.demandScore,
          now,
        );
      }
    });
    persist();
    return { id: importId, kind: "keyword", validRows: metrics.length, skippedRows: errors.length, errors: errors.slice(0, 20) };
  }

  /** Persists one immutable Ozon all-market product snapshot without retaining the workbook. */
  private commitMarketProductImport(
    request: SelectionImportRequest,
    selectedSheet: string,
    report: MarketProductReportDetection,
  ): SelectionImportResult {
    if (report.reportPeriodDays === null) {
      throw new Error("无法识别商品报表统计周期");
    }
    const { products, errors } = normalizeMarketProductRows(report);
    if (products.length === 0) {
      throw new Error("商品报表没有有效数据行");
    }
    const fileHash = createHash("sha256").update(request.content).digest("hex");
    const importId = randomUUID();
    const now = Date.now();
    const persist = this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO selection_imports
          (id, kind, file_name, file_hash, snapshot_date, sheet_name, mapping_json,
           report_period_days, valid_rows, skipped_rows, created_at_ms)
         VALUES (?, 'market_product', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        importId,
        request.fileName,
        fileHash,
        request.snapshotDate,
        selectedSheet,
        JSON.stringify({ format: "ozon_market_product_all_metrics" }),
        report.reportPeriodDays,
        products.length,
        errors.length,
        now,
      );
      const findProduct = this.database.prepare<[string], { id: string }>(
        "SELECT id FROM selection_market_products WHERE ozon_product_id = ?",
      );
      const insertProduct = this.database.prepare(
        `INSERT INTO selection_market_products
          (id, ozon_product_id, name, ozon_url, seller, brand, category_level_1, category_level_3,
           product_flags, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updateProduct = this.database.prepare(
        `UPDATE selection_market_products
         SET name = ?, ozon_url = ?, seller = ?, brand = ?, category_level_1 = ?, category_level_3 = ?,
             product_flags = ?, updated_at_ms = ?
         WHERE id = ?`,
      );
      const insertSnapshot = this.database.prepare(
        `INSERT INTO selection_market_product_snapshots
          (id, product_id, import_id, ordered_amount_minor, turnover_growth, ordered_units,
           average_price_minor, minimum_price_minor, purchase_rate, missed_sales, out_of_stock_days,
           daily_sales_amount_minor, daily_sales_units, ending_inventory_units, fulfillment_scheme,
           volume_liters, impressions, search_catalog_views, card_views, impression_to_order_rate,
           search_catalog_cart_rate, card_cart_rate, promotion_discount_rate, promoted_order_share,
           promotion_days, advertised_days, advertising_cost_share, product_card_created_date, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const product of products) {
        const existing = findProduct.get(product.ozonProductId);
        const productId = existing?.id ?? randomUUID();
        const flags = JSON.stringify(product.productFlags);
        if (existing) {
          updateProduct.run(
            product.name,
            product.ozonUrl,
            product.seller,
            product.brand,
            product.categoryLevel1,
            product.categoryLevel3,
            flags,
            now,
            productId,
          );
        } else {
          insertProduct.run(
            productId,
            product.ozonProductId,
            product.name,
            product.ozonUrl,
            product.seller,
            product.brand,
            product.categoryLevel1,
            product.categoryLevel3,
            flags,
            now,
            now,
          );
        }
        this.insertMarketProductSnapshot(insertSnapshot, productId, importId, product, now);
      }
    });
    persist();
    return {
      id: importId,
      kind: "market_product",
      validRows: products.length,
      skippedRows: errors.length,
      errors: errors.slice(0, 20),
    };
  }

  private insertMarketProductSnapshot(
    statement: Statement<unknown[]>,
    productId: string,
    importId: string,
    product: NormalizedMarketProduct,
    now: number,
  ): void {
    statement.run(
      randomUUID(),
      productId,
      importId,
      product.orderedAmountMinor,
      product.turnoverGrowth,
      product.orderedUnits,
      product.averagePriceMinor,
      product.minimumPriceMinor,
      product.purchaseRate,
      product.missedSales,
      product.outOfStockDays,
      product.dailySalesAmountMinor,
      product.dailySalesUnits,
      product.endingInventoryUnits,
      product.fulfillmentScheme,
      product.volumeLiters,
      product.impressions,
      product.searchCatalogViews,
      product.cardViews,
      product.impressionToOrderRate,
      product.searchCatalogCartRate,
      product.cardCartRate,
      product.promotionDiscountRate,
      product.promotedOrderShare,
      product.promotionDays,
      product.advertisedDays,
      product.advertisingCostShare,
      product.productCardCreatedDate,
      now,
    );
  }

  /** Returns the newest Ozon snapshot for each keyword using bounded filters and sorting. */
  public listKeywords(query: SelectionKeywordQuery): SelectionKeywordPage {
    const where: string[] = ["1 = 1"];
    const parameters: Array<number | string> = [];
    if (query.search?.trim()) {
      where.push("k.normalized_phrase LIKE ? ESCAPE '\\'");
      const escaped = normalizePhrase(query.search).replace(/[\\%_]/g, "\\$&");
      parameters.push(`%${escaped}%`);
    }
    if (query.minimumPrice !== undefined) {
      where.push("s.average_price_minor >= ?");
      parameters.push(Math.round(query.minimumPrice * 100));
    }
    if (query.maximumPrice !== undefined) {
      where.push("s.average_price_minor <= ?");
      parameters.push(Math.round(query.maximumPrice * 100));
    }
    const joins = `FROM selection_keywords k
      JOIN selection_keyword_snapshots s ON s.id = (
        SELECT snapshot.id
        FROM selection_keyword_snapshots snapshot
        JOIN selection_imports imported ON imported.id = snapshot.import_id
        WHERE snapshot.keyword_id = k.id
        ORDER BY imported.snapshot_date DESC, imported.created_at_ms DESC
        LIMIT 1
      )
      JOIN selection_imports i ON i.id = s.import_id`;
    const count = this.database.prepare(`SELECT COUNT(*) AS total ${joins} WHERE ${where.join(" AND ")}`)
      .get(...parameters) as { total: number };
    const offset = (query.page - 1) * query.pageSize;
    const rows = this.database.prepare(
      `SELECT k.id, k.phrase, i.snapshot_date, s.search_count, s.cart_rate, s.order_rate,
              s.average_price_minor, s.demand_score,
              CASE
                WHEN EXISTS (SELECT 1 FROM selection_wordstat_job_items ji WHERE ji.keyword_id = k.id AND ji.status IN ('queued', 'running')) THEN 'queued'
                WHEN EXISTS (SELECT 1 FROM selection_wordstat_snapshots ws WHERE ws.keyword_id = k.id) THEN 'ready'
                WHEN EXISTS (SELECT 1 FROM selection_wordstat_job_items ji WHERE ji.keyword_id = k.id AND ji.status = 'failed') THEN 'failed'
                ELSE 'missing'
              END AS wordstat_status
       ${joins}
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderBy(query.sort)}, k.phrase ASC
       LIMIT ? OFFSET ?`,
    ).all(...parameters, query.pageSize, offset) as KeywordListRow[];
    const items: SelectionKeywordListItem[] = rows.map((row) => ({
      id: row.id,
      phrase: row.phrase,
      snapshotDate: row.snapshot_date,
      searchCount: row.search_count,
      cartRate: row.cart_rate,
      orderRate: row.order_rate,
      averagePrice: row.average_price_minor === null
        ? null
        : { amount: minorUnitsToAmount(row.average_price_minor), currency: "RUB" },
      demandScore: row.demand_score,
      wordstatStatus: row.wordstat_status ?? "missing",
    }));
    return { items, page: query.page, pageSize: query.pageSize, total: count.total };
  }

  /** Returns one keyword with its latest Ozon and Wordstat evidence. */
  public getKeyword(id: string): SelectionKeywordDetail | null {
    const row = this.database.prepare(
      `SELECT k.id, k.phrase, i.snapshot_date, s.search_count, s.cart_rate, s.order_rate,
              s.average_price_minor, s.demand_score
       FROM selection_keywords k
       JOIN selection_keyword_snapshots s ON s.id = (
         SELECT snapshot.id FROM selection_keyword_snapshots snapshot
         JOIN selection_imports imported ON imported.id = snapshot.import_id
         WHERE snapshot.keyword_id = k.id
         ORDER BY imported.snapshot_date DESC, imported.created_at_ms DESC LIMIT 1
       )
       JOIN selection_imports i ON i.id = s.import_id
       WHERE k.id = ?`,
    ).get(id) as KeywordListRow | undefined;
    if (!row) {
      return null;
    }
    const snapshot = this.database.prepare(
      `SELECT fetched_at_ms, total_count_30d, top_requests_json, associations_json, dynamics_json,
              growth_3m, growth_12m, trend
       FROM selection_wordstat_snapshots
       WHERE keyword_id = ? ORDER BY fetched_at_ms DESC LIMIT 1`,
    ).get(id) as WordstatSnapshotRow | undefined;
    const wordstat: SelectionWordstatView | null = snapshot ? {
      fetchedAt: new Date(snapshot.fetched_at_ms).toISOString(),
      totalCount30d: snapshot.total_count_30d,
      growth3m: snapshot.growth_3m,
      growth12m: snapshot.growth_12m,
      trend: snapshot.trend,
      topRequests: JSON.parse(snapshot.top_requests_json) as SelectionWordstatView["topRequests"],
      associations: JSON.parse(snapshot.associations_json) as SelectionWordstatView["associations"],
      dynamics: JSON.parse(snapshot.dynamics_json) as SelectionWordstatView["dynamics"],
    } : null;
    return {
      id: row.id,
      phrase: row.phrase,
      snapshotDate: row.snapshot_date,
      searchCount: row.search_count,
      cartRate: row.cart_rate,
      orderRate: row.order_rate,
      averagePrice: row.average_price_minor === null
        ? null
        : { amount: minorUnitsToAmount(row.average_price_minor), currency: "RUB" },
      demandScore: row.demand_score,
      wordstatStatus: wordstat ? "ready" : "missing",
      wordstat,
    };
  }

  /** Returns the newest imported market snapshot for each Ozon product. */
  public listMarketProducts(query: SelectionMarketProductQuery): SelectionMarketProductPage {
    const where: string[] = ["1 = 1"];
    const parameters: Array<number | string> = [];
    if (query.search?.trim()) {
      where.push(`selection_contains(
        p.name || CHAR(31) || p.brand || CHAR(31) || p.seller || CHAR(31)
        || p.category_level_1 || CHAR(31) || p.category_level_3 || CHAR(31) || p.product_flags,
        ?
      ) = 1`);
      parameters.push(query.search.trim());
    }
    if (query.categoryLevel1) {
      where.push("p.category_level_1 = ?");
      parameters.push(query.categoryLevel1);
    }
    if (query.categoryLevel3) {
      where.push("p.category_level_3 = ?");
      parameters.push(query.categoryLevel3);
    }
    if (query.productFlag) {
      where.push("EXISTS (SELECT 1 FROM json_each(p.product_flags) WHERE value = ?)");
      parameters.push(query.productFlag);
    }
    if (query.minimumPrice !== undefined) {
      where.push("s.average_price_minor >= ?");
      parameters.push(Math.round(query.minimumPrice * 100));
    }
    if (query.maximumPrice !== undefined) {
      where.push("s.average_price_minor <= ?");
      parameters.push(Math.round(query.maximumPrice * 100));
    }
    const joins = this.marketProductLatestJoins();
    const count = this.database.prepare(`SELECT COUNT(*) AS total ${joins} WHERE ${where.join(" AND ")}`)
      .get(...parameters) as { total: number };
    const rows = this.database.prepare(
      `${this.marketProductSelect()} ${joins}
       WHERE ${where.join(" AND ")}
       ORDER BY ${marketProductOrderBy(query.sort)}, p.name ASC
       LIMIT ? OFFSET ?`,
    ).all(...parameters, query.pageSize, (query.page - 1) * query.pageSize) as MarketProductRow[];
    const facetRows = this.database.prepare(
      `SELECT p.category_level_1, p.category_level_3, p.product_flags
       FROM selection_market_products p
       WHERE EXISTS (SELECT 1 FROM selection_market_product_snapshots s WHERE s.product_id = p.id)`,
    ).all() as Array<{ category_level_1: string; category_level_3: string; product_flags: string }>;
    const categoryLevel1 = new Set<string>();
    const categoryLevel3 = new Set<string>();
    const productFlags = new Set<string>();
    for (const row of facetRows) {
      categoryLevel1.add(row.category_level_1);
      categoryLevel3.add(row.category_level_3);
      for (const flag of JSON.parse(row.product_flags) as string[]) {
        productFlags.add(flag);
      }
    }
    return {
      items: rows.map(marketProductListItem),
      facets: {
        categoryLevel1: [...categoryLevel1].sort((left, right) => left.localeCompare(right)),
        categoryLevel3: [...categoryLevel3].sort((left, right) => left.localeCompare(right)),
        productFlags: [...productFlags].sort((left, right) => left.localeCompare(right)),
      },
      page: query.page,
      pageSize: query.pageSize,
      total: count.total,
    };
  }

  /** Returns all official metrics plus the latest twelve manually imported snapshots. */
  public getMarketProduct(id: string): SelectionMarketProductDetail | null {
    const rows = this.database.prepare(
      `${this.marketProductSelect()}
       FROM selection_market_products p
       JOIN selection_market_product_snapshots s ON s.product_id = p.id
       JOIN selection_imports i ON i.id = s.import_id
       WHERE p.id = ?
       ORDER BY i.snapshot_date DESC, i.created_at_ms DESC
       LIMIT 12`,
    ).all(id) as MarketProductRow[];
    const latest = rows[0];
    if (!latest) {
      return null;
    }
    return { ...marketProductSnapshot(latest), history: rows.map(marketProductSnapshot) };
  }

  public viewWordstatSettings(): WordstatSettingsView {
    const folderId = this.settings.get(WORDSTAT_FOLDER_KEY);
    const hasApiKey = Boolean(this.settings.get(WORDSTAT_API_KEY));
    return { configured: Boolean(folderId && hasApiKey), folderId, hasApiKey };
  }

  /** Persists a Yandex service-account key using the application encryption key. */
  public updateWordstatSettings(input: { folderId: string; apiKey?: string | undefined }): WordstatSettingsView {
    const folderId = input.folderId.trim();
    if (!folderId) {
      throw new Error("Folder ID 不能为空");
    }
    if (input.apiKey !== undefined) {
      const apiKey = input.apiKey.trim();
      if (!apiKey) {
        throw new Error("API Key 不能为空");
      }
      this.settings.set(WORDSTAT_API_KEY, encryptSecret(apiKey, this.config.ENCRYPTION_KEY));
    }
    if (!this.settings.get(WORDSTAT_API_KEY)) {
      throw new Error("首次配置必须填写 API Key");
    }
    this.settings.set(WORDSTAT_FOLDER_KEY, folderId);
    return this.viewWordstatSettings();
  }

  public async testWordstatConnection(): Promise<void> {
    await this.createWordstat().testConnection();
  }

  /** Creates a persisted, explicitly requested Wordstat enrichment job. */
  public enqueueWordstat(input: { keywordIds: string[]; force: boolean }): WordstatJobView {
    this.createWordstat();
    const keywordIds = [...new Set(input.keywordIds)];
    if (keywordIds.length === 0 || keywordIds.length > 100) {
      throw new Error("每次请选择 1 到 100 个关键词");
    }
    const jobId = randomUUID();
    const now = Date.now();
    const cacheBoundary = now - WORDSTAT_CACHE_MS;
    const persist = this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO selection_wordstat_jobs (id, status, force_refresh, created_at_ms)
         VALUES (?, 'queued', ?, ?)`,
      ).run(jobId, input.force ? 1 : 0, now);
      const keywordExists = this.database.prepare<[string], { id: string }>("SELECT id FROM selection_keywords WHERE id = ?");
      const freshSnapshot = this.database.prepare<[string, number], { id: string }>(
        `SELECT id FROM selection_wordstat_snapshots
         WHERE keyword_id = ? AND fetched_at_ms >= ? ORDER BY fetched_at_ms DESC LIMIT 1`,
      );
      const insertItem = this.database.prepare(
        `INSERT INTO selection_wordstat_job_items (job_id, keyword_id, status)
         VALUES (?, ?, ?)`,
      );
      let queued = 0;
      for (const keywordId of keywordIds) {
        if (!keywordExists.get(keywordId)) {
          throw new Error(`关键词不存在：${keywordId}`);
        }
        const cached = !input.force && freshSnapshot.get(keywordId, cacheBoundary);
        insertItem.run(jobId, keywordId, cached ? "completed" : "queued");
        if (!cached) {
          queued += 1;
        }
      }
      if (queued === 0) {
        this.database.prepare(
          "UPDATE selection_wordstat_jobs SET status = 'completed', finished_at_ms = ? WHERE id = ?",
        ).run(now, jobId);
      }
    });
    persist();
    if (this.started) {
      this.scheduleJob(jobId);
    }
    return this.getWordstatJob(jobId);
  }

  public getWordstatJob(id: string): WordstatJobView {
    const row = this.database.prepare(
      `SELECT j.id, j.status, j.created_at_ms, j.finished_at_ms,
              COUNT(ji.keyword_id) AS total,
              SUM(CASE WHEN ji.status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN ji.status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM selection_wordstat_jobs j
       JOIN selection_wordstat_job_items ji ON ji.job_id = j.id
       WHERE j.id = ? GROUP BY j.id`,
    ).get(id) as WordstatJobRow | undefined;
    if (!row) {
      throw new Error("Wordstat 任务不存在");
    }
    return this.jobFromRow(row);
  }

  /** Resumes explicitly queued jobs; it never creates scheduled monitoring work. */
  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.database.prepare("UPDATE selection_wordstat_job_items SET status = 'queued' WHERE status = 'running'").run();
    this.database.prepare("UPDATE selection_wordstat_jobs SET status = 'queued' WHERE status = 'running'").run();
    const jobs = this.database.prepare("SELECT id FROM selection_wordstat_jobs WHERE status = 'queued'").all() as Array<{ id: string }>;
    if (jobs.length > 0) {
      this.scheduleJob(jobs[0]!.id);
    }
  }

  public async stop(): Promise<void> {
    this.started = false;
    await Promise.allSettled(this.activeJobs.values());
  }

  /** Adds one concrete product idea to the manual decision workflow. */
  public createCandidate(input: SelectionCandidateCreateInput): SelectionCandidate {
    const name = input.name.trim();
    if (!name) {
      throw new Error("候选商品名称不能为空");
    }
    this.assertKeyword(input.keywordId);
    this.assertMarketProduct(input.marketProductId);
    const ozon = normalizeOzonUrl(input.ozonUrl);
    if (ozon.productId && this.findCandidateByProductId(ozon.productId)) {
      throw new Error("该 Ozon 商品已经在候选池中");
    }
    const id = randomUUID();
    const now = Date.now();
    const targetPriceMinor = input.targetPrice?.trim() ? moneyMinorUnits(input.targetPrice) : null;
    this.database.prepare(
      `INSERT INTO selection_candidates
        (id, keyword_id, market_product_id, name, ozon_url, ozon_product_id, category, target_price_minor,
         status, decision_reason, note, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'watching', NULL, ?, ?, ?)`,
    ).run(
      id, input.keywordId ?? null, input.marketProductId ?? null, name, ozon.url, ozon.productId, optionalText(input.category),
      targetPriceMinor, optionalText(input.note), now, now,
    );
    return this.getCandidate(id)!;
  }

  /** Updates editable evidence and the explicit observe/recommend/reject decision. */
  public updateCandidate(id: string, input: SelectionCandidateUpdateInput): SelectionCandidate {
    const current = this.getCandidate(id);
    if (!current) {
      throw new Error("候选商品不存在");
    }
    const name = input.name === undefined ? current.name : input.name.trim();
    if (!name) {
      throw new Error("候选商品名称不能为空");
    }
    const keywordId = input.keywordId === undefined ? current.keyword?.id ?? null : input.keywordId;
    this.assertKeyword(keywordId ?? undefined);
    const marketProductId = input.marketProductId === undefined ? current.marketProduct?.id ?? null : input.marketProductId;
    this.assertMarketProduct(marketProductId ?? undefined);
    const requestedUrl = input.ozonUrl === undefined ? current.ozonUrl : input.ozonUrl;
    const ozon = normalizeOzonUrl(requestedUrl);
    const duplicate = ozon.productId ? this.findCandidateByProductId(ozon.productId) : null;
    if (duplicate && duplicate.id !== id) {
      throw new Error("该 Ozon 商品已经在候选池中");
    }
    let targetPriceMinor = current.targetPrice ? moneyMinorUnits(current.targetPrice.amount) : null;
    if (input.targetPrice !== undefined) {
      targetPriceMinor = input.targetPrice?.trim() ? moneyMinorUnits(input.targetPrice) : null;
    }
    this.database.prepare(
      `UPDATE selection_candidates
       SET keyword_id = ?, market_product_id = ?, name = ?, ozon_url = ?, ozon_product_id = ?, category = ?,
           target_price_minor = ?, status = ?, decision_reason = ?, note = ?, updated_at_ms = ?
       WHERE id = ?`,
    ).run(
      keywordId,
      marketProductId,
      name,
      ozon.url,
      ozon.productId,
      input.category === undefined ? current.category : optionalText(input.category),
      targetPriceMinor,
      input.status ?? current.status,
      input.decisionReason === undefined ? current.decisionReason : optionalText(input.decisionReason),
      input.note === undefined ? current.note : optionalText(input.note),
      Date.now(),
      id,
    );
    return this.getCandidate(id)!;
  }

  public listCandidates(filters: {
    status?: SelectionCandidateStatus | undefined;
    search?: string | undefined;
  } = {}): SelectionCandidate[] {
    const where: string[] = ["1 = 1"];
    const parameters: string[] = [];
    if (filters.status) {
      where.push("c.status = ?");
      parameters.push(filters.status);
    }
    if (filters.search?.trim()) {
      where.push("(c.name LIKE ? OR c.category LIKE ? OR k.phrase LIKE ? OR mp.brand LIKE ? OR mp.seller LIKE ?)");
      const search = `%${filters.search.trim()}%`;
      parameters.push(search, search, search, search, search);
    }
    const rows = this.database.prepare(
      `${this.candidateSelect()} WHERE ${where.join(" AND ")} ORDER BY c.updated_at_ms DESC, c.name ASC`,
    ).all(...parameters) as CandidateRow[];
    return rows.map(candidateFromRow);
  }

  public getCandidate(id: string): SelectionCandidate | null {
    const row = this.database.prepare(`${this.candidateSelect()} WHERE c.id = ?`).get(id) as CandidateRow | undefined;
    return row ? candidateFromRow(row) : null;
  }

  public getOverview(): SelectionOverview {
    const keywordCounts = this.database.prepare(
      `SELECT COUNT(DISTINCT k.id) AS total,
              COUNT(DISTINCT CASE WHEN s.demand_score IS NOT NULL THEN k.id END) AS scored
       FROM selection_keywords k
       JOIN selection_keyword_snapshots s ON s.keyword_id = k.id`,
    ).get() as { total: number; scored: number };
    const wordstat = this.database.prepare(
      "SELECT COUNT(DISTINCT keyword_id) AS total FROM selection_wordstat_snapshots",
    ).get() as { total: number };
    const marketProducts = this.database.prepare(
      `SELECT COUNT(DISTINCT s.product_id) AS total, MAX(i.snapshot_date) AS latest_snapshot_date
       FROM selection_market_product_snapshots s
       JOIN selection_imports i ON i.id = s.import_id`,
    ).get() as { total: number; latest_snapshot_date: string | null };
    const discoveryProducts = this.database.prepare(
      `SELECT COUNT(DISTINCT r.product_id) AS total, MAX(b.collected_at_ms) AS collected_at_ms
       FROM selection_market_product_rankings r
       JOIN selection_discovery_batches b ON b.id = r.batch_id
       WHERE r.scope = 'global' AND r.period_days = 28
         AND b.id = (SELECT id FROM selection_discovery_batches ORDER BY collected_at_ms DESC LIMIT 1)`,
    ).get() as { total: number; collected_at_ms: number | null };
    const candidateRows = this.database.prepare(
      "SELECT status, COUNT(*) AS total FROM selection_candidates GROUP BY status",
    ).all() as Array<{ status: SelectionCandidateStatus; total: number }>;
    const candidateCounts: SelectionOverview["candidateCounts"] = { watching: 0, recommended: 0, rejected: 0 };
    for (const row of candidateRows) {
      candidateCounts[row.status] = row.total;
    }
    const latest = this.database.prepare(
      "SELECT created_at_ms FROM selection_imports ORDER BY created_at_ms DESC LIMIT 1",
    ).get() as { created_at_ms: number } | undefined;
    return {
      keywordCount: keywordCounts.total,
      scoredKeywordCount: keywordCounts.scored,
      marketProductCount: discoveryProducts.total || marketProducts.total,
      latestMarketProductSnapshotDate: discoveryProducts.collected_at_ms
        ? new Date(discoveryProducts.collected_at_ms).toISOString().slice(0, 10)
        : marketProducts.latest_snapshot_date,
      wordstatReadyCount: wordstat.total,
      candidateCounts,
      lastImportAt: latest ? new Date(latest.created_at_ms).toISOString() : null,
    };
  }

  public listImports(): SelectionImportView[] {
    const rows = this.database.prepare(
      `SELECT id, kind, file_name, snapshot_date, sheet_name, report_period_days,
              valid_rows, skipped_rows, created_at_ms
       FROM selection_imports ORDER BY created_at_ms DESC`,
    ).all() as SelectionImportRow[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      fileName: row.file_name,
      snapshotDate: row.snapshot_date,
      sheetName: row.sheet_name,
      reportPeriodDays: row.report_period_days,
      validRows: row.valid_rows,
      skippedRows: row.skipped_rows,
      createdAt: new Date(row.created_at_ms).toISOString(),
    }));
  }

  /** Deletes a mistaken imported snapshot while retaining manually curated candidates. */
  public deleteImport(id: string): boolean {
    return this.database.prepare("DELETE FROM selection_imports WHERE id = ?").run(id).changes > 0;
  }

  public listWordstatJobs(limit = 20): WordstatJobView[] {
    const rows = this.database.prepare(
      `SELECT j.id, j.status, j.created_at_ms, j.finished_at_ms,
              COUNT(ji.keyword_id) AS total,
              SUM(CASE WHEN ji.status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN ji.status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM selection_wordstat_jobs j
       JOIN selection_wordstat_job_items ji ON ji.job_id = j.id
       GROUP BY j.id ORDER BY j.created_at_ms DESC LIMIT ?`,
    ).all(limit) as WordstatJobRow[];
    return rows.map((row) => this.jobFromRow(row));
  }

  private createWordstat(): WordstatPort {
    const folderId = this.settings.get(WORDSTAT_FOLDER_KEY);
    const ciphertext = this.settings.get(WORDSTAT_API_KEY);
    if (!folderId || !ciphertext) {
      throw new Error("请先配置 Wordstat Folder ID 和 API Key");
    }
    return this.wordstatFactory(folderId, decryptSecret(ciphertext, this.config.ENCRYPTION_KEY));
  }

  private jobFromRow(row: WordstatJobRow): WordstatJobView {
    return {
      id: row.id,
      status: row.status,
      total: row.total,
      completed: row.completed,
      failed: row.failed,
      createdAt: new Date(row.created_at_ms).toISOString(),
      finishedAt: row.finished_at_ms === null ? null : new Date(row.finished_at_ms).toISOString(),
    };
  }

  private assertKeyword(keywordId?: string): void {
    if (!keywordId) {
      return;
    }
    const keyword = this.database.prepare("SELECT id FROM selection_keywords WHERE id = ?").get(keywordId);
    if (!keyword) {
      throw new Error("关联关键词不存在");
    }
  }

  private assertMarketProduct(productId?: string): void {
    if (!productId) {
      return;
    }
    const product = this.database.prepare("SELECT id FROM selection_market_products WHERE id = ?").get(productId);
    if (!product) {
      throw new Error("关联热销商品不存在");
    }
  }

  private findCandidateByProductId(productId: string): { id: string } | null {
    return this.database.prepare("SELECT id FROM selection_candidates WHERE ozon_product_id = ?")
      .get(productId) as { id: string } | undefined ?? null;
  }

  private candidateSelect(): string {
    return `SELECT c.id, c.keyword_id, c.market_product_id, c.name, c.ozon_url, c.category, c.target_price_minor,
                   c.status, c.decision_reason, c.note, c.created_at_ms, c.updated_at_ms,
                   k.phrase AS keyword_phrase,
                   (SELECT snapshot.demand_score FROM selection_keyword_snapshots snapshot
                    JOIN selection_imports imported ON imported.id = snapshot.import_id
                    WHERE snapshot.keyword_id = k.id
                    ORDER BY imported.snapshot_date DESC, imported.created_at_ms DESC LIMIT 1) AS keyword_demand_score,
                   mp.ozon_product_id AS market_ozon_product_id, mp.name AS market_name,
                   mp.ozon_url AS market_ozon_url, mp.seller AS market_seller, mp.brand AS market_brand,
                   mp.category_level_1 AS market_category_level_1, mp.category_level_3 AS market_category_level_3,
                   mp.product_flags AS market_product_flags,
                   COALESCE(mi.snapshot_date, date(db.collected_at_ms / 1000, 'unixepoch')) AS market_snapshot_date,
                   COALESCE(mi.report_period_days, dr.period_days) AS market_report_period_days,
                   COALESCE(ms.ordered_amount_minor, dr.ordered_amount_minor) AS market_ordered_amount_minor,
                   COALESCE(ms.turnover_growth, dr.turnover_growth) AS market_turnover_growth,
                   COALESCE(ms.ordered_units, dr.ordered_units) AS market_ordered_units,
                   COALESCE(ms.average_price_minor, dr.average_price_minor) AS market_average_price_minor,
                   COALESCE(ms.impression_to_order_rate, dr.impression_to_order_rate) AS market_impression_to_order_rate,
                   COALESCE(ms.missed_sales, dr.missed_sales_minor / 100) AS market_missed_sales,
                   COALESCE(ms.out_of_stock_days, dr.out_of_stock_days) AS market_out_of_stock_days
            FROM selection_candidates c
            LEFT JOIN selection_keywords k ON k.id = c.keyword_id
            LEFT JOIN selection_market_products mp ON mp.id = c.market_product_id
            LEFT JOIN selection_market_product_snapshots ms ON ms.id = (
              SELECT snapshot.id FROM selection_market_product_snapshots snapshot
              JOIN selection_imports imported ON imported.id = snapshot.import_id
              WHERE snapshot.product_id = mp.id
              ORDER BY imported.snapshot_date DESC, imported.created_at_ms DESC LIMIT 1
            )
            LEFT JOIN selection_imports mi ON mi.id = ms.import_id
            LEFT JOIN selection_market_product_rankings dr ON dr.id = (
              SELECT ranking.id FROM selection_market_product_rankings ranking
              JOIN selection_discovery_batches batch ON batch.id = ranking.batch_id
              WHERE ranking.product_id = mp.id
              ORDER BY batch.collected_at_ms DESC, ranking.period_days DESC,
                       ranking.scope = 'global' DESC, ranking.rank ASC LIMIT 1
            )
            LEFT JOIN selection_discovery_batches db ON db.id = dr.batch_id`;
  }

  private marketProductLatestJoins(): string {
    return `FROM selection_market_products p
      JOIN selection_market_product_snapshots s ON s.id = (
        SELECT snapshot.id FROM selection_market_product_snapshots snapshot
        JOIN selection_imports imported ON imported.id = snapshot.import_id
        WHERE snapshot.product_id = p.id
        ORDER BY imported.snapshot_date DESC, imported.created_at_ms DESC LIMIT 1
      )
      JOIN selection_imports i ON i.id = s.import_id`;
  }

  private marketProductSelect(): string {
    return `SELECT p.id, p.ozon_product_id, p.name, p.ozon_url, p.seller, p.brand,
                   p.category_level_1, p.category_level_3, p.product_flags,
                   i.snapshot_date, i.report_period_days,
                   s.ordered_amount_minor, s.turnover_growth, s.ordered_units,
                   s.average_price_minor, s.minimum_price_minor, s.purchase_rate,
                   s.missed_sales, s.out_of_stock_days, s.daily_sales_amount_minor,
                   s.daily_sales_units, s.ending_inventory_units, s.fulfillment_scheme,
                   s.volume_liters, s.impressions, s.search_catalog_views, s.card_views,
                   s.impression_to_order_rate, s.search_catalog_cart_rate, s.card_cart_rate,
                   s.promotion_discount_rate, s.promoted_order_share, s.promotion_days,
                   s.advertised_days, s.advertising_cost_share, s.product_card_created_date`;
  }

  private scheduleJob(jobId: string): void {
    if (!this.started || this.activeJobs.size > 0) {
      return;
    }
    const task = this.processJob(jobId).finally(() => {
      this.activeJobs.delete(jobId);
      this.scheduleNextJob();
    });
    this.activeJobs.set(jobId, task);
  }

  /** Runs one persisted job at a time so its three workers are the global API concurrency limit. */
  private scheduleNextJob(): void {
    if (!this.started || this.activeJobs.size > 0) {
      return;
    }
    const next = this.database.prepare(
      "SELECT id FROM selection_wordstat_jobs WHERE status = 'queued' ORDER BY created_at_ms ASC LIMIT 1",
    ).get() as { id: string } | undefined;
    if (next) {
      this.scheduleJob(next.id);
    }
  }

  private async processJob(jobId: string): Promise<void> {
    this.database.prepare("UPDATE selection_wordstat_jobs SET status = 'running' WHERE id = ? AND status = 'queued'").run(jobId);
    const wordstat = this.createWordstat();
    const worker = async (): Promise<void> => {
      while (this.started) {
        const item = this.claimJobItem(jobId);
        if (!item) {
          return;
        }
        try {
          const profile = await wordstat.fetchProfile(item.phrase);
          this.persistWordstat(item.keyword_id, profile);
          this.database.prepare(
            "UPDATE selection_wordstat_job_items SET status = 'completed', error_message = NULL WHERE job_id = ? AND keyword_id = ?",
          ).run(jobId, item.keyword_id);
        } catch (error) {
          this.database.prepare(
            "UPDATE selection_wordstat_job_items SET status = 'failed', error_message = ? WHERE job_id = ? AND keyword_id = ?",
          ).run(error instanceof Error ? error.message.slice(0, 1000) : "Wordstat 补强失败", jobId, item.keyword_id);
        }
      }
    };
    await Promise.all(Array.from({ length: WORDSTAT_CONCURRENCY }, worker));
    this.finishJob(jobId);
  }

  private claimJobItem(jobId: string): WordstatJobItemRow | null {
    const claim = this.database.transaction(() => {
      const row = this.database.prepare(
        `SELECT ji.keyword_id, k.phrase
         FROM selection_wordstat_job_items ji
         JOIN selection_keywords k ON k.id = ji.keyword_id
         WHERE ji.job_id = ? AND ji.status = 'queued' LIMIT 1`,
      ).get(jobId) as WordstatJobItemRow | undefined;
      if (!row) {
        return null;
      }
      this.database.prepare(
        "UPDATE selection_wordstat_job_items SET status = 'running' WHERE job_id = ? AND keyword_id = ?",
      ).run(jobId, row.keyword_id);
      return row;
    });
    return claim();
  }

  private persistWordstat(keywordId: string, profile: WordstatProfile): void {
    const { growth3m, growth12m, trend } = profileGrowth(profile);
    this.database.prepare(
      `INSERT INTO selection_wordstat_snapshots
        (id, keyword_id, fetched_at_ms, total_count_30d, top_requests_json, associations_json,
         dynamics_json, growth_3m, growth_12m, trend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), keywordId, Date.now(), profile.totalCount30d,
      JSON.stringify(profile.topRequests), JSON.stringify(profile.associations), JSON.stringify(profile.dynamics),
      growth3m, growth12m, trend,
    );
  }

  private finishJob(jobId: string): void {
    const counts = this.database.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS pending
       FROM selection_wordstat_job_items WHERE job_id = ?`,
    ).get(jobId) as { total: number; completed: number; failed: number; pending: number };
    if (counts.pending > 0) {
      this.database.prepare(
        "UPDATE selection_wordstat_jobs SET status = 'queued', finished_at_ms = NULL WHERE id = ?",
      ).run(jobId);
      return;
    }
    let status: WordstatJobStatus = "completed";
    if (counts.failed === counts.total) {
      status = "failed";
    } else if (counts.failed > 0) {
      status = "partial";
    }
    this.database.prepare(
      "UPDATE selection_wordstat_jobs SET status = ?, finished_at_ms = ? WHERE id = ?",
    ).run(status, Date.now(), jobId);
  }
}
