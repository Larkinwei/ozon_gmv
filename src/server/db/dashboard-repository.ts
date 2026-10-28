import Decimal from "decimal.js";
import { addDays, format, startOfDay, subDays } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";

import type {
  DashboardKpis,
  DashboardOrderStatus,
  DashboardDailyOrders,
  DashboardRange,
  DashboardSnapshot,
  Money,
  OrderDetail,
  OrderSearchPage,
  PlatformBreakdown,
  RecentOrder,
  StoreBreakdown,
  StorePlatform,
} from "../../shared/contracts";
import { buildDashboardSeries, type DashboardSeriesRow } from "../domain/dashboard-series";
import { resolveDashboardWindow, type DashboardWindow } from "../domain/time-range";
import type { AppDatabase } from "./database";
import { minorUnitsToAmount } from "./money-storage";
import { StoresRepository, toStoreView } from "./stores-repository";

interface SummaryRow {
  currency: string;
  orders: number;
  gmv_minor: number;
  cancelled_orders: number;
  cancelled_gmv_minor: number;
}

interface SeriesSqlRow {
  bucket_ms: number;
  store_id: string;
  store_name: string;
  store_color: string;
  currency: string;
  orders: number;
  gmv_minor: number;
}

interface BreakdownRow {
  store_id: string;
  store_name: string;
  color: string;
  platform: StorePlatform;
  currency: string;
  orders: number;
  gmv_minor: number;
}

interface RecentOrderRow {
  id: string;
  platform: StorePlatform;
  external_order_id: string;
  posting_number: string;
  store_id: string;
  store_name: string;
  store_color: string;
  order_at_ms: number;
  gross_amount_minor: number;
  currency: string;
  item_count: number;
  product_names_json: string;
  image_url: string | null;
  fulfillment_mode: RecentOrder["fulfillment"];
  status: string;
  cancelled_at_ms: number | null;
}

interface OrderDetailRow {
  id: string;
  posting_number: string;
  order_number: string;
  store_id: string;
  store_name: string;
  store_color: string;
  order_at_ms: number;
  gross_amount_minor: number;
  currency: string;
  fulfillment_mode: OrderDetail["fulfillment"];
  status: string;
  substatus: string | null;
  cancelled_at_ms: number | null;
}

interface OrderDetailItemRow {
  id: string;
  sku: string;
  offer_id: string;
  name: string;
  primary_image_url: string | null;
  quantity: number;
  unit_price_minor: number;
  currency: string;
}

interface FilterClause {
  sql: string;
  parameters: Array<number | string>;
}

interface ProductMetricRow {
  store_id: string | null;
  sku: string;
  offer_id: string | null;
  name: string;
  image_url: string | null;
  currency: string;
  quantity: number;
  gmv_minor: number;
}

interface StatusCountRow {
  status: DashboardOrderStatus;
  count: number;
}

const DASHBOARD_TIMEZONE = "Asia/Shanghai";

/** Treats partial first and last days as occurrences for multi-day ranges. */
function isSingleBeijingDay(window: DashboardWindow): boolean {
  const firstDay = startOfDay(toZonedTime(window.from, DASHBOARD_TIMEZONE)).getTime();
  const lastInstant = new Date(window.to.getTime() - 1);
  const lastDay = startOfDay(toZonedTime(lastInstant, DASHBOARD_TIMEZONE)).getTime();
  return firstDay === lastDay;
}

/** Returns every Beijing calendar date intersecting the selected window. */
function getBeijingDays(window: DashboardWindow): Date[] {
  const days: Date[] = [];
  let day = startOfDay(toZonedTime(window.from, DASHBOARD_TIMEZONE));
  while (fromZonedTime(day, DASHBOARD_TIMEZONE) < window.to) {
    if (fromZonedTime(addDays(day, 1), DASHBOARD_TIMEZONE) > window.from) days.push(day);
    day = addDays(day, 1);
  }
  return days;
}

function rangeLabel(range: DashboardRange): string {
  const labels: Record<DashboardRange, string> = {
    today: "今天",
    yesterday: "昨天",
    "7d": "近 7 天",
    "30d": "近 30 天",
    custom: "自定义范围",
  };
  return labels[range];
}

function comparisonWindow(range: DashboardRange, window: DashboardWindow): DashboardWindow {
  const duration = window.to.getTime() - window.from.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (range === "today" || range === "yesterday") {
    return { ...window, from: new Date(window.from.getTime() - day), to: new Date(window.to.getTime() - day) };
  }
  return {
    from: new Date(window.from.getTime() - duration),
    to: new Date(window.from.getTime()),
    granularity: window.granularity,
  };
}

function statusCase(statusColumn: string, cancelledColumn: string): string {
  return `CASE
    WHEN ${cancelledColumn} IS NOT NULL OR LOWER(${statusColumn}) LIKE '%cancel%' THEN 'cancelled'
    WHEN LOWER(${statusColumn}) IN ('awaiting_packaging', 'awaiting_deliver', 'awaiting_registration', 'acceptance_in_progress', 'new', 'confirm', 'ordered') THEN 'awaiting_shipment'
    WHEN LOWER(${statusColumn}) IN ('delivering', 'driver_pickup', 'sorting', 'transit') THEN 'in_transit'
    WHEN LOWER(${statusColumn}) IN ('delivered', 'received', 'done') THEN 'delivered'
    ELSE 'other'
  END`;
}

function moneyFromMinorUnits(amount: number, currency: string): Money {
  return { amount: minorUnitsToAmount(amount), currency };
}

function bucketExpression(granularity: DashboardWindow["granularity"]): string {
  if (granularity === "30m") {
    return "CAST(p.order_at_ms / 1800000 AS INTEGER) * 1800000";
  }
  if (granularity === "hour") {
    return "CAST(p.order_at_ms / 3600000 AS INTEGER) * 3600000";
  }
  return "CAST((p.order_at_ms + 28800000) / 86400000 AS INTEGER) * 86400000 - 28800000";
}

function createFilter(window: DashboardWindow, storeIds: string[], platform: StorePlatform | "all"): FilterClause {
  const storeFilter = storeIds.length > 0 ? ` AND p.store_id IN (${storeIds.map(() => "?").join(", ")})` : "";
  const platformFilter = platform === "all" ? "" : " AND p.store_id IN (SELECT id FROM stores WHERE platform = ?)";
  return {
    sql: `p.order_at_ms >= ? AND p.order_at_ms < ?${storeFilter}${platformFilter}`,
    parameters: [window.from.getTime(), window.to.getTime(), ...storeIds, ...(platform === "all" ? [] : [platform])],
  };
}

interface OrderSearchRow {
  id: string;
  posting_number: string;
  order_number: string;
  store_id: string;
  store_name: string;
  store_color: string;
  order_at_ms: number;
  gross_amount_minor: number;
  currency: string;
  image_url: string | null;
  item_count: number;
  product_names_json: string;
  skus_json: string;
  offer_ids_json: string;
  fulfillment_mode: string;
  status: string;
  cancelled_at_ms: number | null;
}

function buildKpis(rows: SummaryRow[]): DashboardKpis {
  return {
    orders: rows.reduce((sum, row) => sum + row.orders, 0),
    gmv: rows.map((row) => moneyFromMinorUnits(row.gmv_minor, row.currency)),
    averageOrderValue: rows.map((row) => {
      const average = row.orders === 0 ? new Decimal(0) : new Decimal(row.gmv_minor).dividedBy(row.orders).dividedBy(100);
      return { amount: average.toFixed(2), currency: row.currency };
    }),
    cancelledOrders: rows.reduce((sum, row) => sum + row.cancelled_orders, 0),
    cancelledGmv: rows.map((row) => moneyFromMinorUnits(row.cancelled_gmv_minor, row.currency)),
  };
}

function buildBreakdown(rows: BreakdownRow[], previousRows: BreakdownRow[]): StoreBreakdown[] {
  const stores = new Map<string, StoreBreakdown>();
  const previous = new Map<string, BreakdownRow[]>();
  for (const row of previousRows) {
    const values = previous.get(row.store_id) ?? [];
    values.push(row);
    previous.set(row.store_id, values);
  }
  const totalOrders = rows.reduce((sum, row) => sum + row.orders, 0);
  for (const row of rows) {
    const existing = stores.get(row.store_id) ?? {
      storeId: row.store_id,
      storeName: row.store_name,
      color: row.color,
      platform: row.platform,
      orders: 0,
      gmv: [],
      orderSharePercent: 0,
      gmvChangePercent: null,
    };
    existing.orders += row.orders;
    existing.gmv.push(moneyFromMinorUnits(row.gmv_minor, row.currency));
    stores.set(row.store_id, existing);
  }

  const breakdown = [...stores.values()];
  for (const store of breakdown) {
    const priorRows = previous.get(store.storeId) ?? [];
    const priorOrders = priorRows.reduce((sum, row) => sum + row.orders, 0);
    store.orderSharePercent = totalOrders === 0 ? 0 : Number(new Decimal(store.orders).div(totalOrders).times(100).toFixed(1));
    const currentCurrencies = new Set(store.gmv.map((money) => money.currency));
    const previousCurrencies = new Set(priorRows.map((row) => row.currency));
    if (priorOrders > 0 && currentCurrencies.size === 1 && previousCurrencies.size === 1 && [...currentCurrencies][0] === [...previousCurrencies][0]) {
      const currentGmv = new Decimal(store.gmv[0]?.amount ?? 0);
      const priorGmv = new Decimal(minorUnitsToAmount(priorRows.reduce((sum, row) => sum + row.gmv_minor, 0)));
      store.gmvChangePercent = priorGmv.isZero()
        ? null
        : Number(currentGmv.minus(priorGmv).dividedBy(priorGmv).times(100).toFixed(1));
    } else {
      store.gmvChangePercent = null;
    }
  }
  if (new Set(rows.map((row) => row.currency)).size > 1) {
    return breakdown.sort((left, right) => right.orders - left.orders);
  }
  return breakdown.sort((left, right) => {
    const leftValue = new Decimal(left.gmv[0]?.amount ?? 0);
    const rightValue = new Decimal(right.gmv[0]?.amount ?? 0);
    return rightValue.comparedTo(leftValue);
  });
}

function marketplaceBucketExpression(column: string, granularity: DashboardWindow["granularity"]): string {
  if (granularity === "30m") {
    return `CAST(${column} / 1800000 AS INTEGER) * 1800000`;
  }
  if (granularity === "hour") {
    return `CAST(${column} / 3600000 AS INTEGER) * 3600000`;
  }
  return `CAST((${column} + 28800000) / 86400000 AS INTEGER) * 86400000 - 28800000`;
}

function mergeSummaryRows(rows: SummaryRow[]): SummaryRow[] {
  const merged = new Map<string, SummaryRow>();
  for (const row of rows) {
    const current = merged.get(row.currency) ?? {
      currency: row.currency,
      orders: 0,
      gmv_minor: 0,
      cancelled_orders: 0,
      cancelled_gmv_minor: 0,
    };
    current.orders += row.orders;
    current.gmv_minor += row.gmv_minor;
    current.cancelled_orders += row.cancelled_orders;
    current.cancelled_gmv_minor += row.cancelled_gmv_minor;
    merged.set(row.currency, current);
  }
  return [...merged.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

function buildPlatformBreakdown(rows: Array<SummaryRow & { platform: StorePlatform }>): PlatformBreakdown[] {
  const byPlatform = new Map<StorePlatform, Map<string, SummaryRow>>();
  for (const row of rows) {
    const currencies = byPlatform.get(row.platform) ?? new Map<string, SummaryRow>();
    const current = currencies.get(row.currency) ?? {
      currency: row.currency, orders: 0, gmv_minor: 0, cancelled_orders: 0, cancelled_gmv_minor: 0,
    };
    current.orders += row.orders;
    current.gmv_minor += row.gmv_minor;
    current.cancelled_orders += row.cancelled_orders;
    current.cancelled_gmv_minor += row.cancelled_gmv_minor;
    currencies.set(row.currency, current);
    byPlatform.set(row.platform, currencies);
  }
  return [...byPlatform.entries()].map(([platform, currencies]) => ({
    platform,
    orders: [...currencies.values()].reduce((sum, row) => sum + row.orders, 0),
    gmv: [...currencies.values()].sort((left, right) => left.currency.localeCompare(right.currency)).map((row) => moneyFromMinorUnits(row.gmv_minor, row.currency)),
  }));
}

export class DashboardRepository {
  private readonly storesRepository: StoresRepository;

  public constructor(private readonly database: AppDatabase) {
    this.storesRepository = new StoresRepository(database);
  }

  public searchOzonOrders(query: { q?: string; from: Date; to: Date; page: number; pageSize: number; storeId?: string; cancelledOnly?: boolean }): OrderSearchPage {
    const clauses = ["p.order_at_ms >= ?", "p.order_at_ms < ?", "s.platform = 'ozon'"];
    const dateParameters: Array<number | string> = [query.from.getTime(), query.to.getTime()];
    const searchParameters: Array<number | string> = [];
    if (query.storeId) {
      clauses.push("p.store_id = ?");
      searchParameters.push(query.storeId);
    }
    if (query.cancelledOnly) clauses.push("p.cancelled_at_ms IS NOT NULL");
    if (query.q) {
      const escaped = query.q.toLocaleLowerCase("ru-RU").replace(/[\\%_]/g, "\\$&");
      const pattern = `%${escaped}%`;
      clauses.push(`(
        LOWER(p.posting_number) LIKE ? ESCAPE '\\'
        OR LOWER(p.order_number) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM posting_items search_item
          WHERE search_item.posting_id = p.id
            AND (
              LOWER(search_item.name) LIKE ? ESCAPE '\\'
              OR LOWER(search_item.sku) LIKE ? ESCAPE '\\'
              OR LOWER(search_item.offer_id) LIKE ? ESCAPE '\\'
            )
        )
      )`);
      searchParameters.push(pattern, pattern, pattern, pattern, pattern);
    }
    const whereSql = clauses.join(" AND ");
    const countRow = this.database.prepare(`
      SELECT COUNT(*) AS total
      FROM postings p
      JOIN stores s ON s.id = p.store_id
      WHERE ${whereSql}
    `).get(...dateParameters, ...searchParameters) as { total: number };
    const start = (query.page - 1) * query.pageSize;
    const rows = this.database.prepare(`
      SELECT p.id, p.posting_number, p.order_number, p.store_id,
             s.name AS store_name, s.color AS store_color,
             p.order_at_ms, p.gross_amount_minor, p.currency,
             (
               SELECT image.primary_image_url
               FROM posting_items image_item
               LEFT JOIN product_images image ON image.store_id = p.store_id AND image.sku = image_item.sku
               WHERE image_item.posting_id = p.id AND image.primary_image_url IS NOT NULL AND image.primary_image_url <> ''
               ORDER BY image_item.id
               LIMIT 1
             ) AS image_url,
             COALESCE((SELECT SUM(quantity) FROM posting_items WHERE posting_id = p.id), 0) AS item_count,
             COALESCE((SELECT json_group_array(name) FROM (
               SELECT DISTINCT name FROM posting_items
               WHERE posting_id = p.id AND name <> '' ORDER BY name
             )), '[]') AS product_names_json,
             COALESCE((SELECT json_group_array(sku) FROM (
               SELECT DISTINCT sku FROM posting_items
               WHERE posting_id = p.id AND sku <> '' ORDER BY sku
             )), '[]') AS skus_json,
             COALESCE((SELECT json_group_array(offer_id) FROM (
               SELECT DISTINCT offer_id FROM posting_items
               WHERE posting_id = p.id AND offer_id <> '' ORDER BY offer_id
             )), '[]') AS offer_ids_json,
             p.fulfillment_mode, p.status, p.cancelled_at_ms
      FROM postings p
      JOIN stores s ON s.id = p.store_id
      WHERE ${whereSql}
      ORDER BY p.order_at_ms DESC, p.id DESC
      LIMIT ? OFFSET ?
    `).all(...dateParameters, ...searchParameters, query.pageSize, start) as OrderSearchRow[];

    return {
      items: rows.map((row) => ({
        id: row.id,
        platform: "ozon",
        externalOrderId: row.posting_number,
        postingNumber: row.posting_number,
        orderNumber: row.order_number,
        storeId: row.store_id,
        storeName: row.store_name,
        storeColor: row.store_color,
        orderAt: new Date(row.order_at_ms).toISOString(),
        amount: moneyFromMinorUnits(row.gross_amount_minor, row.currency),
        imageUrl: row.image_url,
        itemCount: row.item_count,
        productNames: JSON.parse(row.product_names_json) as string[],
        skus: JSON.parse(row.skus_json) as string[],
        offerIds: JSON.parse(row.offer_ids_json) as string[],
        fulfillment: row.fulfillment_mode,
        status: row.status,
        cancelled: row.cancelled_at_ms !== null,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: countRow.total,
    };
  }

  /** Returns a non-PII order projection and its locally cached product images. */
  public async getOrderDetail(id: string): Promise<OrderDetail | null> {
    const order = this.database.prepare(
      `SELECT p.id, p.posting_number, p.order_number, p.store_id,
              s.name AS store_name, s.color AS store_color,
              p.order_at_ms, p.gross_amount_minor, p.currency,
              p.fulfillment_mode, p.status, p.substatus, p.cancelled_at_ms
       FROM postings p
       JOIN stores s ON s.id = p.store_id
       WHERE p.id = ?`,
    ).get(id) as OrderDetailRow | undefined;
    if (!order) {
      const marketplaceOrder = this.database.prepare(
        `SELECT mo.id, mo.external_order_id, mo.order_number, mo.store_id,
                s.name AS store_name, s.color AS store_color,
                mo.order_at_ms, mo.gross_amount_minor, mo.currency,
                mo.fulfillment_mode, mo.status, mo.substatus, mo.cancelled_at_ms
         FROM marketplace_orders mo
         JOIN stores s ON s.id = mo.store_id
         WHERE mo.id = ?`,
      ).get(id) as {
        id: string;
        external_order_id: string;
        order_number: string;
        store_id: string;
        store_name: string;
        store_color: string;
        order_at_ms: number;
        gross_amount_minor: number;
        currency: string;
        fulfillment_mode: string;
        status: string;
        substatus: string | null;
        cancelled_at_ms: number | null;
      } | undefined;
      if (!marketplaceOrder) {
        return null;
      }
      const marketplaceItems = this.database.prepare(
        `SELECT id, sku, offer_id, name, quantity, unit_price_minor, currency
         FROM marketplace_order_items WHERE order_id = ? ORDER BY name ASC, sku ASC`,
      ).all(id) as OrderDetailItemRow[];
      return {
        id: marketplaceOrder.id,
        platform: "wildberries",
        externalOrderId: marketplaceOrder.external_order_id,
        postingNumber: marketplaceOrder.external_order_id,
        orderNumber: marketplaceOrder.order_number,
        storeId: marketplaceOrder.store_id,
        storeName: marketplaceOrder.store_name,
        storeColor: marketplaceOrder.store_color,
        orderAt: new Date(marketplaceOrder.order_at_ms).toISOString(),
        fulfillment: marketplaceOrder.fulfillment_mode as OrderDetail["fulfillment"],
        status: marketplaceOrder.status,
        substatus: marketplaceOrder.substatus,
        cancelled: marketplaceOrder.cancelled_at_ms !== null,
        cancelledAt: marketplaceOrder.cancelled_at_ms === null ? null : new Date(marketplaceOrder.cancelled_at_ms).toISOString(),
        amount: moneyFromMinorUnits(marketplaceOrder.gross_amount_minor, marketplaceOrder.currency),
        items: marketplaceItems.map((item) => ({
          id: item.id,
          sku: item.sku,
          offerId: item.offer_id,
          name: item.name,
          imageUrl: null,
          quantity: item.quantity,
          unitPrice: moneyFromMinorUnits(item.unit_price_minor, item.currency),
          subtotal: moneyFromMinorUnits(item.unit_price_minor * item.quantity, item.currency),
        })),
      };
    }

    const items = this.database.prepare(
      `SELECT item.id, item.sku, item.offer_id, item.name,
              image.primary_image_url, item.quantity, item.unit_price_minor, item.currency
       FROM posting_items item
       JOIN postings p ON p.id = item.posting_id
       LEFT JOIN product_images image ON image.store_id = p.store_id AND image.sku = item.sku
       WHERE item.posting_id = ?
       ORDER BY item.name ASC, item.sku ASC`,
    ).all(id) as OrderDetailItemRow[];

    return {
      id: order.id,
      platform: "ozon",
      externalOrderId: order.posting_number,
      postingNumber: order.posting_number,
      orderNumber: order.order_number,
      storeId: order.store_id,
      storeName: order.store_name,
      storeColor: order.store_color,
      orderAt: new Date(order.order_at_ms).toISOString(),
      fulfillment: order.fulfillment_mode,
      status: order.status,
      substatus: order.substatus,
      cancelled: order.cancelled_at_ms !== null,
      cancelledAt: order.cancelled_at_ms === null ? null : new Date(order.cancelled_at_ms).toISOString(),
      amount: moneyFromMinorUnits(order.gross_amount_minor, order.currency),
      items: items.map((item) => ({
        id: item.id,
        sku: item.sku,
        offerId: item.offer_id,
        name: item.name,
        imageUrl: item.primary_image_url,
        quantity: item.quantity,
        unitPrice: moneyFromMinorUnits(item.unit_price_minor, item.currency),
        subtotal: moneyFromMinorUnits(item.unit_price_minor * item.quantity, item.currency),
      })),
    };
  }

  /** Reads every dashboard panel using one filter window and store selection. */
  public async getSnapshot(
    range: DashboardRange,
    window: DashboardWindow,
    storeIds: string[],
    platform: StorePlatform | "all" = "all",
  ): Promise<DashboardSnapshot> {
    const filter = createFilter(window, storeIds, platform);
    const ozonSummaryRows = this.database.prepare(
      `SELECT currency,
              COUNT(*) AS orders,
              COALESCE(SUM(gross_amount_minor), 0) AS gmv_minor,
              SUM(CASE WHEN cancelled_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS cancelled_orders,
              COALESCE(SUM(CASE WHEN cancelled_at_ms IS NOT NULL THEN gross_amount_minor ELSE 0 END), 0) AS cancelled_gmv_minor
       FROM postings p
       WHERE ${filter.sql}
       GROUP BY currency
       ORDER BY currency`,
    ).all(...filter.parameters) as SummaryRow[];

    const marketplaceStoreFilter = platform === "ozon" ? " AND 1 = 0" : storeIds.length > 0
      ? ` AND mo.store_id IN (${storeIds.map(() => "?").join(", ")})`
      : "";
    const marketplaceSalesStoreFilter = platform === "ozon" ? " AND 1 = 0" : storeIds.length > 0
      ? ` AND ms.store_id IN (${storeIds.map(() => "?").join(", ")})`
      : "";
    const marketplaceStoreParams = platform === "ozon" ? [] : storeIds;
    const wbSummaryRows = this.database.prepare(
      `SELECT currency, SUM(orders) AS orders, SUM(gmv_minor) AS gmv_minor,
              SUM(cancelled_orders) AS cancelled_orders, SUM(cancelled_gmv_minor) AS cancelled_gmv_minor
       FROM (
         SELECT mo.currency, COUNT(DISTINCT mo.external_order_id) AS orders, 0 AS gmv_minor,
                SUM(CASE WHEN mo.cancelled_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS cancelled_orders,
                COALESCE(SUM(CASE WHEN mo.cancelled_at_ms IS NOT NULL THEN mo.gross_amount_minor ELSE 0 END), 0) AS cancelled_gmv_minor
         FROM marketplace_orders mo
         WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
         GROUP BY mo.currency
         UNION ALL
         SELECT ms.currency, 0 AS orders,
                COALESCE(SUM(CASE WHEN ms.fact_type = 'return' THEN -ms.amount_minor ELSE ms.amount_minor END), 0) AS gmv_minor,
                SUM(CASE WHEN ms.fact_type = 'return' THEN 1 ELSE 0 END) AS cancelled_orders,
                COALESCE(SUM(CASE WHEN ms.fact_type = 'return' THEN ms.amount_minor ELSE 0 END), 0) AS cancelled_gmv_minor
         FROM marketplace_sales ms
         WHERE ms.sale_at_ms >= ? AND ms.sale_at_ms < ?${marketplaceSalesStoreFilter}
         GROUP BY ms.currency
       )
       GROUP BY currency ORDER BY currency`,
    ).all(window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams, window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams) as SummaryRow[];
    const summaryRows = mergeSummaryRows([...ozonSummaryRows, ...wbSummaryRows]);
    const platformSummaryRows: Array<SummaryRow & { platform: StorePlatform }> = [
      ...ozonSummaryRows.map((row) => ({ ...row, platform: "ozon" as const })),
      ...wbSummaryRows.map((row) => ({ ...row, platform: "wildberries" as const })),
    ];

    /** Reads the same Ozon and Wildberries series for any comparison window. */
    const loadSeriesRows = (queryWindow: DashboardWindow): DashboardSeriesRow[] => {
      const queryFilter = createFilter(queryWindow, storeIds, platform);
      const ozonRows = this.database.prepare(
        `SELECT ${bucketExpression(queryWindow.granularity)} AS bucket_ms,
                p.store_id, s.name AS store_name, s.color AS store_color, p.currency,
                COUNT(*) AS orders, COALESCE(SUM(p.gross_amount_minor), 0) AS gmv_minor
         FROM postings p JOIN stores s ON s.id = p.store_id
         WHERE ${queryFilter.sql}
         GROUP BY bucket_ms, p.store_id, s.name, s.color, p.currency
         ORDER BY bucket_ms ASC, s.name ASC, p.currency ASC`,
      ).all(...queryFilter.parameters) as SeriesSqlRow[];
      const wbRows = this.database.prepare(
        `SELECT bucket_ms, store_id, store_name, store_color, currency,
                SUM(orders) AS orders, SUM(gmv_minor) AS gmv_minor
         FROM (
           SELECT ${marketplaceBucketExpression("mo.order_at_ms", queryWindow.granularity)} AS bucket_ms,
                  mo.store_id, s.name AS store_name, s.color AS store_color, mo.currency,
                  COUNT(DISTINCT mo.external_order_id) AS orders, 0 AS gmv_minor
           FROM marketplace_orders mo JOIN stores s ON s.id = mo.store_id
           WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
           GROUP BY bucket_ms, mo.store_id, s.name, s.color, mo.currency
           UNION ALL
           SELECT ${marketplaceBucketExpression("ms.sale_at_ms", queryWindow.granularity)} AS bucket_ms,
                  ms.store_id, s.name AS store_name, s.color AS store_color, ms.currency,
                  0 AS orders,
                  COALESCE(SUM(CASE WHEN ms.fact_type = 'return' THEN -ms.amount_minor ELSE ms.amount_minor END), 0) AS gmv_minor
           FROM marketplace_sales ms JOIN stores s ON s.id = ms.store_id
           WHERE ms.sale_at_ms >= ? AND ms.sale_at_ms < ?${marketplaceSalesStoreFilter}
           GROUP BY bucket_ms, ms.store_id, s.name, s.color, ms.currency
         ) GROUP BY bucket_ms, store_id, store_name, store_color, currency
         ORDER BY bucket_ms ASC, store_name ASC, currency ASC`,
      ).all(queryWindow.from.getTime(), queryWindow.to.getTime(), ...marketplaceStoreParams, queryWindow.from.getTime(), queryWindow.to.getTime(), ...marketplaceStoreParams) as SeriesSqlRow[];
      return [...ozonRows, ...wbRows].map((row) => ({
        bucket: new Date(row.bucket_ms),
        storeId: row.store_id,
        storeName: row.store_name,
        storeColor: row.store_color,
        currency: row.currency,
        orders: row.orders,
        gmv: minorUnitsToAmount(row.gmv_minor),
      }));
    };
    const seriesRows = loadSeriesRows(window);
    const previous = comparisonWindow(range, window);
    const previousSeriesRows = range === "today" ? loadSeriesRows(previous) : [];

    const ozonBreakdownRows = this.database.prepare(
      `SELECT s.id AS store_id, s.name AS store_name, s.color, p.currency,
              'ozon' AS platform,
              COUNT(*) AS orders,
              COALESCE(SUM(p.gross_amount_minor), 0) AS gmv_minor
       FROM postings p
       JOIN stores s ON s.id = p.store_id
       WHERE ${filter.sql}
       GROUP BY s.id, s.name, s.color, p.currency
       ORDER BY gmv_minor DESC`,
    ).all(...filter.parameters) as BreakdownRow[];
    const wbBreakdownRows = this.database.prepare(
      `SELECT store_id, store_name, color, platform, currency,
              SUM(orders) AS orders, SUM(gmv_minor) AS gmv_minor
       FROM (
         SELECT s.id AS store_id, s.name AS store_name, s.color, 'wildberries' AS platform, mo.currency,
                COUNT(DISTINCT mo.external_order_id) AS orders, 0 AS gmv_minor
         FROM marketplace_orders mo JOIN stores s ON s.id = mo.store_id
         WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
         GROUP BY s.id, s.name, s.color, mo.currency
         UNION ALL
         SELECT s.id AS store_id, s.name AS store_name, s.color, 'wildberries' AS platform, ms.currency,
                0 AS orders,
                COALESCE(SUM(CASE WHEN ms.fact_type = 'return' THEN -ms.amount_minor ELSE ms.amount_minor END), 0) AS gmv_minor
         FROM marketplace_sales ms JOIN stores s ON s.id = ms.store_id
         WHERE ms.sale_at_ms >= ? AND ms.sale_at_ms < ?${marketplaceSalesStoreFilter}
         GROUP BY s.id, s.name, s.color, ms.currency
       )
       GROUP BY store_id, store_name, color, platform, currency
       ORDER BY gmv_minor DESC`,
    ).all(window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams, window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams) as BreakdownRow[];
    const breakdownRows = [...ozonBreakdownRows, ...wbBreakdownRows];

    const previousFilter = createFilter(previous, storeIds, platform);
    const previousOzonRows = this.database.prepare(
      `SELECT currency, COUNT(*) AS orders, COALESCE(SUM(gross_amount_minor), 0) AS gmv_minor,
              SUM(CASE WHEN cancelled_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS cancelled_orders,
              COALESCE(SUM(CASE WHEN cancelled_at_ms IS NOT NULL THEN gross_amount_minor ELSE 0 END), 0) AS cancelled_gmv_minor
       FROM postings p WHERE ${previousFilter.sql} GROUP BY currency ORDER BY currency`,
    ).all(...previousFilter.parameters) as SummaryRow[];
    const previousWbRows = this.database.prepare(
      `SELECT currency, SUM(orders) AS orders, SUM(gmv_minor) AS gmv_minor,
              SUM(cancelled_orders) AS cancelled_orders, SUM(cancelled_gmv_minor) AS cancelled_gmv_minor
       FROM (
         SELECT mo.currency, COUNT(DISTINCT mo.external_order_id) AS orders, 0 AS gmv_minor,
                SUM(CASE WHEN mo.cancelled_at_ms IS NOT NULL THEN 1 ELSE 0 END) AS cancelled_orders,
                COALESCE(SUM(CASE WHEN mo.cancelled_at_ms IS NOT NULL THEN mo.gross_amount_minor ELSE 0 END), 0) AS cancelled_gmv_minor
         FROM marketplace_orders mo
         WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
         GROUP BY mo.currency
         UNION ALL
         SELECT ms.currency, 0 AS orders,
                COALESCE(SUM(CASE WHEN ms.fact_type = 'return' THEN -ms.amount_minor ELSE ms.amount_minor END), 0) AS gmv_minor,
                SUM(CASE WHEN ms.fact_type = 'return' THEN 1 ELSE 0 END) AS cancelled_orders,
                COALESCE(SUM(CASE WHEN ms.fact_type = 'return' THEN ms.amount_minor ELSE 0 END), 0) AS cancelled_gmv_minor
         FROM marketplace_sales ms
         WHERE ms.sale_at_ms >= ? AND ms.sale_at_ms < ?${marketplaceSalesStoreFilter}
         GROUP BY ms.currency
       ) GROUP BY currency ORDER BY currency`,
    ).all(previous.from.getTime(), previous.to.getTime(), ...marketplaceStoreParams, previous.from.getTime(), previous.to.getTime(), ...marketplaceStoreParams) as SummaryRow[];
    const previousSummary = mergeSummaryRows([...previousOzonRows, ...previousWbRows]);

    const previousOzonBreakdown = this.database.prepare(
      `SELECT s.id AS store_id, s.name AS store_name, s.color, p.currency, 'ozon' AS platform,
              COUNT(*) AS orders, COALESCE(SUM(p.gross_amount_minor), 0) AS gmv_minor
       FROM postings p JOIN stores s ON s.id = p.store_id
       WHERE ${previousFilter.sql}
       GROUP BY s.id, s.name, s.color, p.currency`,
    ).all(...previousFilter.parameters) as BreakdownRow[];
    const previousWbBreakdown = this.database.prepare(
      `SELECT store_id, store_name, color, platform, currency, SUM(orders) AS orders, SUM(gmv_minor) AS gmv_minor
       FROM (
         SELECT s.id AS store_id, s.name AS store_name, s.color, 'wildberries' AS platform, mo.currency,
                COUNT(DISTINCT mo.external_order_id) AS orders, 0 AS gmv_minor
         FROM marketplace_orders mo JOIN stores s ON s.id = mo.store_id
         WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
         GROUP BY s.id, s.name, s.color, mo.currency
         UNION ALL
         SELECT s.id AS store_id, s.name AS store_name, s.color, 'wildberries' AS platform, ms.currency,
                0 AS orders,
                COALESCE(SUM(CASE WHEN ms.fact_type = 'return' THEN -ms.amount_minor ELSE ms.amount_minor END), 0) AS gmv_minor
         FROM marketplace_sales ms JOIN stores s ON s.id = ms.store_id
         WHERE ms.sale_at_ms >= ? AND ms.sale_at_ms < ?${marketplaceSalesStoreFilter}
         GROUP BY s.id, s.name, s.color, ms.currency
       ) GROUP BY store_id, store_name, color, platform, currency`,
    ).all(previous.from.getTime(), previous.to.getTime(), ...marketplaceStoreParams, previous.from.getTime(), previous.to.getTime(), ...marketplaceStoreParams) as BreakdownRow[];

    const statusFilter = filter;
    const ozonStatusRows = platform === "wildberries" ? [] : this.database.prepare(
      `SELECT ${statusCase("p.status", "p.cancelled_at_ms")} AS status, COUNT(*) AS count
       FROM postings p WHERE ${statusFilter.sql}
       GROUP BY status`,
    ).all(...statusFilter.parameters) as StatusCountRow[];
    const wbStatusRows = platform === "ozon" ? [] : this.database.prepare(
      `SELECT ${statusCase("mo.status", "mo.cancelled_at_ms")} AS status, COUNT(DISTINCT mo.external_order_id) AS count
       FROM marketplace_orders mo WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
       GROUP BY status`,
    ).all(window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams) as StatusCountRow[];
    const statusTotals = new Map<DashboardOrderStatus, number>();
    for (const row of [...ozonStatusRows, ...wbStatusRows]) {
      statusTotals.set(row.status, (statusTotals.get(row.status) ?? 0) + row.count);
    }

    const isSingleDay = isSingleBeijingDay(window);
    const hourlyRows = isSingleDay ? [
      ...(platform === "wildberries" ? [] : this.database.prepare(
        `SELECT CAST(strftime('%H', datetime(p.order_at_ms / 1000 + 28800, 'unixepoch')) AS INTEGER) AS hour,
                COUNT(*) AS orders
         FROM postings p WHERE ${filter.sql}
         GROUP BY hour ORDER BY hour`,
        ).all(...filter.parameters) as Array<{ hour: number; orders: number }>),
      ...(platform === "ozon" ? [] : this.database.prepare(
        `SELECT CAST(strftime('%H', datetime(mo.order_at_ms / 1000 + 28800, 'unixepoch')) AS INTEGER) AS hour,
                COUNT(DISTINCT mo.external_order_id) AS orders
         FROM marketplace_orders mo
         WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
         GROUP BY hour ORDER BY hour`,
      ).all(window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams) as Array<{ hour: number; orders: number }>),
    ] : [];
    const hourlyTotals = new Map<number, number>();
    for (const row of hourlyRows) {
      hourlyTotals.set(row.hour, (hourlyTotals.get(row.hour) ?? 0) + row.orders);
    }
    const hourlyOrders = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      orders: hourlyTotals.get(hour) ?? 0,
    }));
    const dailyRows = isSingleDay ? [] : [
      ...(platform === "wildberries" ? [] : this.database.prepare(
        `SELECT strftime('%Y-%m-%d', datetime(p.order_at_ms / 1000 + 28800, 'unixepoch')) AS day,
                COUNT(*) AS orders
         FROM postings p WHERE ${filter.sql}
         GROUP BY day`,
      ).all(...filter.parameters) as Array<{ day: string; orders: number }>),
      ...(platform === "ozon" ? [] : this.database.prepare(
        `SELECT strftime('%Y-%m-%d', datetime(mo.order_at_ms / 1000 + 28800, 'unixepoch')) AS day,
                COUNT(DISTINCT mo.external_order_id) AS orders
         FROM marketplace_orders mo
         WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
         GROUP BY day`,
      ).all(window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams) as Array<{ day: string; orders: number }>),
    ];
    const dailyTotals = new Map<string, number>();
    for (const row of dailyRows) {
      dailyTotals.set(row.day, (dailyTotals.get(row.day) ?? 0) + row.orders);
    }
    const dailyOrders: DashboardDailyOrders[] = isSingleDay ? [] : getBeijingDays(window).map((day) => {
      const key = format(day, "yyyy-MM-dd");
      return { day: key, orders: dailyTotals.get(key) ?? 0 };
    });

    const ozonProducts = platform === "wildberries" ? [] : this.database.prepare(
      `SELECT p.store_id, item.sku, item.offer_id, item.name, image.primary_image_url AS image_url,
              item.currency, SUM(item.quantity) AS quantity,
              SUM(item.unit_price_minor * item.quantity) AS gmv_minor
       FROM posting_items item JOIN postings p ON p.id = item.posting_id
       LEFT JOIN product_images image ON image.store_id = p.store_id AND image.sku = item.sku
       WHERE ${filter.sql}
       GROUP BY p.store_id, item.sku, item.offer_id, item.name, image.primary_image_url, item.currency`,
    ).all(...filter.parameters) as ProductMetricRow[];
    const wbProducts = platform === "ozon" ? [] : this.database.prepare(
      `SELECT mo.store_id, item.sku, item.offer_id, item.name, NULL AS image_url, item.currency, SUM(item.quantity) AS quantity,
              SUM(item.unit_price_minor * item.quantity) AS gmv_minor
       FROM marketplace_order_items item JOIN marketplace_orders mo ON mo.id = item.order_id
       WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
       GROUP BY mo.store_id, item.sku, item.offer_id, item.name, item.currency`,
    ).all(window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams) as ProductMetricRow[];
    const productTotals = new Map<string, {
      sku: string; name: string; nameQuantity: number; quantity: number; gmv: Map<string, number>;
      offerIds: Set<string>; imageUrl: string | null; imageStoreQuantity: number;
      storeQuantity: Map<string, number>; storeImages: Map<string, { quantity: number; imageUrl: string | null }>;
    }>();
    for (const row of [...ozonProducts, ...wbProducts]) {
      const key = row.sku || row.name;
      const product = productTotals.get(key) ?? {
        sku: row.sku, name: row.name, nameQuantity: 0, quantity: 0, gmv: new Map<string, number>(),
        offerIds: new Set<string>(), imageUrl: null, imageStoreQuantity: -1,
        storeQuantity: new Map<string, number>(), storeImages: new Map(),
      };
      product.quantity += row.quantity;
      if (row.name && row.quantity > product.nameQuantity) {
        product.name = row.name;
        product.nameQuantity = row.quantity;
      }
      product.gmv.set(row.currency, (product.gmv.get(row.currency) ?? 0) + row.gmv_minor);
      if (row.offer_id) product.offerIds.add(row.offer_id);
      if (row.store_id) {
        product.storeQuantity.set(row.store_id, (product.storeQuantity.get(row.store_id) ?? 0) + row.quantity);
        const candidate = product.storeImages.get(row.store_id) ?? { quantity: 0, imageUrl: null };
        candidate.quantity += row.quantity;
        candidate.imageUrl ??= row.image_url;
        product.storeImages.set(row.store_id, candidate);
      }
      productTotals.set(key, product);
    }
    const topProducts = [...productTotals.values()]
      .sort((left, right) => right.quantity - left.quantity || left.name.localeCompare(right.name))
      .slice(0, 20)
      .map((product) => {
        const imageStore = [...product.storeImages.values()]
          .filter((store) => store.imageUrl)
          .sort((left, right) => right.quantity - left.quantity)[0];
        return ({
        sku: product.sku,
        name: product.name,
        imageUrl: imageStore?.imageUrl ?? null,
        offerIds: [...product.offerIds].sort((left, right) => left.localeCompare(right)),
        quantity: product.quantity,
        gmv: [...product.gmv.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, amount]) => moneyFromMinorUnits(amount, currency)),
        });
      });

    const totalComparisonOrders = previousSummary.reduce((sum, row) => sum + row.orders, 0);
    const comparisonGmv = buildKpis(previousSummary).gmv;

    const recentRows = this.database.prepare(
      `SELECT p.id, p.posting_number, p.store_id, s.name AS store_name, s.color AS store_color,
              'ozon' AS platform, p.posting_number AS external_order_id,
              p.order_at_ms, p.gross_amount_minor, p.currency,
              COALESCE((SELECT SUM(quantity) FROM posting_items WHERE posting_id = p.id), 0) AS item_count,
              COALESCE((
                SELECT json_group_array(name)
                FROM (
                  SELECT DISTINCT name FROM posting_items
                  WHERE posting_id = p.id AND name <> ''
                  ORDER BY name
                )
              ), '[]') AS product_names_json,
              (SELECT image.primary_image_url
               FROM posting_items image_item
               JOIN product_images image ON image.store_id = p.store_id AND image.sku = image_item.sku
               WHERE image_item.posting_id = p.id AND image.primary_image_url IS NOT NULL
               ORDER BY image_item.id LIMIT 1) AS image_url,
              p.fulfillment_mode, p.status, p.cancelled_at_ms
       FROM postings p
       JOIN stores s ON s.id = p.store_id
       WHERE ${filter.sql}
       UNION ALL
       SELECT mo.id, mo.external_order_id AS posting_number, mo.store_id, s.name AS store_name, s.color AS store_color,
              'wildberries' AS platform, mo.external_order_id,
              mo.order_at_ms, mo.gross_amount_minor, mo.currency,
              COALESCE((SELECT SUM(quantity) FROM marketplace_order_items WHERE order_id = mo.id), 0) AS item_count,
              COALESCE((SELECT json_group_array(name) FROM (
                SELECT DISTINCT name FROM marketplace_order_items WHERE order_id = mo.id AND name <> '' ORDER BY name
              )), '[]') AS product_names_json,
              NULL AS image_url,
              mo.fulfillment_mode, mo.status, mo.cancelled_at_ms
       FROM marketplace_orders mo
       JOIN stores s ON s.id = mo.store_id
       WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
       ORDER BY order_at_ms DESC
       LIMIT 50`,
    ).all(...filter.parameters, window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams) as RecentOrderRow[];

    const allStores = await this.storesRepository.list();
    const syncStores = allStores.filter((store) =>
      (storeIds.length === 0 || storeIds.includes(store.id))
      && (platform === "all" || store.platform === platform),
    );
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      range,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      granularity: window.granularity,
      kpis: buildKpis(summaryRows),
      comparison: {
        label: range === "today" ? "较昨日同期" : range === "yesterday" ? "较前日" : "较上一周期",
        previousOrders: totalComparisonOrders,
        previousGmv: comparisonGmv,
      },
      statusRange: { from: window.from.toISOString(), to: window.to.toISOString(), label: rangeLabel(range) },
      orderStatuses: [...statusTotals.entries()].map(([status, count]) => ({ status, count })),
      hourlyOrders,
      dailyOrders,
      timeDistributionMode: isSingleDay ? "hourly" : "daily",
      topProducts,
      platforms: buildPlatformBreakdown(platformSummaryRows),
      timeSeries: buildDashboardSeries(seriesRows, window),
      previousTimeSeries: range === "today" ? buildDashboardSeries(previousSeriesRows, previous) : [],
      stores: buildBreakdown(breakdownRows, [...previousOzonBreakdown, ...previousWbBreakdown]),
      recentOrders: recentRows.map((row) => ({
        id: row.id,
        platform: row.platform,
        externalOrderId: row.external_order_id,
        postingNumber: row.posting_number,
        storeId: row.store_id,
        storeName: row.store_name,
        storeColor: row.store_color,
        orderAt: new Date(row.order_at_ms).toISOString(),
        amount: moneyFromMinorUnits(row.gross_amount_minor, row.currency),
        itemCount: row.item_count,
        productNames: JSON.parse(row.product_names_json) as string[],
        imageUrl: row.image_url,
        fulfillment: row.fulfillment_mode,
        status: row.status,
        cancelled: row.cancelled_at_ms !== null,
      })),
      sync: syncStores.map(toStoreView),
    };
  }
}
