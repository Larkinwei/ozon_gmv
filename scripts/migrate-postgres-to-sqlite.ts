import { join, resolve } from "node:path";

import pg from "pg";

import { loadConfig } from "../src/server/config";
import { closeDatabase, openDatabase } from "../src/server/db/database";
import { runMigrations } from "../src/server/db/migrate";
import { amountToMinorUnits } from "../src/server/db/money-storage";
import { decryptSecret, encryptSecret } from "../src/server/security/encryption";

interface LegacyStoreRow {
  id: string;
  name: string;
  client_id: string;
  api_key_ciphertext: string;
  webhook_token_hash: string;
  color: string;
  enabled: boolean;
  fulfillment_modes: string[];
  api_key_expires_at: Date | null;
  last_sync_started_at: Date | null;
  last_sync_finished_at: Date | null;
  last_sync_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface LegacyPostingRow {
  id: string;
  store_id: string;
  posting_number: string;
  order_number: string;
  fulfillment_mode: string;
  order_at: Date;
  status: string;
  substatus: string | null;
  gross_amount: string;
  currency: string;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface LegacyItemRow {
  id: string;
  posting_id: string;
  sku: string;
  offer_id: string;
  name: string;
  quantity: number;
  unit_price: string;
  currency: string;
}

interface LegacyCheckpointRow {
  store_id: string;
  fulfillment_mode: string;
  cursor: string | null;
  window_from: Date | null;
  window_to: Date | null;
  updated_at: Date;
}

interface LegacyWebhookRow {
  id: string;
  store_id: string;
  event_hash: string;
  message_type: string;
  posting_number: string | null;
  received_at: Date;
  processed_at: Date | null;
  status: string;
  error_message: string | null;
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function timestamp(value: Date | null): number | null {
  return value ? new Date(value).getTime() : null;
}

function required(value: string | null | undefined, label: string): string {
  if (!value) {
    throw new Error(`${label} is required`);
  }
  return value;
}

/** Converts the one supported legacy PostgreSQL schema into the formal SQLite schema. */
async function main(): Promise<void> {
  const sourceUrl = required(argument("source") ?? process.env.DATABASE_URL, "--source or DATABASE_URL");
  const targetDataDir = resolve(argument("target-data-dir") ?? process.env.DATA_DIR ?? ".data");
  const legacyEncryptionKey = required(
    argument("legacy-encryption-key") ?? process.env.LEGACY_ENCRYPTION_KEY ?? process.env.ENCRYPTION_KEY,
    "--legacy-encryption-key or LEGACY_ENCRYPTION_KEY",
  );
  const adminUsername = required(argument("admin-username") ?? process.env.LEGACY_ADMIN_USERNAME, "admin username");
  const adminPasswordHash = required(
    argument("admin-password-hash") ?? process.env.LEGACY_ADMIN_PASSWORD_HASH,
    "admin password hash",
  );
  const config = loadConfig({ ...process.env, DATA_DIR: targetDataDir, COOKIE_SECRET: undefined, ENCRYPTION_KEY: undefined });
  const source = new pg.Pool({ connectionString: sourceUrl, max: 1 });
  const database = openDatabase(join(targetDataDir, "data"));

  try {
    runMigrations(database);
    const existing = database.prepare("SELECT COUNT(*) AS count FROM stores").get() as { count: number };
    if (existing.count > 0) {
      throw new Error("Target SQLite database already contains stores; import was not started");
    }

    const [stores, postings, items, checkpoints, webhooks] = await Promise.all([
      source.query<LegacyStoreRow>("SELECT * FROM stores ORDER BY created_at"),
      source.query<LegacyPostingRow>("SELECT *, gross_amount::text AS gross_amount FROM postings ORDER BY created_at"),
      source.query<LegacyItemRow>("SELECT *, unit_price::text AS unit_price FROM posting_items ORDER BY id"),
      source.query<LegacyCheckpointRow>("SELECT * FROM sync_checkpoints ORDER BY store_id, fulfillment_mode"),
      source.query<LegacyWebhookRow>("SELECT * FROM webhook_events ORDER BY received_at"),
    ]);

    database.transaction(() => {
      const now = Date.now();
      database.prepare(
        `INSERT INTO administrators (id, username, password_hash, created_at_ms, updated_at_ms)
         VALUES (1, ?, ?, ?, ?)`,
      ).run(adminUsername, adminPasswordHash, now, now);

      const insertStore = database.prepare(
        `INSERT INTO stores (
          id, name, client_id, api_key_ciphertext, webhook_token_hash, color, enabled,
          api_key_expires_at_ms, last_sync_started_at_ms, last_sync_finished_at_ms,
          last_sync_error, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertMode = database.prepare("INSERT INTO store_fulfillment_modes (store_id, mode) VALUES (?, ?)");
      for (const store of stores.rows) {
        const apiKey = decryptSecret(store.api_key_ciphertext, legacyEncryptionKey);
        const reencrypted = encryptSecret(apiKey, config.ENCRYPTION_KEY);
        insertStore.run(
          store.id,
          store.name,
          store.client_id,
          reencrypted,
          store.webhook_token_hash.trim(),
          store.color.trim(),
          Number(store.enabled),
          timestamp(store.api_key_expires_at),
          timestamp(store.last_sync_started_at),
          timestamp(store.last_sync_finished_at),
          store.last_sync_error,
          timestamp(store.created_at),
          timestamp(store.updated_at),
        );
        for (const mode of store.fulfillment_modes) {
          insertMode.run(store.id, mode);
        }
      }

      const insertPosting = database.prepare(
        `INSERT INTO postings (
          id, store_id, posting_number, order_number, fulfillment_mode, order_at_ms, status,
          substatus, gross_amount_minor, currency, cancelled_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const posting of postings.rows) {
        insertPosting.run(
          posting.id,
          posting.store_id,
          posting.posting_number,
          posting.order_number,
          posting.fulfillment_mode,
          timestamp(posting.order_at),
          posting.status,
          posting.substatus,
          amountToMinorUnits(posting.gross_amount),
          posting.currency.trim(),
          timestamp(posting.cancelled_at),
          timestamp(posting.created_at),
          timestamp(posting.updated_at),
        );
      }

      const insertItem = database.prepare(
        `INSERT INTO posting_items (id, posting_id, sku, offer_id, name, quantity, unit_price_minor, currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of items.rows) {
        insertItem.run(
          item.id,
          item.posting_id,
          item.sku,
          item.offer_id,
          item.name,
          item.quantity,
          amountToMinorUnits(item.unit_price),
          item.currency.trim(),
        );
      }

      const insertCheckpoint = database.prepare(
        `INSERT INTO sync_checkpoints (
          store_id, fulfillment_mode, cursor, window_from_ms, window_to_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const checkpoint of checkpoints.rows) {
        insertCheckpoint.run(
          checkpoint.store_id,
          checkpoint.fulfillment_mode,
          checkpoint.cursor,
          timestamp(checkpoint.window_from),
          timestamp(checkpoint.window_to),
          timestamp(checkpoint.updated_at),
        );
      }

      const insertWebhook = database.prepare(
        `INSERT INTO webhook_events (
          id, store_id, event_hash, message_type, posting_number, received_at_ms,
          processed_at_ms, status, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const webhook of webhooks.rows) {
        insertWebhook.run(
          webhook.id,
          webhook.store_id,
          webhook.event_hash.trim(),
          webhook.message_type,
          webhook.posting_number,
          timestamp(webhook.received_at),
          timestamp(webhook.processed_at),
          webhook.status,
          webhook.error_message,
        );
      }
    })();

    const counts = database.prepare(
      `SELECT
        (SELECT COUNT(*) FROM stores) AS stores,
        (SELECT COUNT(*) FROM postings) AS postings,
        (SELECT COUNT(*) FROM posting_items) AS items,
        (SELECT COUNT(*) FROM sync_checkpoints) AS checkpoints,
        (SELECT COUNT(*) FROM webhook_events) AS webhooks,
        (SELECT COUNT(*) FROM postings WHERE cancelled_at_ms IS NOT NULL) AS cancelled,
        (SELECT COUNT(*) FROM (SELECT store_id, posting_number FROM postings GROUP BY store_id, posting_number)) AS unique_postings`,
    ).get() as Record<string, number>;
    const expected = {
      stores: stores.rowCount ?? 0,
      postings: postings.rowCount ?? 0,
      items: items.rowCount ?? 0,
      checkpoints: checkpoints.rowCount ?? 0,
      webhooks: webhooks.rowCount ?? 0,
      cancelled: postings.rows.filter((row) => row.cancelled_at !== null).length,
      unique_postings: new Set(postings.rows.map((row) => `${row.store_id}:${row.posting_number}`)).size,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (counts[key] !== value) {
        throw new Error(`Validation failed for ${key}: expected ${value}, got ${counts[key]}`);
      }
    }

    const sourceGmv = new Map<string, number>();
    for (const posting of postings.rows) {
      const currency = posting.currency.trim();
      sourceGmv.set(currency, (sourceGmv.get(currency) ?? 0) + amountToMinorUnits(posting.gross_amount));
    }
    const targetGmv = database
      .prepare("SELECT currency, SUM(gross_amount_minor) AS amount FROM postings GROUP BY currency ORDER BY currency")
      .all() as Array<{ currency: string; amount: number }>;
    for (const row of targetGmv) {
      if (sourceGmv.get(row.currency) !== row.amount) {
        throw new Error(`GMV validation failed for ${row.currency}`);
      }
    }
    for (const row of database.prepare("SELECT api_key_ciphertext FROM stores").all() as Array<{ api_key_ciphertext: string }>) {
      decryptSecret(row.api_key_ciphertext, config.ENCRYPTION_KEY);
    }
    process.stdout.write(`${JSON.stringify({ targetDataDir, counts, gmv: targetGmv }, null, 2)}\n`);
  } finally {
    await source.end();
    closeDatabase(database);
  }
}

await main();
