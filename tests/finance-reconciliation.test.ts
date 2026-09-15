import { describe, expect, it } from "vitest";

import { FinanceRepository } from "../src/server/db/finance-repository";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { FinanceAnalysisService } from "../src/server/finance/finance-service";
import type { NormalizedFinanceLine } from "../src/server/finance/accrual-normalize";
import type { NormalizedPosting } from "../src/server/ozon/normalize";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { createTestDatabase } from "./test-context";

const STORE_ID = "8f9dc7d2-35a8-45d5-b199-c39c5a100031";

function posting(): NormalizedPosting {
  return {
    postingNumber: "posting-april-1",
    orderNumber: "order-april-1",
    fulfillmentMode: "FBS",
    orderAt: new Date("2026-04-02T08:00:00.000Z"),
    shipmentAt: new Date("2026-04-05T08:00:00.000Z"),
    shipmentTimeSource: "delivering_date",
    status: "awaiting_deliver",
    substatus: null,
    grossAmount: "1000.00",
    currency: "RUB",
    cancelledAt: null,
    items: [{ sku: "sku-april", offerId: "offer-april", name: "April product", quantity: 1, unitPrice: "1000.00", currency: "RUB" }],
  };
}

function line(id: string, date: string, category: NormalizedFinanceLine["category"], amount: string, overrides: Partial<NormalizedFinanceLine> = {}): NormalizedFinanceLine {
  return {
    sourceKey: id,
    sourceDate: date,
    accrualDate: date,
    accruedCategory: "POSTING",
    unitNumber: "posting-april-1",
    postingNumber: "posting-april-1",
    sku: "sku-april",
    typeId: null,
    typeName: null,
    category,
    amount,
    currency: "RUB",
    quantity: 1,
    sellerPrice: null,
    rawJson: "{}",
    ...overrides,
  };
}

describe("Ozon finance reconciliation", () => {
  it("returns April shipment orders with May adjustments and separate shared costs", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_ID, posting());
      const financeRepository = new FinanceRepository(context.database);
      financeRepository.replaceDayLines(STORE_ID, "2026-04-05", [line("sale", "2026-04-05", "revenue", "1000.00")]);
      financeRepository.replaceDayLines(STORE_ID, "2026-05-12", [line("return", "2026-05-12", "returns", "-200.00")], true);
      financeRepository.replaceDayLines(STORE_ID, "2026-05-13", [line("shared", "2026-05-13", "shared", "-50.00", { postingNumber: null, sku: null, unitNumber: "shared-1" })], true);
      const service = new FinanceAnalysisService(
        context.config,
        stores,
        financeRepository,
        postings,
        new ProxySettingsService(context.config, new SettingsRepository(context.database)),
        { now: () => new Date("2026-06-20T00:00:00.000Z") },
      );

      const overview = await service.getOverview("2026-04", []);
      const orderPage = await service.getOrders({ month: "2026-04", storeIds: [], page: 1, pageSize: 20 });

      expect(orderPage.items).toHaveLength(1);
      expect(orderPage.items[0]).toMatchObject({ shipmentMonth: "2026-04", status: "stable" });
      expect(orderPage.items[0]?.breakdown).toMatchObject({
        sales: { amount: "1000.00", currency: "RUB" },
        directCosts: { amount: "-200.00", currency: "RUB" },
        directReceivable: { amount: "800.00", currency: "RUB" },
      });
      expect(overview.stores[0]?.breakdown.sharedCosts.amount).toBe("0.00");
      expect(await service.getExceptions({ month: "2026-04", storeIds: [] })).toEqual([]);

      expect(overview.stores[0]?.breakdown).toMatchObject({
        commission: { amount: "0.00" },
        logistics: { amount: "0.00" },
        promotion: { amount: "0.00" },
        returns: { amount: "-200.00" },
        otherDirect: { amount: "0.00" },
        unknown: { amount: "0.00" },
      });
    } finally {
      context.cleanup();
    }
  });

  it("does not cross-match the same posting number between stores", async () => {
    const context = createTestDatabase();
    const otherStoreId = "8f9dc7d2-35a8-45d5-b199-c39c5a100032";
    try {
      const stores = new StoresRepository(context.database);
      for (const [id, name] of [[STORE_ID, "Store A"], [otherStoreId, "Store B"]] as const) {
        await stores.create({ id, name, clientId: `client-${id}`, apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      }
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_ID, posting());
      const otherPosting = posting();
      otherPosting.shipmentAt = new Date("2026-04-06T08:00:00.000Z");
      otherPosting.items = [{ sku: "sku-other", offerId: "offer-other", name: "Other product", quantity: 1, unitPrice: "1000.00", currency: "RUB" }];
      await postings.upsert(otherStoreId, otherPosting);
      const financeRepository = new FinanceRepository(context.database);
      financeRepository.replaceDayLines(STORE_ID, "2026-04-05", [line("store-a", "2026-04-05", "revenue", "1000.00")]);
      financeRepository.replaceDayLines(otherStoreId, "2026-04-05", [line("store-b", "2026-04-05", "revenue", "2000.00", { sku: "sku-other" })]);
      const service = new FinanceAnalysisService(context.config, stores, financeRepository, postings, new ProxySettingsService(context.config, new SettingsRepository(context.database)), { now: () => new Date("2026-06-20T00:00:00.000Z") });
      const overview = await service.getOverview("2026-04", []);

      expect(overview.stores.map((store) => store.breakdown.sales.amount)).toEqual(["1000.00", "2000.00"]);
    } finally {
      context.cleanup();
    }
  });

  it("marks orders without finance lines as awaiting revenue", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_ID, posting());
      const service = new FinanceAnalysisService(
        context.config,
        stores,
        new FinanceRepository(context.database),
        postings,
        new ProxySettingsService(context.config, new SettingsRepository(context.database)),
        { now: () => new Date("2026-06-20T00:00:00.000Z") },
      );

      const overview = await service.getOverview("2026-04", []);
      const orderPage = await service.getOrders({ month: "2026-04", storeIds: [], page: 1, pageSize: 20 });

      expect(orderPage.items[0]).toMatchObject({ status: "awaiting_revenue", breakdown: { directReceivable: { amount: "0.00", currency: "RUB" } } });
      expect(overview.stores[0]).toMatchObject({ awaitingRevenueOrderCount: 1, directReceivableOrderCount: 0, pendingOrderCount: 0, stableOrderCount: 0, reviewOrderCount: 0 });
      expect(overview.skuSummaries[0]?.statusCounts.awaiting_revenue).toBe(1);
      expect(overview.stores[0]?.settlementCurrency).toBeNull();
      expect(overview.totalsByCurrency).toEqual([]);
    } finally {
      context.cleanup();
    }
  });

  it("matches finance lines by order number when posting number has a suffix", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_ID, posting());
      const financeRepository = new FinanceRepository(context.database);
      financeRepository.replaceDayLines(STORE_ID, "2026-05-12", [line("order-number-revenue", "2026-05-12", "revenue", "1000.00", { unitNumber: "order-april-1", postingNumber: "order-april-1" })]);
      const service = new FinanceAnalysisService(context.config, stores, financeRepository, postings, new ProxySettingsService(context.config, new SettingsRepository(context.database)), { now: () => new Date("2026-06-20T00:00:00.000Z") });

      const order = (await service.getOrders({ month: "2026-04", storeIds: [], page: 1, pageSize: 20 })).items[0];

      expect(order).toMatchObject({ status: "direct_receivable", cancelled: false, breakdown: { sales: { amount: "1000.00" } } });
      expect(await service.getExceptions({ month: "2026-04", storeIds: [] })).toEqual([]);
    } finally {
      context.cleanup();
    }
  });

  it("keeps cancelled orders traceable without counting them as unsettled", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_ID, { ...posting(), status: "posting_canceled", cancelledAt: new Date("2026-04-06T08:00:00.000Z") });
      const service = new FinanceAnalysisService(context.config, stores, new FinanceRepository(context.database), postings, new ProxySettingsService(context.config, new SettingsRepository(context.database)), { now: () => new Date("2026-06-20T00:00:00.000Z") });

      const overview = await service.getOverview("2026-04", []);
      const order = (await service.getOrders({ month: "2026-04", storeIds: [], page: 1, pageSize: 20 })).items[0];

      expect(order).toMatchObject({ cancelled: true, cancellationState: "no_revenue" });
      expect(overview.stores[0]).toMatchObject({ orderCount: 1, cancelledOrderCount: 1, cancelledNoRevenueOrderCount: 1, cancelledWithRevenueOrderCount: 0, awaitingRevenueOrderCount: 0, pendingOrderCount: 0, reviewOrderCount: 0 });
    } finally {
      context.cleanup();
    }
  });

  it("keeps cancelled orders with revenue distinct from cancelled orders without revenue", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_ID, { ...posting(), status: "posting_canceled", cancelledAt: new Date("2026-04-06T08:00:00.000Z") });
      const financeRepository = new FinanceRepository(context.database);
      financeRepository.replaceDayLines(STORE_ID, "2026-04-05", [line("cancelled-revenue", "2026-04-05", "revenue", "1000.00")]);
      const service = new FinanceAnalysisService(context.config, stores, financeRepository, postings, new ProxySettingsService(context.config, new SettingsRepository(context.database)), { now: () => new Date("2026-06-20T00:00:00.000Z") });

      const overview = await service.getOverview("2026-04", []);
      const order = (await service.getOrders({ month: "2026-04", storeIds: [], page: 1, pageSize: 20 })).items[0];

      expect(order).toMatchObject({ cancelled: true, cancellationState: "with_revenue", status: "direct_receivable" });
      expect(overview.stores[0]).toMatchObject({ cancelledOrderCount: 1, cancelledNoRevenueOrderCount: 0, cancelledWithRevenueOrderCount: 1, reviewOrderCount: 0 });
    } finally {
      context.cleanup();
    }
  });

  it("keeps unknown fees out of orders while reporting them as unassigned fees", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_ID, posting());
      const financeRepository = new FinanceRepository(context.database);
      financeRepository.replaceDayLines(STORE_ID, "2026-04-05", [
        line("known-revenue", "2026-04-05", "revenue", "1000.00"),
        line("unknown-membership", "2026-04-20", "unknown", "-25.00", { currency: "CNY", typeId: "74", typeName: "StarsMembership" }),
      ]);
      const service = new FinanceAnalysisService(context.config, stores, financeRepository, postings, new ProxySettingsService(context.config, new SettingsRepository(context.database)), { now: () => new Date("2026-06-20T00:00:00.000Z") });

      const overview = await service.getOverview("2026-04", []);
      const order = (await service.getOrders({ month: "2026-04", storeIds: [], page: 1, pageSize: 20 })).items[0];
      const detail = await service.getOrderDetail(order!.postingId);
      const exceptions = await service.getExceptions({ month: "2026-04", storeIds: [] });

      expect(order).toMatchObject({ status: "direct_receivable", settlementCurrency: "RUB", exceptionReasons: [], breakdown: { directReceivable: { amount: "1000.00", currency: "RUB" }, unknown: { amount: "0.00" }, unknownAmount: { amount: "0.00" } } });
      expect(detail?.lines).toHaveLength(1);
      expect(detail?.lines[0]).toMatchObject({ category: "revenue", amount: { amount: "1000.00", currency: "RUB" } });
      expect(exceptions).toEqual([]);
      expect(overview.stores[0]).toMatchObject({ reviewOrderCount: 0, directReceivableOrderCount: 1 });
      expect(overview.totalsByCurrency).toHaveLength(1);
      expect(overview.totalsByCurrency[0]?.sales.currency).toBe("RUB");
      expect(overview.unassignedFees).toEqual([{ storeId: STORE_ID, storeName: "Finance store", storeColor: "#3B82F6", currency: "CNY", amount: { amount: "-25.00", currency: "CNY" }, lineCount: 1, typeId: "74", typeName: "StarsMembership", sourceDateFrom: "2026-04-20", sourceDateTo: "2026-04-20" }]);
    } finally {
      context.cleanup();
    }
  });

  it("counts SKU orders distinctly while summing every sold unit", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const postings = new PostingsRepository(context.database);
      const multiItemPosting = posting();
      multiItemPosting.items = [
        multiItemPosting.items[0]!,
        { ...multiItemPosting.items[0]!, quantity: 2 },
      ];
      await postings.upsert(STORE_ID, multiItemPosting);
      const financeRepository = new FinanceRepository(context.database);
      financeRepository.replaceDayLines(STORE_ID, "2026-04-05", [line("multi-item-revenue", "2026-04-05", "revenue", "3000.00")]);
      const service = new FinanceAnalysisService(
        context.config,
        stores,
        financeRepository,
        postings,
        new ProxySettingsService(context.config, new SettingsRepository(context.database)),
        { now: () => new Date("2026-06-20T00:00:00.000Z") },
      );

      const overview = await service.getOverview("2026-04", []);

      expect(overview.stores[0]).toMatchObject({ orderCount: 1, salesQuantity: 3 });
      expect(overview.skuSummaries[0]).toMatchObject({ orderCount: 1, quantity: 3 });
    } finally {
      context.cleanup();
    }
  });

  it("does not combine multiple finance currencies in one order", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const postings = new PostingsRepository(context.database);
      await postings.upsert(STORE_ID, posting());
      const financeRepository = new FinanceRepository(context.database);
      financeRepository.replaceDayLines(STORE_ID, "2026-04-05", [
        line("revenue-rub", "2026-04-05", "revenue", "1000.00"),
        line("commission-cny", "2026-04-05", "commission", "-100.00", { currency: "CNY" }),
      ]);
      const service = new FinanceAnalysisService(
        context.config,
        stores,
        financeRepository,
        postings,
        new ProxySettingsService(context.config, new SettingsRepository(context.database)),
        { now: () => new Date("2026-06-20T00:00:00.000Z") },
      );

      const orderPage = await service.getOrders({ month: "2026-04", storeIds: [], page: 1, pageSize: 20 });

      expect(orderPage.items[0]?.breakdown.sales.amount).toBe("0.00");
      expect(orderPage.items[0]?.status).toBe("review");
      expect(orderPage.items[0]?.settlementCurrency).toBeNull();
      expect(orderPage.items[0]?.exceptionReasons).toEqual(["订单包含多种财务币种，无法合计"]);
    } finally {
      context.cleanup();
    }
  });

  it("accepts a single settlement currency even when the order price uses CNY", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const postings = new PostingsRepository(context.database);
      const crossCurrencyPosting = posting();
      crossCurrencyPosting.currency = "CNY";
      crossCurrencyPosting.items[0]!.currency = "CNY";
      await postings.upsert(STORE_ID, crossCurrencyPosting);
      const financeRepository = new FinanceRepository(context.database);
      financeRepository.replaceDayLines(STORE_ID, "2026-04-05", [
        line("cross-currency-revenue", "2026-04-05", "revenue", "1000.00", { currency: "RUB" }),
      ]);
      const service = new FinanceAnalysisService(
        context.config,
        stores,
        financeRepository,
        postings,
        new ProxySettingsService(context.config, new SettingsRepository(context.database)),
        { now: () => new Date("2026-06-20T00:00:00.000Z") },
      );

      const order = (await service.getOrders({ month: "2026-04", storeIds: [], page: 1, pageSize: 20 })).items[0];

      expect(order).toMatchObject({ orderCurrency: "CNY", settlementCurrency: "RUB", status: "direct_receivable" });
      expect(order?.exceptionReasons).toEqual([]);
    } finally {
      context.cleanup();
    }
  });

  it("requires every day in a finance coverage range to be completed", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const repository = new FinanceRepository(context.database);

      expect(repository.hasCompleteFinanceCoverage(STORE_ID, "2026-04-01", "2026-04-03")).toBe(false);
      repository.saveDayCheckpoint(STORE_ID, "2026-04-01", null, "completed");
      repository.saveDayCheckpoint(STORE_ID, "2026-04-02", null, "completed");
      expect(repository.hasCompleteFinanceCoverage(STORE_ID, "2026-04-01", "2026-04-03")).toBe(false);
      repository.saveDayCheckpoint(STORE_ID, "2026-04-03", null, "completed");
      expect(repository.hasCompleteFinanceCoverage(STORE_ID, "2026-04-01", "2026-04-03")).toBe(true);
      repository.saveDayCheckpoint(STORE_ID, "2026-04-02", null, "failed", "temporary failure");
      expect(repository.hasCompleteFinanceCoverage(STORE_ID, "2026-04-01", "2026-04-03")).toBe(false);
    } finally {
      context.cleanup();
    }
  });

  it("reports the selected month coverage through today", async () => {
    const context = createTestDatabase();
    try {
      const stores = new StoresRepository(context.database);
      await stores.create({ id: STORE_ID, name: "Finance store", clientId: "client", apiKeyCiphertext: "cipher", color: "#3B82F6", fulfillmentModes: ["FBS"], apiKeyExpiresAt: null });
      const repository = new FinanceRepository(context.database);
      repository.saveDayCheckpoint(STORE_ID, "2026-04-01", null, "completed");
      repository.saveDayCheckpoint(STORE_ID, "2026-04-02", null, "failed", "temporary failure");
      const service = new FinanceAnalysisService(context.config, stores, repository, new PostingsRepository(context.database), new ProxySettingsService(context.config, new SettingsRepository(context.database)), { now: () => new Date("2026-04-03T00:00:00.000Z") });

      const coverage = await service.getCoverage("2026-04", []);

      expect(coverage).toMatchObject({ from: "2026-04-01", to: "2026-04-03", totalDays: 3, completedDays: 1, failedDays: 1, complete: false });
      expect(coverage.missingDates).toEqual(["2026-04-02", "2026-04-03"]);
    } finally {
      context.cleanup();
    }
  });
});
