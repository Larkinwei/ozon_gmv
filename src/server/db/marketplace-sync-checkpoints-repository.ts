import type { AppDatabase } from "./database";

export type MarketplaceSyncSource = "orders" | "sales";

export interface MarketplaceSyncCheckpoint {
  windowFrom: Date | null;
  windowTo: Date | null;
}

interface CheckpointRow {
  window_from_ms: number | null;
  window_to_ms: number | null;
}

export class MarketplaceSyncCheckpointsRepository {
  public constructor(private readonly database: AppDatabase) {}

  public find(storeId: string, source: MarketplaceSyncSource): MarketplaceSyncCheckpoint | null {
    const row = this.database.prepare(
      `SELECT window_from_ms, window_to_ms
       FROM marketplace_sync_checkpoints
       WHERE store_id = ? AND platform = 'wildberries' AND source = ?`,
    ).get(storeId, source) as CheckpointRow | undefined;
    if (!row) return null;
    return {
      windowFrom: row.window_from_ms === null ? null : new Date(row.window_from_ms),
      windowTo: row.window_to_ms === null ? null : new Date(row.window_to_ms),
    };
  }

  public save(storeId: string, source: MarketplaceSyncSource, windowFrom: Date, windowTo: Date): void {
    this.database.prepare(
      `INSERT INTO marketplace_sync_checkpoints (
         store_id, platform, source, window_from_ms, window_to_ms, updated_at_ms
       ) VALUES (?, 'wildberries', ?, ?, ?, ?)
       ON CONFLICT(store_id, platform, source) DO UPDATE SET
         window_from_ms = excluded.window_from_ms,
         window_to_ms = excluded.window_to_ms,
         updated_at_ms = excluded.updated_at_ms`,
    ).run(storeId, source, windowFrom.getTime(), windowTo.getTime(), Date.now());
  }
}
