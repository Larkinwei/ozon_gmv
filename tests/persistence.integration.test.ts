import { describe, expect, it } from "vitest";

import { amountToMinorUnits } from "../src/server/db/money-storage";
import { InventoryRepository } from "../src/server/db/inventory-repository";
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
  it("tracks low-stock episodes and only reopens after recovery", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await insertStore(stores);
      const posting: NormalizedPosting = {
        postingNumber: "24219509-0030-1",
        orderNumber: "24219509-0030",
        fulfillmentMode: "FBS",
        orderAt: new Date("2026-08-05T10:00:00.000Z"),
        status: "awaiting_packaging",
        substatus: null,
        grossAmount: "100.00",
        currency: "RUB",
        cancelledAt: null,
        items: [{ sku: "147451960", offerId: "BAG-02", name: "Travel bag 2", quantity: 1, unitPrice: "100.00", currency: "RUB" }],
      };
      await new PostingsRepository(context.database).upsert(STORE_ID, posting);
      const inventory = new InventoryRepository(context.database);
      const candidate = inventory.listCandidates(STORE_ID)[0]!;
      inventory.replaceSnapshots(STORE_ID, candidate, 1_000, [{ warehouseId: "warehouse-1", warehouseName: "Seller warehouse", productId: "product-1", availableStock: 49, reservedStock: 2 }]);
      expect(inventory.evaluate(STORE_ID, candidate, 1_000, 50).newlyOpened).toBe(true);
      expect(inventory.listOpenAlerts()).toHaveLength(1);
      inventory.acknowledge([inventory.listOpenAlerts()[0]!.id]);
      expect(inventory.evaluate(STORE_ID, candidate, 2_000, 50).newlyOpened).toBe(false);
      expect(inventory.listOpenAlerts()).toHaveLength(0);
      inventory.replaceSnapshots(STORE_ID, candidate, 3_000, [{ warehouseId: "warehouse-1", warehouseName: "Seller warehouse", productId: "product-1", availableStock: 50, reservedStock: 0 }]);
      inventory.evaluate(STORE_ID, candidate, 3_000, 50);
      inventory.replaceSnapshots(STORE_ID, candidate, 4_000, [{ warehouseId: "warehouse-1", warehouseName: "Seller warehouse", productId: "product-1", availableStock: 49, reservedStock: 0 }]);
      expect(inventory.evaluate(STORE_ID, candidate, 4_000, 50).newlyOpened).toBe(true);
    } finally {
      context.cleanup();
    }
  });

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
