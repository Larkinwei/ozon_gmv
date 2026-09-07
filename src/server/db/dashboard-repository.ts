import Decimal from "decimal.js";

import type {
  DashboardKpis,
  DashboardRange,
  DashboardSnapshot,
  Money,
  OrderDetail,
  PlatformBreakdown,
  RecentOrder,
  StoreBreakdown,
  StorePlatform,
} from "../../shared/contracts";
import { buildDashboardSeries, type DashboardSeriesRow } from "../domain/dashboard-series";
import type { DashboardWindow } from "../domain/time-range";
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

function moneyFromMinorUnits(amount: number, currency: string): Money {
  return { amount: minorUnitsToAmount(amount), currency };
}

function bucketExpression(granularity: DashboardWindow["granularity"]): string {
  if (granularity === "15m") {
    return "CAST(p.order_at_ms / 900000 AS INTEGER) * 900000";
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

function buildBreakdown(rows: BreakdownRow[]): StoreBreakdown[] {
  const stores = new Map<string, StoreBreakdown>();
  for (const row of rows) {
    const existing = stores.get(row.store_id) ?? {
      storeId: row.store_id,
      storeName: row.store_name,
      color: row.color,
      platform: row.platform,
      orders: 0,
      gmv: [],
    };
    existing.orders += row.orders;
    existing.gmv.push(moneyFromMinorUnits(row.gmv_minor, row.currency));
    stores.set(row.store_id, existing);
  }

  const breakdown = [...stores.values()];
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
  if (granularity === "15m") {
    return `CAST(${column} / 900000 AS INTEGER) * 900000`;
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
    const seriesBucket = bucketExpression(window.granularity);
    const wbOrderBucket = marketplaceBucketExpression("mo.order_at_ms", window.granularity);
    const wbSalesBucket = marketplaceBucketExpression("ms.sale_at_ms", window.granularity);

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

    const seriesSqlRows = this.database.prepare(
      `SELECT ${seriesBucket} AS bucket_ms,
              p.store_id, s.name AS store_name, s.color AS store_color, p.currency,
              COUNT(*) AS orders,
              COALESCE(SUM(p.gross_amount_minor), 0) AS gmv_minor
       FROM postings p
       JOIN stores s ON s.id = p.store_id
       WHERE ${filter.sql}
       GROUP BY bucket_ms, p.store_id, s.name, s.color, p.currency
       ORDER BY bucket_ms ASC, s.name ASC, p.currency ASC`,
    ).all(...filter.parameters) as SeriesSqlRow[];
    const wbSeriesRows = this.database.prepare(
      `SELECT bucket_ms, store_id, store_name, store_color, currency,
              SUM(orders) AS orders, SUM(gmv_minor) AS gmv_minor
       FROM (
         SELECT ${wbOrderBucket} AS bucket_ms,
                mo.store_id, s.name AS store_name, s.color AS store_color, mo.currency,
                COUNT(DISTINCT mo.external_order_id) AS orders, 0 AS gmv_minor
         FROM marketplace_orders mo JOIN stores s ON s.id = mo.store_id
         WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${marketplaceStoreFilter}
         GROUP BY bucket_ms, mo.store_id, s.name, s.color, mo.currency
         UNION ALL
         SELECT ${wbSalesBucket} AS bucket_ms,
                ms.store_id, s.name AS store_name, s.color AS store_color, ms.currency,
                0 AS orders,
                COALESCE(SUM(CASE WHEN ms.fact_type = 'return' THEN -ms.amount_minor ELSE ms.amount_minor END), 0) AS gmv_minor
         FROM marketplace_sales ms JOIN stores s ON s.id = ms.store_id
         WHERE ms.sale_at_ms >= ? AND ms.sale_at_ms < ?${marketplaceSalesStoreFilter}
         GROUP BY bucket_ms, ms.store_id, s.name, s.color, ms.currency
       )
       GROUP BY bucket_ms, store_id, store_name, store_color, currency
       ORDER BY bucket_ms ASC, store_name ASC, currency ASC`,
    ).all(window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams, window.from.getTime(), window.to.getTime(), ...marketplaceStoreParams) as SeriesSqlRow[];
    const seriesRows: DashboardSeriesRow[] = [...seriesSqlRows, ...wbSeriesRows].map((row) => ({
      bucket: new Date(row.bucket_ms),
      storeId: row.store_id,
      storeName: row.store_name,
      storeColor: row.store_color,
      currency: row.currency,
      orders: row.orders,
      gmv: minorUnitsToAmount(row.gmv_minor),
    }));

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
      platforms: buildPlatformBreakdown(platformSummaryRows),
      timeSeries: buildDashboardSeries(seriesRows, window),
      stores: buildBreakdown(breakdownRows),
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
        fulfillment: row.fulfillment_mode,
        status: row.status,
        cancelled: row.cancelled_at_ms !== null,
      })),
      sync: syncStores.map(toStoreView),
    };
  }
}
