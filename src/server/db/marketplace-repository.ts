import { randomUUID } from "node:crypto";

import type { AppDatabase } from "./database";
import { amountToMinorUnits } from "./money-storage";
import type { WildberriesOrder, WildberriesSale } from "../wildberries/normalize";

export type MarketplaceMutationKind = "created" | "updated" | "unchanged";

export interface MarketplaceMutation {
  id: string;
  kind: MarketplaceMutationKind;
}

interface ExistingOrderRow {
  id: string;
  order_at_ms: number;
  status: string;
  gross_amount_minor: number;
  currency: string;
  cancelled_at_ms: number | null;
}

function orderChanged(existing: ExistingOrderRow, order: WildberriesOrder): boolean {
  return existing.order_at_ms !== order.orderAt.getTime()
    || existing.status !== order.status
    || existing.gross_amount_minor !== amountToMinorUnits(order.grossAmount)
    || existing.currency !== order.currency
    || Boolean(existing.cancelled_at_ms) !== Boolean(order.cancelledAt);
}

export class MarketplaceRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async upsertOrder(storeId: string, order: WildberriesOrder): Promise<MarketplaceMutation> {
    return this.database.transaction((): MarketplaceMutation => {
      const existing = this.database.prepare(
        `SELECT id, order_at_ms, status, gross_amount_minor, currency, cancelled_at_ms
         FROM marketplace_orders
         WHERE store_id = ? AND platform = 'wildberries' AND external_order_id = ?`,
      ).get(storeId, order.externalOrderId) as ExistingOrderRow | undefined;
      if (existing && !orderChanged(existing, order)) {
        return { id: existing.id, kind: "unchanged" };
      }

      const id = existing?.id ?? randomUUID();
      const now = Date.now();
      if (existing) {
        this.database.prepare(
          `UPDATE marketplace_orders SET
             order_number = ?, fulfillment_mode = ?, order_at_ms = ?, status = ?,
             substatus = ?, gross_amount_minor = ?, currency = ?, cancelled_at_ms = ?,
             raw_json = ?, updated_at_ms = ?
           WHERE id = ?`,
        ).run(
          order.orderNumber,
          order.fulfillmentMode,
          order.orderAt.getTime(),
          order.status,
          order.substatus,
          amountToMinorUnits(order.grossAmount),
          order.currency,
          order.cancelledAt?.getTime() ?? null,
          order.rawJson,
          now,
          id,
        );
        this.database.prepare("DELETE FROM marketplace_order_items WHERE order_id = ?").run(id);
      } else {
        this.database.prepare(
          `INSERT INTO marketplace_orders (
             id, store_id, platform, external_order_id, order_number, fulfillment_mode,
             order_at_ms, status, substatus, gross_amount_minor, currency, cancelled_at_ms,
             raw_json, created_at_ms, updated_at_ms
           ) VALUES (?, ?, 'wildberries', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          storeId,
          order.externalOrderId,
          order.orderNumber,
          order.fulfillmentMode,
          order.orderAt.getTime(),
          order.status,
          order.substatus,
          amountToMinorUnits(order.grossAmount),
          order.currency,
          order.cancelledAt?.getTime() ?? null,
          order.rawJson,
          now,
          now,
        );
      }

      const insertItem = this.database.prepare(
        `INSERT INTO marketplace_order_items (
           id, order_id, sku, offer_id, name, quantity, unit_price_minor, currency
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of order.items) {
        insertItem.run(
          randomUUID(),
          id,
          item.sku,
          item.offerId,
          item.name,
          item.quantity,
          amountToMinorUnits(item.unitPrice),
          item.currency,
        );
      }
      return { id, kind: existing ? "updated" : "created" };
    })();
  }

  public async upsertSale(storeId: string, sale: WildberriesSale): Promise<MarketplaceMutation> {
    const existing = this.database.prepare(
      `SELECT id, sale_at_ms, fact_type, amount_minor, currency, quantity, name
       FROM marketplace_sales
       WHERE store_id = ? AND platform = 'wildberries' AND external_sale_id = ?`,
    ).get(storeId, sale.externalSaleId) as {
      id: string;
      sale_at_ms: number;
      fact_type: string;
      amount_minor: number;
      currency: string;
      quantity: number;
      name: string;
    } | undefined;
    const unchanged = existing
      && existing.sale_at_ms === sale.saleAt.getTime()
      && existing.fact_type === sale.factType
      && existing.amount_minor === amountToMinorUnits(sale.amount)
      && existing.currency === sale.currency
      && existing.quantity === sale.quantity
      && existing.name === sale.name;
    if (unchanged) {
      return { id: existing.id, kind: "unchanged" };
    }
    const id = existing?.id ?? randomUUID();
    const now = Date.now();
    if (existing) {
      this.database.prepare(
        `UPDATE marketplace_sales SET
           source_order_id = ?, sale_at_ms = ?, fact_type = ?, amount_minor = ?, currency = ?,
           sku = ?, offer_id = ?, name = ?, quantity = ?, raw_json = ?, updated_at_ms = ?
         WHERE id = ?`,
      ).run(
        sale.sourceOrderId,
        sale.saleAt.getTime(),
        sale.factType,
        amountToMinorUnits(sale.amount),
        sale.currency,
        sale.sku,
        sale.offerId,
        sale.name,
        sale.quantity,
        sale.rawJson,
        now,
        id,
      );
    } else {
      this.database.prepare(
        `INSERT INTO marketplace_sales (
           id, store_id, platform, external_sale_id, source_order_id, sale_at_ms, fact_type,
           amount_minor, currency, sku, offer_id, name, quantity, raw_json, created_at_ms, updated_at_ms
         ) VALUES (?, ?, 'wildberries', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        storeId,
        sale.externalSaleId,
        sale.sourceOrderId,
        sale.saleAt.getTime(),
        sale.factType,
        amountToMinorUnits(sale.amount),
        sale.currency,
        sale.sku,
        sale.offerId,
        sale.name,
        sale.quantity,
        sale.rawJson,
        now,
        now,
      );
    }
    return { id, kind: existing ? "updated" : "created" };
  }

  public listOrders(fromMs: number, toMs: number, storeIds: string[] = []): Array<Record<string, unknown>> {
    const storeFilter = storeIds.length > 0 ? ` AND mo.store_id IN (${storeIds.map(() => "?").join(", ")})` : "";
    return this.database.prepare(
      `SELECT mo.id, mo.store_id, store.name AS store_name, store.color AS store_color,
              mo.external_order_id, mo.order_number, mo.fulfillment_mode, mo.order_at_ms,
              mo.status, mo.substatus, mo.gross_amount_minor, mo.currency, mo.cancelled_at_ms,
              COALESCE((SELECT SUM(quantity) FROM marketplace_order_items WHERE order_id = mo.id), 0) AS item_count,
              COALESCE((SELECT json_group_array(name) FROM (
                SELECT DISTINCT name FROM marketplace_order_items WHERE order_id = mo.id AND name <> '' ORDER BY name
              )), '[]') AS product_names_json
       FROM marketplace_orders mo
       JOIN stores store ON store.id = mo.store_id
       WHERE mo.order_at_ms >= ? AND mo.order_at_ms < ?${storeFilter}
       ORDER BY mo.order_at_ms DESC
       LIMIT 50`,
    ).all(fromMs, toMs, ...storeIds) as Array<Record<string, unknown>>;
  }

  public listOrderItems(orderId: string): Array<Record<string, unknown>> {
    return this.database.prepare(
      `SELECT item.id, item.sku, item.offer_id, item.name, item.quantity,
              item.unit_price_minor, item.currency
       FROM marketplace_order_items item
       WHERE item.order_id = ? ORDER BY item.name ASC, item.sku ASC`,
    ).all(orderId) as Array<Record<string, unknown>>;
  }
}
