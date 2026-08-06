import { createHash, randomBytes } from "node:crypto";

import type { FulfillmentMode, StoreView, SyncHealth } from "../../shared/contracts";
import type { AppDatabase } from "./database";

interface StoreRow {
  id: string;
  name: string;
  client_id: string;
  api_key_ciphertext: string;
  color: string;
  enabled: number;
  api_key_expires_at_ms: number | null;
  last_sync_started_at_ms: number | null;
  last_sync_finished_at_ms: number | null;
  last_sync_error: string | null;
}

interface ModeRow {
  mode: FulfillmentMode;
}

export interface StoreRecord extends StoreView {
  apiKeyCiphertext: string;
}

export interface CreateStoreRecord {
  id: string;
  name: string;
  clientId: string;
  apiKeyCiphertext: string;
  color: string;
  fulfillmentModes: FulfillmentMode[];
  apiKeyExpiresAt: string | null;
}

export interface UpdateStoreRecord {
  name?: string;
  color?: string;
  enabled?: boolean;
  fulfillmentModes?: FulfillmentMode[];
  apiKeyCiphertext?: string;
  apiKeyExpiresAt?: string | null;
}

function toIsoString(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function calculateSyncHealth(row: StoreRow, now = Date.now()): SyncHealth {
  if (row.last_sync_error) {
    return "error";
  }
  if (row.last_sync_finished_at_ms === null) {
    return "never";
  }
  const ageSeconds = (now - row.last_sync_finished_at_ms) / 1000;
  if (ageSeconds > 600) {
    return "error";
  }
  return ageSeconds > 180 ? "delayed" : "healthy";
}

export function toStoreView(store: StoreRecord): StoreView {
  const { apiKeyCiphertext: _apiKey, ...view } = store;
  return view;
}

export class StoresRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async list(): Promise<StoreRecord[]> {
    const rows = this.database.prepare("SELECT * FROM stores ORDER BY created_at_ms ASC").all() as StoreRow[];
    return rows.map((row) => this.mapStore(row));
  }

  public async listActive(): Promise<StoreRecord[]> {
    const rows = this.database.prepare("SELECT * FROM stores WHERE enabled = 1 ORDER BY created_at_ms ASC").all() as StoreRow[];
    return rows.map((row) => this.mapStore(row));
  }

  public async findById(id: string): Promise<StoreRecord | null> {
    const row = this.database.prepare("SELECT * FROM stores WHERE id = ?").get(id) as StoreRow | undefined;
    return row ? this.mapStore(row) : null;
  }

  public async create(input: CreateStoreRecord): Promise<StoreRecord> {
    const now = Date.now();
    this.database.transaction(() => {
      this.database.prepare(
        `INSERT INTO stores (
          id, name, client_id, api_key_ciphertext, webhook_token_hash, color,
          api_key_expires_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.name,
        input.clientId,
        input.apiKeyCiphertext,
        createHash("sha256").update(randomBytes(32)).digest("hex"),
        input.color,
        input.apiKeyExpiresAt ? Date.parse(input.apiKeyExpiresAt) : null,
        now,
        now,
      );
      this.replaceModes(input.id, input.fulfillmentModes);
    })();
    return this.findById(input.id) as Promise<StoreRecord>;
  }

  public async update(id: string, input: UpdateStoreRecord): Promise<StoreRecord | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    this.database.transaction(() => {
      this.database.prepare(
        `UPDATE stores SET
          name = ?, color = ?, enabled = ?, api_key_ciphertext = ?,
          api_key_expires_at_ms = ?, updated_at_ms = ?
         WHERE id = ?`,
      ).run(
        input.name ?? existing.name,
        input.color ?? existing.color,
        input.enabled === undefined ? Number(existing.enabled) : Number(input.enabled),
        input.apiKeyCiphertext ?? existing.apiKeyCiphertext,
        input.apiKeyExpiresAt === undefined
          ? existing.apiKeyExpiresAt ? Date.parse(existing.apiKeyExpiresAt) : null
          : input.apiKeyExpiresAt ? Date.parse(input.apiKeyExpiresAt) : null,
        Date.now(),
        id,
      );
      if (input.fulfillmentModes) {
        this.replaceModes(id, input.fulfillmentModes);
      }
    })();
    return this.findById(id);
  }

  public async markSyncStarted(id: string): Promise<void> {
    const now = Date.now();
    this.database
      .prepare("UPDATE stores SET last_sync_started_at_ms = ?, last_sync_error = NULL, updated_at_ms = ? WHERE id = ?")
      .run(now, now, id);
  }

  public async markSyncFinished(id: string): Promise<void> {
    const now = Date.now();
    this.database
      .prepare("UPDATE stores SET last_sync_finished_at_ms = ?, last_sync_error = NULL, updated_at_ms = ? WHERE id = ?")
      .run(now, now, id);
  }

  public async markSyncFailed(id: string, message: string): Promise<void> {
    this.database
      .prepare("UPDATE stores SET last_sync_error = ?, updated_at_ms = ? WHERE id = ?")
      .run(message.slice(0, 1000), Date.now(), id);
  }

  private mapStore(row: StoreRow): StoreRecord {
    const modes = this.database
      .prepare("SELECT mode FROM store_fulfillment_modes WHERE store_id = ? ORDER BY mode")
      .all(row.id) as ModeRow[];
    return {
      id: row.id,
      name: row.name,
      clientId: row.client_id,
      apiKeyCiphertext: row.api_key_ciphertext,
      color: row.color,
      enabled: Boolean(row.enabled),
      fulfillmentModes: modes.map((entry) => entry.mode),
      apiKeyExpiresAt: toIsoString(row.api_key_expires_at_ms),
      lastSyncStartedAt: toIsoString(row.last_sync_started_at_ms),
      lastSyncFinishedAt: toIsoString(row.last_sync_finished_at_ms),
      lastSyncError: row.last_sync_error,
      syncHealth: calculateSyncHealth(row),
    };
  }

  private replaceModes(storeId: string, modes: FulfillmentMode[]): void {
    this.database.prepare("DELETE FROM store_fulfillment_modes WHERE store_id = ?").run(storeId);
    const insert = this.database.prepare("INSERT INTO store_fulfillment_modes (store_id, mode) VALUES (?, ?)");
    for (const mode of modes) {
      insert.run(storeId, mode);
    }
  }
}
