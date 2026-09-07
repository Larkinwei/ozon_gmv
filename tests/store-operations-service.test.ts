import { describe, expect, it, vi } from "vitest";

import { OzonApiError } from "../src/server/ozon/client";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { StoreOperationsService } from "../src/server/services/store-operations-service";
import { createTestDatabase } from "./test-context";

const STORE_A_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100031";
const STORE_B_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100032";

describe("StoreOperationsService", () => {
  it("loads stores independently and keeps successful data when one refresh fails", async () => {
    const context = createTestDatabase();
    const stores = new StoresRepository(context.database);
    await stores.create({
      id: STORE_A_ID,
      name: "店铺 A",
      clientId: "client-a",
      apiKeyCiphertext: "cipher-a",
      color: "#3B82F6",
      fulfillmentModes: ["FBS"],
      apiKeyExpiresAt: null,
    });
    await stores.create({
      id: STORE_B_ID,
      name: "店铺 B",
      clientId: "client-b",
      apiKeyCiphertext: "cipher-b",
      color: "#22C55E",
      fulfillmentModes: ["FBO"],
      apiKeyExpiresAt: null,
    });

    let nowMs = Date.parse("2026-08-31T12:00:00.000Z");
    let storeABalanceAttempts = 0;
    const storeABalance = vi.fn(async () => {
      storeABalanceAttempts += 1;
      if (storeABalanceAttempts > 1) {
        throw new OzonApiError("temporary finance failure", 500, true);
      }
      return {
        openingBalance: { currencyCode: "RUB", value: "100.00" },
        closingBalance: { currencyCode: "RUB", value: "125.00" },
        accrued: { currencyCode: "RUB", value: "40.00" },
        payments: [{ currencyCode: "RUB", value: "15.00" }],
      };
    });
    const storeAQuestions = {
      getQuestionCount: vi.fn(async () => ({ all: 2, new: 1, processed: 0, unprocessed: 1, viewed: 1 })),
      getQuestionList: vi.fn(async () => ({
        questions: [{
          id: "question-a",
          text: "问题 A",
          status: "UNPROCESSED",
          sku: "1001",
          productName: "商品 A",
          productUrl: null,
          questionLink: null,
          publishedAt: "2026-08-31T10:00:00.000Z",
          answersCount: 0,
        }],
        lastId: null,
        hasNext: false,
      })),
    };
    const clientFactory = vi.fn((store) => {
      if (store.id === STORE_A_ID) {
        return {
          getFinanceBalance: storeABalance,
          ...storeAQuestions,
          getQuestionInfo: vi.fn(async () => ({
            id: "question-a",
            text: "问题 A",
            status: "UNPROCESSED",
            sku: "1001",
            productName: "商品 A",
            productUrl: null,
            questionLink: null,
            publishedAt: "2026-08-31T10:00:00.000Z",
            answersCount: 0,
          })),
        };
      }
      return {
        getFinanceBalance: vi.fn(async () => {
          throw new OzonApiError("finance denied", 403, false);
        }),
        getQuestionCount: vi.fn(async () => ({ all: 0, new: 0, processed: 0, unprocessed: 0, viewed: 0 })),
        getQuestionList: vi.fn(async () => ({ questions: [], lastId: null, hasNext: false })),
        getQuestionInfo: vi.fn(),
      };
    });
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const service = new StoreOperationsService(
      context.config,
      stores,
      new ProxySettingsService(context.config, settings),
      { clientFactory, now: () => new Date(nowMs), cacheTtlMs: 5 * 60_000 },
    );

    try {
      const first = await service.getOverview([]);
      expect(first.stores[0]).toMatchObject({
        storeId: STORE_A_ID,
        balance: {
          primary: { amount: "125.00", currency: "RUB" },
          status: { state: "ok" },
        },
        questions: { status: { state: "ok" }, counts: { unprocessed: 1 } },
      });
      expect(first.stores[1]?.balance.status.state).toBe("permission_denied");
      expect(first.stores[1]?.questions.status.state).toBe("ok");

      await service.getOverview([STORE_A_ID]);
      expect(storeABalance).toHaveBeenCalledOnce();

      nowMs += 5 * 60_000 + 1;
      const refreshed = await service.getOverview([STORE_A_ID]);
      expect(storeABalance).toHaveBeenCalledTimes(2);
      expect(refreshed.stores[0]).toMatchObject({
        balance: {
          primary: { amount: "125.00", currency: "RUB" },
          status: { state: "stale" },
        },
        questions: { status: { state: "ok" } },
      });
    } finally {
      context.cleanup();
    }
  });
});
