import { createHash, randomUUID } from "node:crypto";

import type { AppDatabase } from "./database";

export interface LegacyWebhookMessage {
  message_type: string;
  posting_number?: string;
  changed_state_date?: string;
  time?: string;
}

/** Creates an order-independent event identity from the documented Push fields. */
export function createWebhookEventHash(message: LegacyWebhookMessage): string {
  const postingNumber = message.posting_number ?? "";
  const changedAt = message.message_type === "TYPE_PING" ? message.time ?? "" : message.changed_state_date ?? "";
  return createHash("sha256").update(`${message.message_type}|${postingNumber}|${changedAt}`).digest("hex");
}

export class WebhookEventsRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async register(storeId: string, message: LegacyWebhookMessage): Promise<{ id: string; duplicate: boolean }> {
    const eventHash = createWebhookEventHash(message);
    const postingNumber = message.posting_number ?? null;
    const existing = this.database
      .prepare("SELECT id FROM webhook_events WHERE store_id = ? AND event_hash = ?")
      .get(storeId, eventHash) as { id: string } | undefined;
    if (existing) {
      return { id: existing.id, duplicate: true };
    }

    const id = randomUUID();
    try {
      this.database.prepare(
        `INSERT INTO webhook_events (
          id, store_id, event_hash, message_type, posting_number, received_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, storeId, eventHash, message.message_type, postingNumber, Date.now());
      return { id, duplicate: false };
    } catch (error) {
      if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        return { id, duplicate: true };
      }
      throw error;
    }
  }

  public async markProcessed(id: string): Promise<void> {
    this.database.prepare(
      "UPDATE webhook_events SET status = 'processed', processed_at_ms = ?, error_message = NULL WHERE id = ?",
    ).run(Date.now(), id);
  }

  public async markFailed(id: string, error: string): Promise<void> {
    this.database.prepare(
      "UPDATE webhook_events SET status = 'failed', processed_at_ms = ?, error_message = ? WHERE id = ?",
    ).run(Date.now(), error.slice(0, 1000), id);
  }
}
