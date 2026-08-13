import type { AppDatabase } from "./database";

export interface ProductImageCandidate {
  sku: string;
  offerId: string;
}

export interface ProductImageRecord extends ProductImageCandidate {
  imageUrl: string | null;
}

interface ProductImageCandidateRow {
  sku: string;
  offer_id: string;
}

export class ProductImagesRepository {
  public constructor(private readonly database: AppDatabase) {}

  /** Returns one safe cached image URL for desktop notification enrichment. */
  public findImageUrl(storeId: string, sku: string | undefined): string | null {
    if (!sku) {
      return null;
    }
    const row = this.database.prepare(
      `SELECT primary_image_url
       FROM product_images
       WHERE store_id = ? AND sku = ?`,
    ).get(storeId, sku) as { primary_image_url: string | null } | undefined;
    return row?.primary_image_url ?? null;
  }

  /** Lists recently ordered products whose image cache is missing or stale. */
  public listStale(storeId: string, refreshedBefore: number, limit: number): ProductImageCandidate[] {
    const rows = this.database.prepare(
      `SELECT i.sku, MAX(i.offer_id) AS offer_id
       FROM posting_items i
       JOIN postings p ON p.id = i.posting_id
       LEFT JOIN product_images image ON image.store_id = p.store_id AND image.sku = i.sku
       WHERE p.store_id = ?
         AND (image.refreshed_at_ms IS NULL OR image.refreshed_at_ms < ?)
       GROUP BY i.sku
       ORDER BY MAX(p.order_at_ms) DESC
       LIMIT ?`,
    ).all(storeId, refreshedBefore, limit) as ProductImageCandidateRow[];

    return rows.map((row) => ({ sku: row.sku, offerId: row.offer_id }));
  }

  /** Replaces one successful Ozon lookup batch without storing image binaries. */
  public saveBatch(storeId: string, records: ProductImageRecord[], refreshedAt: number): void {
    const upsert = this.database.prepare(
      `INSERT INTO product_images (store_id, sku, offer_id, primary_image_url, refreshed_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (store_id, sku) DO UPDATE SET
         offer_id = excluded.offer_id,
         primary_image_url = excluded.primary_image_url,
         refreshed_at_ms = excluded.refreshed_at_ms`,
    );
    this.database.transaction(() => {
      for (const record of records) {
        upsert.run(storeId, record.sku, record.offerId, record.imageUrl, refreshedAt);
      }
    })();
  }
}
