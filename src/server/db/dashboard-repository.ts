import Decimal from "decimal.js";

import type {
  DashboardKpis,
  DashboardRange,
  DashboardSnapshot,
  Money,
  OrderDetail,
  RecentOrder,
  StoreBreakdown,
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
  currency: string;
  orders: number;
  gmv_minor: number;
}

interface RecentOrderRow {
  id: string;
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

function createFilter(window: DashboardWindow, storeIds: string[]): FilterClause {
  const storeFilter = storeIds.length > 0 ? ` AND p.store_id IN (${storeIds.map(() => "?").join(", ")})` : "";
  return {
    sql: `p.order_at_ms >= ? AND p.order_at_ms < ?${storeFilter}`,
    parameters: [window.from.getTime(), window.to.getTime(), ...storeIds],
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
      return null;
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
  ): Promise<DashboardSnapshot> {
    const filter = createFilter(window, storeIds);
    const seriesBucket = bucketExpression(window.granularity);

    const summaryRows = this.database.prepare(
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
    const seriesRows: DashboardSeriesRow[] = seriesSqlRows.map((row) => ({
      bucket: new Date(row.bucket_ms),
      storeId: row.store_id,
      storeName: row.store_name,
      storeColor: row.store_color,
      currency: row.currency,
      orders: row.orders,
      gmv: minorUnitsToAmount(row.gmv_minor),
    }));

    const breakdownRows = this.database.prepare(
      `SELECT s.id AS store_id, s.name AS store_name, s.color, p.currency,
              COUNT(*) AS orders,
              COALESCE(SUM(p.gross_amount_minor), 0) AS gmv_minor
       FROM postings p
       JOIN stores s ON s.id = p.store_id
       WHERE ${filter.sql}
       GROUP BY s.id, s.name, s.color, p.currency
       ORDER BY gmv_minor DESC`,
    ).all(...filter.parameters) as BreakdownRow[];

    const recentRows = this.database.prepare(
      `SELECT p.id, p.posting_number, p.store_id, s.name AS store_name, s.color AS store_color,
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
       ORDER BY p.order_at_ms DESC
       LIMIT 50`,
    ).all(...filter.parameters) as RecentOrderRow[];

    const allStores = await this.storesRepository.list();
    const syncStores = storeIds.length > 0 ? allStores.filter((store) => storeIds.includes(store.id)) : allStores;
    return {
      generatedAt: new Date().toISOString(),
      timezone: "Asia/Shanghai",
      range,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      granularity: window.granularity,
      kpis: buildKpis(summaryRows),
      timeSeries: buildDashboardSeries(seriesRows, window),
      stores: buildBreakdown(breakdownRows),
      recentOrders: recentRows.map((row) => ({
        id: row.id,
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
