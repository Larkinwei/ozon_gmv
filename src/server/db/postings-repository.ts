import { randomUUID } from "node:crypto";

import type { NormalizedPosting } from "../ozon/normalize";
import type { AppDatabase } from "./database";
import { amountToMinorUnits } from "./money-storage";

export type PostingMutationKind = "created" | "updated" | "unchanged";

export interface PostingMutation {
  id: string;
  kind: PostingMutationKind;
}

interface ExistingPostingRow {
  id: string;
  fulfillment_mode: string;
  order_at_ms: number;
  status: string;
  substatus: string | null;
  gross_amount_minor: number;
  currency: string;
  cancelled_at_ms: number | null;
}

function postingChanged(existing: ExistingPostingRow, posting: NormalizedPosting): boolean {
  return (
    existing.fulfillment_mode !== posting.fulfillmentMode ||
    existing.order_at_ms !== posting.orderAt.getTime() ||
    existing.status !== posting.status ||
    existing.substatus !== posting.substatus ||
    existing.gross_amount_minor !== amountToMinorUnits(posting.grossAmount) ||
    existing.currency !== posting.currency ||
    Boolean(existing.cancelled_at_ms) !== Boolean(posting.cancelledAt)
  );
}

export class PostingsRepository {
  public constructor(private readonly database: AppDatabase) {}

  /** Upserts one canonical posting and replaces its non-PII item projection atomically. */
  public async upsert(storeId: string, posting: NormalizedPosting): Promise<PostingMutation> {
    return this.database.transaction((): PostingMutation => {
      const existing = this.database.prepare(
        `SELECT id, fulfillment_mode, order_at_ms, status, substatus,
                gross_amount_minor, currency, cancelled_at_ms
         FROM postings
         WHERE store_id = ? AND posting_number = ?`,
      ).get(storeId, posting.postingNumber) as ExistingPostingRow | undefined;

      if (existing && !postingChanged(existing, posting)) {
        return { id: existing.id, kind: "unchanged" };
      }

      const postingId = existing?.id ?? randomUUID();
      const now = Date.now();
      if (existing) {
        this.database.prepare(
          `UPDATE postings SET
             order_number = ?, fulfillment_mode = ?, order_at_ms = ?, status = ?,
             substatus = ?, gross_amount_minor = ?, currency = ?, cancelled_at_ms = ?,
             updated_at_ms = ?
           WHERE id = ?`,
        ).run(
          posting.orderNumber,
          posting.fulfillmentMode,
          posting.orderAt.getTime(),
          posting.status,
          posting.substatus,
          amountToMinorUnits(posting.grossAmount),
          posting.currency,
          posting.cancelledAt?.getTime() ?? null,
          now,
          postingId,
        );
        this.database.prepare("DELETE FROM posting_items WHERE posting_id = ?").run(postingId);
      } else {
        this.database.prepare(
          `INSERT INTO postings (
             id, store_id, posting_number, order_number, fulfillment_mode, order_at_ms,
             status, substatus, gross_amount_minor, currency, cancelled_at_ms,
             created_at_ms, updated_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          postingId,
          storeId,
          posting.postingNumber,
          posting.orderNumber,
          posting.fulfillmentMode,
          posting.orderAt.getTime(),
          posting.status,
          posting.substatus,
          amountToMinorUnits(posting.grossAmount),
          posting.currency,
          posting.cancelledAt?.getTime() ?? null,
          now,
          now,
        );
      }

      const insertItem = this.database.prepare(
        `INSERT INTO posting_items (
           id, posting_id, sku, offer_id, name, quantity, unit_price_minor, currency
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of posting.items) {
        insertItem.run(
          randomUUID(),
          postingId,
          item.sku,
          item.offerId,
          item.name,
          item.quantity,
          amountToMinorUnits(item.unitPrice),
          item.currency,
        );
      }
      return { id: postingId, kind: existing ? "updated" : "created" };
    })();
  }
}
