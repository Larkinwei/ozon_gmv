import { describe, expect, it, vi } from "vitest";

import { OzonApiError } from "../src/server/ozon/client";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { encryptSecret } from "../src/server/security/encryption";
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

  it("reads WB balance and marks unsupported buyer questions without failing the store", async () => {
    const context = createTestDatabase();
    const stores = new StoresRepository(context.database);
    const storeId = "8f9dc7d2-35a8-45d5-b199-c39c5a100033";
    await stores.create({
      id: storeId,
      name: "WB 店铺",
      platform: "wildberries",
      clientId: "",
      apiKeyCiphertext: encryptSecret("wb-token", context.config.ENCRYPTION_KEY),
      color: "#F59E0B",
      fulfillmentModes: [],
      apiKeyExpiresAt: null,
    });
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    vi.stubGlobal("fetch", (async (input: URL | RequestInfo) => {
      if (String(input).includes("account/balance")) {
        return new Response(JSON.stringify({ currency: "RUB", current: "500.00", for_withdraw: "300.00" }), { status: 200 });
      }
      throw new Error(`Unexpected Wildberries request: ${String(input)}`);
    }) as typeof fetch);
    const proxySettings = new ProxySettingsService(context.config, settings);
    const proxyFactory = vi.spyOn(proxySettings, "createFetch").mockImplementation(() => {
      throw new Error("Wildberries requests must not use the Ozon proxy");
    });
    const service = new StoreOperationsService(
      context.config,
      stores,
      proxySettings,
    );

    try {
      const snapshot = await service.getOverview([]);
      expect(snapshot.stores[0]).toMatchObject({
        platform: "wildberries",
        balance: { primary: { amount: "500.00", currency: "RUB" }, primaryLabel: "可用余额", status: { state: "ok" } },
        questions: { status: { state: "unsupported" }, counts: null, latest: [] },
      });
    } finally {
      proxyFactory.mockRestore();
      vi.unstubAllGlobals();
      context.cleanup();
    }
  });
});
