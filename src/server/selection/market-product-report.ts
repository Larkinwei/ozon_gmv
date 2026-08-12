import Decimal from "decimal.js";

import type { SelectionImportError } from "../../shared/contracts";

const PRODUCT_REPORT_HEADERS = [
  "Название товара",
  "Ссылка на товар",
  "Продавец",
  "Бренд",
  "Категория 1 уровня",
  "Категория 3 уровня",
  "Признак товара",
  "Заказано на сумму, ₽",
  "Динамика оборота, %",
  "Заказано, штуки",
  "Средняя цена, ₽",
  "Минимальная цена, ₽",
  "Доля выкупа, %",
  "Упущенные продажи",
  "Дней без остатка",
  "Среднесуточные продажи, ₽",
  "Среднесуточные продажи, штуки",
  "Остаток на конец периода, штуки",
  "Схема работы",
  "Объем товара, л",
  "Показы всего",
  "Просмотры в поиске и каталоге",
  "Просмотры карточки",
  "Конверсия из показа в заказ, %",
  "В корзину из поиска и каталога, %",
  "В корзину из карточки, %",
  "Скидка за счет акций",
  "Доля суммы заказов по акциям, %",
  "Дней в акциях",
  "Дней с продвижением",
  "Доля рекламных расходов, %",
  "Дата создания карточки товара",
] as const;

const SUMMARY_ROW_NAME = "Среднее значение по товарам";
const NULL_VALUES = new Set(["", "-", "Нет данных"]);

export interface MarketProductReportDetection {
  headerIndex: number;
  headers: string[];
  dataRows: string[][];
  dataRowNumbers: number[];
  detectedSnapshotDate: string | null;
  reportPeriodDays: number | null;
}

export interface NormalizedMarketProduct {
  ozonProductId: string;
  name: string;
  ozonUrl: string;
  seller: string;
  brand: string;
  categoryLevel1: string;
  categoryLevel3: string;
  productFlags: string[];
  orderedAmountMinor: number;
  turnoverGrowth: number | null;
  orderedUnits: number;
  averagePriceMinor: number;
  minimumPriceMinor: number;
  purchaseRate: number | null;
  missedSales: number;
  outOfStockDays: number | null;
  dailySalesAmountMinor: number;
  dailySalesUnits: number;
  endingInventoryUnits: number;
  fulfillmentScheme: string;
  volumeLiters: number;
  impressions: number;
  searchCatalogViews: number;
  cardViews: number;
  impressionToOrderRate: number;
  searchCatalogCartRate: number;
  cardCartRate: number;
  promotionDiscountRate: number;
  promotedOrderShare: number;
  promotionDays: number;
  advertisedDays: number;
  advertisingCostShare: number;
  productCardCreatedDate: string | null;
}

function dateFromFileName(fileName: string): string | null {
  const match = fileName.match(/(?:^|_)(\d{4}-\d{2}-\d{2})(?:_|\.|$)/);
  if (!match?.[1]) {
    return null;
  }
  const date = new Date(`${match[1]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : match[1];
}

function reportPeriod(rows: string[][], headerIndex: number): number | null {
  for (const row of rows.slice(0, headerIndex)) {
    if (row[0]?.trim() !== "Период отчета:") {
      continue;
    }
    const days = row[1]?.match(/(\d+)/)?.[1];
    return days ? Number(days) : null;
  }
  return null;
}

/** Detects an official Ozon product report and validates its all-metrics export columns. */
export function detectMarketProductReport(
  rows: string[][],
  fileName: string,
  rowNumbers?: number[],
): MarketProductReportDetection | null {
  const firstRows = rows.slice(0, 10);
  const headerIndex = firstRows.findIndex((row) => row.includes("Название товара") && row.includes("Ссылка на товар"));
  if (headerIndex < 0) {
    return null;
  }
  const headers = rows[headerIndex] ?? [];
  const missing = PRODUCT_REPORT_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length > 0) {
    throw new Error(`商品报表缺少字段：${missing.join("、")}。请在 Ozon 下载“所有指标”报表`);
  }
  const dataRows = rows.slice(headerIndex + 1);
  return {
    headerIndex,
    headers,
    dataRows,
    dataRowNumbers: (rowNumbers ?? rows.map((_, index) => index + 1)).slice(headerIndex + 1),
    detectedSnapshotDate: dateFromFileName(fileName),
    reportPeriodDays: reportPeriod(rows, headerIndex),
  };
}

function columnMap(headers: string[]): Map<string, number> {
  return new Map(headers.map((header, index) => [header, index]));
}

function textAt(row: string[], columns: Map<string, number>, header: string): string {
  const index = columns.get(header);
  return index === undefined ? "" : (row[index] ?? "").trim();
}

function decimal(value: string, label: string, allowNegative = false): Decimal {
  const normalized = value.replace(/[\s\u00A0₽%]/g, "").replace(/RUB/gi, "").replace(",", ".");
  const parsed = new Decimal(normalized || Number.NaN);
  if (!parsed.isFinite() || (!allowNegative && parsed.isNegative())) {
    throw new Error(`${label}不是有效数字`);
  }
  return parsed;
}

function numberValue(value: string, label: string, allowNegative = false): number {
  const parsed = decimal(value, label, allowNegative);
  if (parsed.abs().greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label}超出支持范围`);
  }
  return parsed.toNumber();
}

function integerValue(value: string, label: string): number {
  const parsed = decimal(value, label);
  if (!parsed.isInteger() || parsed.greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label}必须是整数`);
  }
  return parsed.toNumber();
}

function moneyMinor(value: string, label: string): number {
  const parsed = decimal(value, label).times(100).toDecimalPlaces(0);
  if (parsed.greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label}超出支持范围`);
  }
  return parsed.toNumber();
}

function percentValue(value: string, label: string): number {
  const result = decimal(value, label).dividedBy(100);
  if (result.greaterThan(1)) {
    throw new Error(`${label}必须在 0% 到 100% 之间`);
  }
  return result.toNumber();
}

function nullablePercent(value: string, label: string): number | null {
  return NULL_VALUES.has(value.trim()) ? null : percentValue(value, label);
}

function nullableSignedPercent(value: string, label: string): number | null {
  return NULL_VALUES.has(value.trim()) ? null : decimal(value, label, true).dividedBy(100).toNumber();
}

function dayCount(value: string, label: string, nullable: boolean): number | null {
  if (NULL_VALUES.has(value.trim())) {
    if (nullable) {
      return null;
    }
    throw new Error(`${label}不能为空`);
  }
  const days = value.match(/^(\d+)\s+из\s+\d+$/)?.[1];
  if (!days) {
    throw new Error(`${label}格式应为“N из 28”`);
  }
  return Number(days);
}

function normalizeOzonProductUrl(value: string): { url: string; productId: string } {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "ozon.ru" && !url.hostname.endsWith(".ozon.ru"))) {
    throw new Error("商品链接必须是 Ozon HTTPS 地址");
  }
  const productId = url.pathname.match(/(?:-|\/)(\d{6,})(?:\/|$)/)?.[1];
  if (!productId) {
    throw new Error("无法从商品链接识别 Ozon Product ID");
  }
  url.search = "";
  url.hash = "";
  return { url: url.toString(), productId };
}

function normalizeProduct(row: string[], columns: Map<string, number>): NormalizedMarketProduct {
  const name = textAt(row, columns, "Название товара");
  if (!name) {
    throw new Error("商品名称不能为空");
  }
  const ozon = normalizeOzonProductUrl(textAt(row, columns, "Ссылка на товар"));
  const productCardCreatedDate = textAt(row, columns, "Дата создания карточки товара");
  return {
    ozonProductId: ozon.productId,
    name,
    ozonUrl: ozon.url,
    seller: textAt(row, columns, "Продавец"),
    brand: textAt(row, columns, "Бренд"),
    categoryLevel1: textAt(row, columns, "Категория 1 уровня"),
    categoryLevel3: textAt(row, columns, "Категория 3 уровня"),
    productFlags: textAt(row, columns, "Признак товара")
      .split(";")
      .map((flag) => flag.trim())
      .filter(Boolean),
    orderedAmountMinor: moneyMinor(textAt(row, columns, "Заказано на сумму, ₽"), "下单金额"),
    turnoverGrowth: nullableSignedPercent(textAt(row, columns, "Динамика оборота, %"), "销售额变化"),
    orderedUnits: integerValue(textAt(row, columns, "Заказано, штуки"), "下单件数"),
    averagePriceMinor: moneyMinor(textAt(row, columns, "Средняя цена, ₽"), "平均价格"),
    minimumPriceMinor: moneyMinor(textAt(row, columns, "Минимальная цена, ₽"), "最低价格"),
    purchaseRate: nullablePercent(textAt(row, columns, "Доля выкупа, %"), "签收率"),
    missedSales: integerValue(textAt(row, columns, "Упущенные продажи"), "错失销售"),
    outOfStockDays: dayCount(textAt(row, columns, "Дней без остатка"), "缺货天数", true),
    dailySalesAmountMinor: moneyMinor(textAt(row, columns, "Среднесуточные продажи, ₽"), "日均销售额"),
    dailySalesUnits: integerValue(textAt(row, columns, "Среднесуточные продажи, штуки"), "日均销量"),
    endingInventoryUnits: integerValue(textAt(row, columns, "Остаток на конец периода, штуки"), "期末库存"),
    fulfillmentScheme: textAt(row, columns, "Схема работы"),
    volumeLiters: numberValue(textAt(row, columns, "Объем товара, л"), "商品体积"),
    impressions: integerValue(textAt(row, columns, "Показы всего"), "总展示量"),
    searchCatalogViews: integerValue(textAt(row, columns, "Просмотры в поиске и каталоге"), "搜索目录浏览量"),
    cardViews: integerValue(textAt(row, columns, "Просмотры карточки"), "商品卡浏览量"),
    impressionToOrderRate: percentValue(textAt(row, columns, "Конверсия из показа в заказ, %"), "展示到下单转化率"),
    searchCatalogCartRate: percentValue(textAt(row, columns, "В корзину из поиска и каталога, %"), "搜索目录加购率"),
    cardCartRate: percentValue(textAt(row, columns, "В корзину из карточки, %"), "商品卡加购率"),
    promotionDiscountRate: percentValue(textAt(row, columns, "Скидка за счет акций"), "促销折扣"),
    promotedOrderShare: percentValue(textAt(row, columns, "Доля суммы заказов по акциям, %"), "促销订单金额占比"),
    promotionDays: dayCount(textAt(row, columns, "Дней в акциях"), "促销天数", false) ?? 0,
    advertisedDays: dayCount(textAt(row, columns, "Дней с продвижением"), "推广天数", false) ?? 0,
    advertisingCostShare: percentValue(textAt(row, columns, "Доля рекламных расходов, %"), "广告费用占比"),
    productCardCreatedDate: NULL_VALUES.has(productCardCreatedDate) ? null : productCardCreatedDate,
  };
}

/** Normalizes product rows while preserving a bounded error summary for the import dialog. */
export function normalizeMarketProductRows(
  report: MarketProductReportDetection,
): { products: NormalizedMarketProduct[]; errors: SelectionImportError[] } {
  const columns = columnMap(report.headers);
  const products: NormalizedMarketProduct[] = [];
  const errors: SelectionImportError[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < report.dataRows.length; index += 1) {
    const row = report.dataRows[index] ?? [];
    const rowNumber = report.dataRowNumbers[index] ?? report.headerIndex + index + 2;
    if (row[0]?.trim() === SUMMARY_ROW_NAME) {
      errors.push({ row: rowNumber, message: "已忽略商品平均值汇总行" });
      continue;
    }
    try {
      const product = normalizeProduct(row, columns);
      if (seen.has(product.ozonProductId)) {
        throw new Error("商品在文件中重复");
      }
      seen.add(product.ozonProductId);
      products.push(product);
    } catch (error) {
      errors.push({ row: rowNumber, message: error instanceof Error ? error.message : "无法解析该商品" });
    }
  }
  return { products, errors };
}
