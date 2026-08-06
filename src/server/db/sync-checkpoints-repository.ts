import type { AppDatabase } from "./database";

export type SyncSource = "FBO" | "FBS";

interface SyncCheckpointRow {
  cursor: string | null;
  window_from_ms: number | null;
  window_to_ms: number | null;
}

export interface SyncCheckpoint {
  cursor: string | null;
  windowFrom: Date | null;
  windowTo: Date | null;
}

/** Persists page progress only after a page has been committed idempotently. */
export class SyncCheckpointsRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async find(storeId: string, source: SyncSource): Promise<SyncCheckpoint | null> {
    const row = this.database.prepare(
      `SELECT cursor, window_from_ms, window_to_ms
       FROM sync_checkpoints
       WHERE store_id = ? AND fulfillment_mode = ?`,
    ).get(storeId, source) as SyncCheckpointRow | undefined;
    if (!row) {
      return null;
    }
    return {
      cursor: row.cursor,
      windowFrom: row.window_from_ms === null ? null : new Date(row.window_from_ms),
      windowTo: row.window_to_ms === null ? null : new Date(row.window_to_ms),
    };
  }

  public async save(
    storeId: string,
    source: SyncSource,
    windowFrom: Date,
    windowTo: Date,
    cursor: string | null,
  ): Promise<void> {
    this.database.prepare(
      `INSERT INTO sync_checkpoints (
         store_id, fulfillment_mode, cursor, window_from_ms, window_to_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (store_id, fulfillment_mode) DO UPDATE SET
         cursor = excluded.cursor,
         window_from_ms = excluded.window_from_ms,
         window_to_ms = excluded.window_to_ms,
         updated_at_ms = excluded.updated_at_ms`,
    ).run(storeId, source, cursor, windowFrom.getTime(), windowTo.getTime(), Date.now());
  }
}
