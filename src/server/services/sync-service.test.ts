import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config";
import { encryptSecret } from "../security/encryption";
import { SyncService } from "./sync-service";

const encryptionKey = "b".repeat(64);
const postingNumber = "0164062780-0053-1";

function posting(status: string) {
  return {
    posting_number: postingNumber,
    order_number: "order-1",
    in_process_at: "2026-11-25T00:00:00.000Z",
    status,
    products: [{ sku: "1001", product_id: "1001", offer_id: "1645-2-L", name: "Test", quantity: 1, price: "1", currency_code: "RUB" }],
  };
}

function fixture(statuses: string[], shipError?: Error) {
  const findById = vi.fn().mockResolvedValue({
    id: "store-1",
    enabled: true,
    platform: "ozon",
    fulfillmentModes: ["FBS"],
    clientId: "client-1",
    apiKeyCiphertext: encryptSecret("api-key", encryptionKey),
  });
  const upsert = vi.fn().mockResolvedValue(undefined);
  const getFbsPosting = vi.fn().mockImplementation(async () => posting(statuses.shift() ?? "awaiting_registration"));
  const shipFbsPosting = shipError ? vi.fn().mockRejectedValue(shipError) : vi.fn().mockResolvedValue(undefined);
  const service = new SyncService(
    { ENCRYPTION_KEY: encryptionKey, OZON_API_BASE_URL: "https://api-seller.ozon.ru" } as AppConfig,
    { findById } as never,
    { upsert } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  Object.assign(service as unknown as Record<string, unknown>, { createClient: () => ({ getFbsPosting, shipFbsPosting }) });
  return { service, getFbsPosting, shipFbsPosting, upsert };
}

afterEach(() => vi.useRealTimers());

describe("SyncService.markPostingPrepared", () => {
  it("treats awaiting_registration as success after Ozon status propagation", async () => {
    vi.useFakeTimers();
    const { service, getFbsPosting, shipFbsPosting, upsert } = fixture(
      ["awaiting_packaging", "awaiting_packaging", "awaiting_registration"],
      new Error("Ozon returned 409 after accepting the request"),
    );

    const resultPromise = service.markPostingPrepared("store-1", postingNumber);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result).toEqual({ status: "awaiting_registration" });
    expect(getFbsPosting).toHaveBeenCalledTimes(3);
    expect(shipFbsPosting).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledOnce();
  });
});
