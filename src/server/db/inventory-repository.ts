import { randomUUID } from "node:crypto";

import type { FulfillmentMode, InventoryLowStockAlert } from "../../shared/contracts";
import type { AppDatabase } from "./database";

export interface InventoryCandidate {
  sku: string;
  offerId: string;
  fulfillment: FulfillmentMode;
  productName: string;
  imageUrl: string | null;
}

export interface InventoryStockRow {
  warehouseId: string;
  warehouseName: string | null;
  productId: string | null;
  availableStock: number;
  reservedStock: number;
}

export interface InventoryEvaluation {
  alert: InventoryLowStockAlert | null;
  newlyOpened: boolean;
}

interface AlertRow {
  id: string;
  store_id: string;
  store_name: string;
  store_color: string;
  sku: string;
  offer_id: string;
  fulfillment_mode: FulfillmentMode;
  product_name: string;
  image_url: string | null;
  available_stock: number;
  reserved_stock: number;
  threshold: number;
  first_low_at_ms: number;
  last_checked_at_ms: number;
}

function toAlert(row: AlertRow): InventoryLowStockAlert {
  return {
    id: row.id,
    storeId: row.store_id,
    storeName: row.store_name,
    storeColor: row.store_color,
    sku: row.sku,
    offerId: row.offer_id,
    fulfillment: row.fulfillment_mode,
    productName: row.product_name,
    imageUrl: row.image_url,
    availableStock: row.available_stock,
    reservedStock: row.reserved_stock,
    threshold: row.threshold,
    firstLowAt: new Date(row.first_low_at_ms).toISOString(),
    lastCheckedAt: new Date(row.last_checked_at_ms).toISOString(),
  };
}

export class InventoryRepository {
  public constructor(private readonly database: AppDatabase) {}

  public listCandidates(storeId: string): InventoryCandidate[] {
    const rows = this.database.prepare(
      `SELECT i.sku, i.offer_id, p.fulfillment_mode,
              MAX(i.name) AS product_name, MAX(image.primary_image_url) AS image_url
       FROM postings p
       JOIN posting_items i ON i.posting_id = p.id
       LEFT JOIN product_images image ON image.store_id = p.store_id AND image.sku = i.sku
       WHERE p.store_id = ?
       GROUP BY i.sku, i.offer_id, p.fulfillment_mode
       ORDER BY i.sku ASC`,
    ).all(storeId) as Array<{ sku: string; offer_id: string; fulfillment_mode: FulfillmentMode; product_name: string; image_url: string | null }>;
    return rows.map((row) => ({
      sku: row.sku,
      offerId: row.offer_id,
      fulfillment: row.fulfillment_mode,
      productName: row.product_name || row.sku,
      imageUrl: row.image_url,
    }));
  }

  public replaceSnapshots(storeId: string, candidate: InventoryCandidate, checkedAt: number, rows: InventoryStockRow[]): void {
    const remove = this.database.prepare(
      `DELETE FROM inventory_stock_snapshots
       WHERE store_id = ? AND sku = ? AND offer_id = ? AND fulfillment_mode = ?`,
    );
    const insert = this.database.prepare(
      `INSERT INTO inventory_stock_snapshots (
         id, store_id, sku, offer_id, fulfillment_mode, warehouse_id, warehouse_name,
         product_id, product_name, image_url, available_stock, reserved_stock, checked_at_ms, last_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    );
    this.database.transaction(() => {
      remove.run(storeId, candidate.sku, candidate.offerId, candidate.fulfillment);
      for (const row of rows) {
        insert.run(
          randomUUID(), storeId, candidate.sku, candidate.offerId, candidate.fulfillment,
          row.warehouseId, row.warehouseName, row.productId, candidate.productName, candidate.imageUrl,
          row.availableStock, row.reservedStock, checkedAt,
        );
      }
    })();
  }

  public evaluate(storeId: string, candidate: InventoryCandidate, checkedAt: number, threshold: number): InventoryEvaluation {
    const snooze = this.database.prepare(
      `SELECT suppressed_until_ms FROM inventory_sku_snoozes WHERE store_id = ? AND sku = ?`,
    ).get(storeId, candidate.sku) as { suppressed_until_ms: number } | undefined;
    const isSnoozed = Boolean(snooze && snooze.suppressed_until_ms > checkedAt);
    const totals = this.database.prepare(
      `SELECT COALESCE(SUM(available_stock), 0) AS available_stock,
              COALESCE(SUM(reserved_stock), 0) AS reserved_stock
       FROM inventory_stock_snapshots
       WHERE store_id = ? AND sku = ? AND offer_id = ? AND fulfillment_mode = ?`,
    ).get(storeId, candidate.sku, candidate.offerId, candidate.fulfillment) as { available_stock: number; reserved_stock: number };
    const existing = this.database.prepare(
      `SELECT id, status, last_checked_at_ms FROM inventory_alerts
       WHERE store_id = ? AND sku = ? AND offer_id = ? AND fulfillment_mode = ?`,
    ).get(storeId, candidate.sku, candidate.offerId, candidate.fulfillment) as { id: string; status: string; last_checked_at_ms: number } | undefined;

    if (totals.available_stock < threshold) {
      const id = existing?.id ?? randomUUID();
      const snoozeExpiredSinceLastCheck = Boolean(
        !isSnoozed && snooze && existing
        && existing.last_checked_at_ms < snooze.suppressed_until_ms
        && checkedAt >= snooze.suppressed_until_ms,
      );
      const newlyOpened = !isSnoozed && (!existing || existing.status === "normal" || snoozeExpiredSinceLastCheck);
      this.database.prepare(
        `INSERT INTO inventory_alerts (
           id, store_id, sku, offer_id, fulfillment_mode, product_name, image_url,
           available_stock, reserved_stock, threshold, status, first_low_at_ms, last_checked_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
         ON CONFLICT (store_id, sku, offer_id, fulfillment_mode) DO UPDATE SET
           product_name = excluded.product_name, image_url = excluded.image_url,
           available_stock = excluded.available_stock, reserved_stock = excluded.reserved_stock,
           threshold = excluded.threshold, last_checked_at_ms = excluded.last_checked_at_ms,
           status = CASE WHEN ? THEN 'open' WHEN inventory_alerts.status = 'normal' THEN 'open' ELSE inventory_alerts.status END,
           first_low_at_ms = CASE WHEN inventory_alerts.status = 'normal' THEN excluded.first_low_at_ms ELSE inventory_alerts.first_low_at_ms END,
           acknowledged_at_ms = CASE WHEN inventory_alerts.status = 'normal' THEN NULL ELSE inventory_alerts.acknowledged_at_ms END,
           recovered_at_ms = NULL`,
      ).run(
        id, storeId, candidate.sku, candidate.offerId, candidate.fulfillment, candidate.productName, candidate.imageUrl,
        totals.available_stock, totals.reserved_stock, threshold, checkedAt, checkedAt, Number(isSnoozed),
      );
      const row = this.readAlert(storeId, candidate);
      return { alert: row ? toAlert(row) : null, newlyOpened };
    }

    if (existing) {
      this.database.prepare(
        `UPDATE inventory_alerts
         SET status = 'normal', available_stock = ?, reserved_stock = ?, last_checked_at_ms = ?, recovered_at_ms = COALESCE(recovered_at_ms, ?)
         WHERE id = ?`,
      ).run(totals.available_stock, totals.reserved_stock, checkedAt, checkedAt, existing.id);
    }
    return { alert: null, newlyOpened: false };
  }

  public listOpenAlerts(now = Date.now()): InventoryLowStockAlert[] {
    const rows = this.database.prepare(
      `SELECT a.id, a.store_id, s.name AS store_name, s.color AS store_color,
              a.sku, a.offer_id, a.fulfillment_mode, a.product_name, a.image_url,
              a.available_stock, a.reserved_stock, a.threshold, a.first_low_at_ms, a.last_checked_at_ms
       FROM inventory_alerts a JOIN stores s ON s.id = a.store_id
       WHERE a.status = 'open'
         AND NOT EXISTS (
           SELECT 1 FROM inventory_sku_snoozes snooze
           WHERE snooze.store_id = a.store_id AND snooze.sku = a.sku AND snooze.suppressed_until_ms > ?
         )
       ORDER BY a.available_stock ASC, a.last_checked_at_ms DESC`,
    ).all(now) as AlertRow[];
    return rows.map(toAlert);
  }

  public snoozeSku(storeId: string, sku: string, now = Date.now()): number {
    const suppressedUntil = now + 7 * 24 * 60 * 60 * 1000;
    this.database.prepare(
      `INSERT INTO inventory_sku_snoozes (store_id, sku, suppressed_until_ms)
       VALUES (?, ?, ?)
       ON CONFLICT (store_id, sku) DO UPDATE SET suppressed_until_ms = excluded.suppressed_until_ms`,
    ).run(storeId, sku, suppressedUntil);
    return suppressedUntil;
  }

  public acknowledge(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(", ");
    this.database.prepare(
      `UPDATE inventory_alerts SET status = 'acknowledged', acknowledged_at_ms = ?
       WHERE status = 'open' AND id IN (${placeholders})`,
    ).run(Date.now(), ...ids);
  }

  private readAlert(storeId: string, candidate: InventoryCandidate): AlertRow | undefined {
    return this.database.prepare(
      `SELECT a.id, a.store_id, s.name AS store_name, s.color AS store_color,
              a.sku, a.offer_id, a.fulfillment_mode, a.product_name, a.image_url,
              a.available_stock, a.reserved_stock, a.threshold, a.first_low_at_ms, a.last_checked_at_ms
       FROM inventory_alerts a JOIN stores s ON s.id = a.store_id
       WHERE a.store_id = ? AND a.sku = ? AND a.offer_id = ? AND a.fulfillment_mode = ?`,
    ).get(storeId, candidate.sku, candidate.offerId, candidate.fulfillment) as AlertRow | undefined;
  }
}
