import { describe, expect, it } from "vitest";

import { amountToMinorUnits } from "../src/server/db/money-storage";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { WebhookEventsRepository } from "../src/server/db/webhook-events-repository";
import type { NormalizedPosting } from "../src/server/ozon/normalize";
import { createTestDatabase } from "./test-context";

const STORE_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100001";

async function insertStore(repository: StoresRepository): Promise<void> {
  await repository.create({
    id: STORE_ID,
    name: "Test store",
    clientId: "client",
    apiKeyCiphertext: "ciphertext",
    color: "#3B82F6",
    fulfillmentModes: ["FBS"],
    apiKeyExpiresAt: null,
  });
}

describe("SQLite persistence", () => {
  it("keeps polling writes idempotent and stores exact minor units", async () => {
    const context = createTestDatabase();
    try {
      await insertStore(new StoresRepository(context.database));
      const repository = new PostingsRepository(context.database);
      const posting: NormalizedPosting = {
        postingNumber: "24219509-0020-1",
        orderNumber: "24219509-0020",
        fulfillmentMode: "FBS",
        orderAt: new Date("2026-08-05T10:00:00.000Z"),
        status: "awaiting_packaging",
        substatus: null,
        grossAmount: "2999.90",
        currency: "RUB",
        cancelledAt: null,
        items: [{ sku: "147451959", offerId: "BAG-01", name: "Travel bag", quantity: 2, unitPrice: "1499.95", currency: "RUB" }],
      };
      await expect(repository.upsert(STORE_ID, posting)).resolves.toMatchObject({ kind: "created" });
      await expect(repository.upsert(STORE_ID, posting)).resolves.toMatchObject({ kind: "unchanged" });
      await expect(repository.upsert(STORE_ID, { ...posting, status: "posting_canceled", cancelledAt: new Date() })).resolves.toMatchObject({ kind: "updated" });
      const stored = context.database.prepare("SELECT gross_amount_minor FROM postings").get() as { gross_amount_minor: number };
      expect(stored.gross_amount_minor).toBe(299_990);
      expect(amountToMinorUnits("0.10") + amountToMinorUnits("0.20")).toBe(30);
    } finally {
      context.cleanup();
    }
  });

  it("deduplicates webhook deliveries and persists sync cursors", async () => {
    const context = createTestDatabase();
    try {
      await insertStore(new StoresRepository(context.database));
      const webhooks = new WebhookEventsRepository(context.database);
      const message = { message_type: "TYPE_STATE_CHANGED" as const, posting_number: "24219509-0020-1", changed_state_date: "2026-08-05T10:03:00.000Z" };
      await expect(webhooks.register(STORE_ID, message)).resolves.toMatchObject({ duplicate: false });
      await expect(webhooks.register(STORE_ID, message)).resolves.toMatchObject({ duplicate: true });

      const checkpoints = new SyncCheckpointsRepository(context.database);
      const from = new Date("2026-08-01T00:00:00.000Z");
      const to = new Date("2026-08-05T00:00:00.000Z");
      await checkpoints.save(STORE_ID, "FBS", from, to, "next-page");
      await expect(checkpoints.find(STORE_ID, "FBS")).resolves.toEqual({ cursor: "next-page", windowFrom: from, windowTo: to });
    } finally {
      context.cleanup();
    }
  });
});
