import { subMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import Decimal from "decimal.js";

import type {
  DashboardRange,
  DashboardSnapshot,
  OrderDetail,
  RecentOrder,
  StoreOperationsSnapshot,
  StoreBreakdown,
  StoreView,
  TimeSeriesPoint,
  BuyerQuestionView,
  FinanceExceptionView,
  FinanceLineView,
  FinanceMoneyBreakdown,
  FinanceOrderDetail,
  FinanceOrderStatus,
  FinanceOrderSummary,
  FinanceOverview,
  FinanceSkuSummary,
  FinanceStoreSummary,
  FinanceSyncView,
  Money,
} from "../shared/contracts";

export const demoStores: StoreView[] = [
  {
    id: "8f9dc7d2-35a8-45d5-b199-c39c5a100001",
    name: "北极星旗舰店",
    platform: "ozon",
    externalStoreId: "1849201",
    capabilities: { orders: true, sales: true, balance: true, notifications: true, inventory: true, writeOperations: true },
    clientId: "1849201",
    color: "#3B82F6",
    enabled: true,
    fulfillmentModes: ["FBO", "FBS"],
    apiKeyExpiresAt: "2026-12-31T16:00:00.000Z",
    lastSyncStartedAt: new Date(Date.now() - 18_000).toISOString(),
    lastSyncFinishedAt: new Date(Date.now() - 7_000).toISOString(),
    lastSyncError: null,
    syncHealth: "healthy",
  },
  {
    id: "8f9dc7d2-35a8-45d5-b199-c39c5a100002",
    name: "Moscow Select",
    platform: "ozon",
    externalStoreId: "1849202",
    capabilities: { orders: true, sales: true, balance: true, notifications: true, inventory: true, writeOperations: true },
    clientId: "1849202",
    color: "#22C55E",
    enabled: true,
    fulfillmentModes: ["FBO"],
    apiKeyExpiresAt: "2026-11-18T16:00:00.000Z",
    lastSyncStartedAt: new Date(Date.now() - 74_000).toISOString(),
    lastSyncFinishedAt: new Date(Date.now() - 64_000).toISOString(),
    lastSyncError: null,
    syncHealth: "healthy",
  },
  {
    id: "8f9dc7d2-35a8-45d5-b199-c39c5a100003",
    name: "Volga Home",
    platform: "ozon",
    externalStoreId: "1849203",
    capabilities: { orders: true, sales: true, balance: true, notifications: true, inventory: true, writeOperations: true },
    clientId: "1849203",
    color: "#A78BFA",
    enabled: true,
    fulfillmentModes: ["FBS", "RFBS"],
    apiKeyExpiresAt: "2027-01-09T16:00:00.000Z",
    lastSyncStartedAt: new Date(Date.now() - 210_000).toISOString(),
    lastSyncFinishedAt: new Date(Date.now() - 205_000).toISOString(),
    lastSyncError: null,
    syncHealth: "delayed",
  },
  {
    id: "8f9dc7d2-35a8-45d5-b199-c39c5a100004",
    name: "西伯利亚优选",
    platform: "ozon",
    externalStoreId: "1849204",
    capabilities: { orders: true, sales: true, balance: true, notifications: true, inventory: true, writeOperations: true },
    clientId: "1849204",
    color: "#F59E0B",
    enabled: true,
    fulfillmentModes: ["FBO", "RFBS"],
    apiKeyExpiresAt: null,
    lastSyncStartedAt: new Date(Date.now() - 46_000).toISOString(),
    lastSyncFinishedAt: new Date(Date.now() - 32_000).toISOString(),
    lastSyncError: null,
    syncHealth: "healthy",
  },
];

const storeTotals = [
  { orders: 148, gmv: 487_230 },
  { orders: 106, gmv: 356_880 },
  { orders: 78, gmv: 268_420 },
  { orders: 59, gmv: 194_760 },
];

function makeSeries(selectedStoreId: string): TimeSeriesPoint[] {
  const now = new Date();
  const selectedStores = demoStores.filter((store) => selectedStoreId === "all" || store.id === selectedStoreId);
  const weights = [0.38, 0.28, 0.2, 0.14];
  return Array.from({ length: 32 }, (_, index) => {
    const bucket = subMinutes(now, (31 - index) * 15);
    const wave = Math.sin(index / 3.1) * 6;
    const orders = Math.max(2, Math.round(10 + wave + (index % 5)));
    let assignedOrders = 0;
    const storeValues = selectedStores.map((store, storeIndex) => {
      const isLastStore = storeIndex === selectedStores.length - 1;
      const storeOrders = isLastStore
        ? orders - assignedOrders
        : Math.max(0, Math.round(orders * (weights[demoStores.indexOf(store)] ?? 0)));
      assignedOrders += storeOrders;
      const storeGmv = storeOrders * (2_650 + storeIndex * 240 + (index % 7) * 95);
      return {
        storeId: store.id,
        storeName: store.name,
        color: store.color,
        orders: storeOrders,
        gmv: [{ amount: storeGmv.toFixed(2), currency: "RUB" }],
      };
    });
    const gmv = storeValues.reduce(
      (sum, store) => sum.plus(store.gmv[0]?.amount ?? 0),
      new Decimal(0),
    );
    return {
      bucket: bucket.toISOString(),
      label: formatInTimeZone(bucket, "Asia/Shanghai", "HH:mm"),
      orders,
      gmv: [{ amount: gmv.toFixed(2), currency: "RUB" }],
      stores: storeValues,
    };
  });
}

function makeRecentOrders(): RecentOrder[] {
  const amounts = [8990, 3290, 12450, 1590, 6780, 21990, 4590, 7420, 2850, 9990, 1360, 5480];
  return amounts.map((amount, index) => {
    const store = demoStores[index % demoStores.length] as StoreView;
    return {
      id: `demo-order-${index}`,
      platform: store.platform,
      externalOrderId: `WB-${index}`,
      postingNumber: `24219509-${String(8820 - index).padStart(4, "0")}-${(index % 3) + 1}`,
      storeId: store.id,
      storeName: store.name,
      storeColor: store.color,
      orderAt: new Date(Date.now() - index * 82_000).toISOString(),
      amount: { amount: amount.toFixed(2), currency: "RUB" },
      itemCount: (index % 4) + 1,
      productNames: index % 3 === 0
        ? ["轻量防水旅行收纳包", "便携行李整理袋"]
        : ["轻量防水旅行收纳包"],
      fulfillment: store.fulfillmentModes[index % store.fulfillmentModes.length] ?? "FBO",
      status: index === 8 ? "posting_canceled" : "awaiting_packaging",
      cancelled: index === 8,
    };
  });
}

function makeBreakdown(selectedStoreId: string): StoreBreakdown[] {
  return demoStores
    .map((store, index) => ({
      storeId: store.id,
      storeName: store.name,
      color: store.color,
      platform: store.platform,
      orders: storeTotals[index]?.orders ?? 0,
      gmv: [{ amount: (storeTotals[index]?.gmv ?? 0).toFixed(2), currency: "RUB" }],
    }))
    .filter((store) => selectedStoreId === "all" || store.storeId === selectedStoreId);
}

/** Keeps demo chart buckets aligned with the production dashboard ranges. */
function getDemoGranularity(range: DashboardRange): DashboardSnapshot["granularity"] {
  if (range === "today") {
    return "15m";
  }

  if (range === "yesterday") {
    return "hour";
  }

  return "day";
}

/** Produces deterministic, realistic data for UI review without weakening production data paths. */
export function createDemoSnapshot(range: DashboardRange, selectedStoreId: string): DashboardSnapshot {
  const stores = makeBreakdown(selectedStoreId);
  const orders = stores.reduce((sum, store) => sum + store.orders, 0);
  const gmv = stores.reduce(
    (sum, store) => sum.plus(store.gmv[0]?.amount ?? 0),
    new Decimal(0),
  );
  const storeIds = new Set(stores.map((store) => store.storeId));
  return {
    generatedAt: new Date().toISOString(),
    timezone: "Asia/Shanghai",
    range,
    from: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    to: new Date().toISOString(),
    granularity: getDemoGranularity(range),
    kpis: {
      orders,
      gmv: [{ amount: gmv.toFixed(2), currency: "RUB" }],
      averageOrderValue: [{ amount: orders ? gmv.dividedBy(orders).toFixed(2) : "0.00", currency: "RUB" }],
      cancelledOrders: 11,
      cancelledGmv: [{ amount: "32760.00", currency: "RUB" }],
    },
    platforms: [{ platform: "ozon", orders, gmv: [{ amount: gmv.toFixed(2), currency: "RUB" }] }],
    timeSeries: makeSeries(selectedStoreId),
    stores,
    recentOrders: makeRecentOrders().filter((order) => selectedStoreId === "all" || storeIds.has(order.storeId)),
    sync: demoStores.filter((store) => selectedStoreId === "all" || store.id === selectedStoreId),
  };
}

/** Provides safe, deterministic finance and question data for the dashboard demo. */
export function createDemoStoreOperations(selectedStoreId: string): StoreOperationsSnapshot {
  const generatedAt = new Date().toISOString();
  const stores = demoStores
    .filter((store) => selectedStoreId === "all" || store.id === selectedStoreId)
    .map((store, index) => {
      const closing = 126_480 - index * 18_750;
      const questions: BuyerQuestionView[] = [
        {
          id: `demo-question-${store.id}-1`,
          storeId: store.id,
          storeName: store.name,
          storeColor: store.color,
          text: index % 2 === 0 ? "这个收纳包可以放 15 寸的笔记本电脑吗？" : "请问这款商品什么时候可以发货？",
          status: "UNPROCESSED",
          sku: `646399${170 + index}`,
          productName: "轻量防水旅行收纳包",
          productUrl: "https://www.ozon.ru/",
          questionLink: "https://www.ozon.ru/",
          publishedAt: new Date(Date.now() - (index + 1) * 18 * 60_000).toISOString(),
          answersCount: 0,
        },
        {
          id: `demo-question-${store.id}-2`,
          storeId: store.id,
          storeName: store.name,
          storeColor: store.color,
          text: "商品的实际尺寸和页面描述一致吗？",
          status: "VIEWED",
          sku: `646399${270 + index}`,
          productName: "便携行李整理袋",
          productUrl: "https://www.ozon.ru/",
          questionLink: "https://www.ozon.ru/",
          publishedAt: new Date(Date.now() - (index + 1) * 42 * 60_000).toISOString(),
          answersCount: 1,
        },
      ];
      return {
        storeId: store.id,
        storeName: store.name,
        storeColor: store.color,
        platform: store.platform,
        balance: {
          status: { state: "ok" as const, message: null, updatedAt: generatedAt },
          primary: { amount: closing.toFixed(2), currency: "RUB" },
          primaryLabel: "期末余额" as const,
          openingBalance: { amount: (closing - 8_640).toFixed(2), currency: "RUB" },
          closingBalance: { amount: closing.toFixed(2), currency: "RUB" },
          accrued: { amount: "24860.00", currency: "RUB" },
          payments: [{ amount: "16220.00", currency: "RUB" }],
        },
        questions: {
          status: { state: "ok" as const, message: null, updatedAt: generatedAt },
          counts: { all: 18 + index * 3, new: 4, processed: 10, unprocessed: 3 + index, viewed: 1 },
          latest: questions,
        },
      };
    });
  return { generatedAt, stores };
}

/** Returns one non-PII demo question for the read-only question detail drawer. */
export function createDemoQuestionDetail(storeId: string, questionId: string): BuyerQuestionView {
  const question = createDemoStoreOperations(storeId).stores
    .flatMap((store) => store.questions.latest)
    .find((candidate) => candidate.id === questionId);
  if (!question) {
    throw new Error("演示问题不存在");
  }
  return question;
}

/** Builds one non-PII demo order using the same contract as the SQLite detail endpoint. */
export function createDemoOrderDetail(id: string): OrderDetail {
  const recentOrders = makeRecentOrders();
  const order = recentOrders.find((candidate) => candidate.id === id) ?? recentOrders[0];
  if (!order) {
    throw new Error("演示订单不存在");
  }
  const names = order.productNames.length > 0 ? order.productNames : ["商品名称暂不可用"];
  const totalQuantity = Math.max(order.itemCount, names.length);
  const unitAmount = new Decimal(order.amount.amount).dividedBy(totalQuantity).toFixed(2);
  let assignedQuantity = 0;
  return {
    id: order.id,
    platform: order.platform,
    externalOrderId: order.externalOrderId,
    postingNumber: order.postingNumber,
    orderNumber: order.postingNumber.split("-").slice(0, -1).join("-"),
    storeId: order.storeId,
    storeName: order.storeName,
    storeColor: order.storeColor,
    orderAt: order.orderAt,
    fulfillment: order.fulfillment,
    status: order.status,
    substatus: null,
    cancelled: order.cancelled,
    cancelledAt: order.cancelled ? order.orderAt : null,
    amount: order.amount,
    items: names.map((name, index) => {
      const quantity = index === names.length - 1 ? totalQuantity - assignedQuantity : 1;
      assignedQuantity += quantity;
      return {
        id: `${order.id}-item-${index}`,
        sku: `10000${index + 1}`,
        offerId: `DEMO-${index + 1}`,
        name,
        imageUrl: null,
        quantity,
        unitPrice: { amount: unitAmount, currency: order.amount.currency },
        subtotal: {
          amount: new Decimal(unitAmount).times(quantity).toFixed(2),
          currency: order.amount.currency,
        },
      };
    }),
  };
}

function financeMoney(amount: string, currency: string): Money {
  return { amount, currency };
}

type DemoFinanceFeeAmounts = Partial<Record<"commission" | "logistics" | "promotion" | "returns" | "otherDirect" | "unknown", string>>;

function demoFinanceBreakdown(currency: string, sales: string, directCosts: string, sharedCosts = "0.00", unknownAmount = "0.00", fees: DemoFinanceFeeAmounts = {}): FinanceMoneyBreakdown {
  const zero = "0.00";
  return {
    sales: financeMoney(sales, currency),
    commission: financeMoney(fees.commission ?? zero, currency),
    logistics: financeMoney(fees.logistics ?? zero, currency),
    promotion: financeMoney(fees.promotion ?? zero, currency),
    returns: financeMoney(fees.returns ?? zero, currency),
    otherDirect: financeMoney(fees.otherDirect ?? zero, currency),
    unknown: financeMoney(fees.unknown ?? unknownAmount, currency),
    directCosts: financeMoney(directCosts, currency),
    directReceivable: financeMoney(new Decimal(sales).plus(directCosts).toFixed(2), currency),
    sharedCosts: financeMoney(sharedCosts, currency),
    unknownAmount: financeMoney(unknownAmount, currency),
  };
}

function addDemoBreakdown(target: FinanceMoneyBreakdown, source: FinanceMoneyBreakdown): void {
  target.sales.amount = new Decimal(target.sales.amount).plus(source.sales.amount).toFixed(2);
  target.commission.amount = new Decimal(target.commission.amount).plus(source.commission.amount).toFixed(2);
  target.logistics.amount = new Decimal(target.logistics.amount).plus(source.logistics.amount).toFixed(2);
  target.promotion.amount = new Decimal(target.promotion.amount).plus(source.promotion.amount).toFixed(2);
  target.returns.amount = new Decimal(target.returns.amount).plus(source.returns.amount).toFixed(2);
  target.otherDirect.amount = new Decimal(target.otherDirect.amount).plus(source.otherDirect.amount).toFixed(2);
  target.unknown.amount = new Decimal(target.unknown.amount).plus(source.unknown.amount).toFixed(2);
  target.directCosts.amount = new Decimal(target.directCosts.amount).plus(source.directCosts.amount).toFixed(2);
  target.directReceivable.amount = new Decimal(target.directReceivable.amount).plus(source.directReceivable.amount).toFixed(2);
  target.sharedCosts.amount = new Decimal(target.sharedCosts.amount).plus(source.sharedCosts.amount).toFixed(2);
  target.unknownAmount.amount = new Decimal(target.unknownAmount.amount).plus(source.unknownAmount.amount).toFixed(2);
}

const demoFinanceStatuses: FinanceOrderStatus[] = ["stable", "direct_receivable", "pending_adjustments", "review"];

/** Provides deterministic order-level finance records for reviewing the reconciliation UI. */
export function createDemoFinanceOrders(month: string, selectedStoreId = "all"): FinanceOrderSummary[] {
  return demoStores
    .filter((store) => selectedStoreId === "all" || store.id === selectedStoreId)
    .flatMap((store, storeIndex) => {
      const currency = storeIndex === 2 ? "CNY" : "RUB";
      return Array.from({ length: 4 }, (_, orderIndex) => {
        const sales = new Decimal(8_900 + storeIndex * 1_350 + orderIndex * 1_180).toFixed(2);
        const commission = new Decimal(sales).times(-0.15).toFixed(2);
        const logistics = new Decimal(-420 - orderIndex * 38).toFixed(2);
        const promotion = orderIndex === 2 ? "-180.00" : "0.00";
        const returns = orderIndex === 3 ? "-890.00" : "0.00";
        const directCosts = new Decimal(commission).plus(logistics).plus(promotion).plus(returns).toFixed(2);
        const status = demoFinanceStatuses[orderIndex] ?? "stable";
        const postingId = `demo-finance-${store.id}-${orderIndex}`;
        const postingNumber = `FIN-${storeIndex + 1}${String(orderIndex + 1).padStart(3, "0")}`;
        const shipmentAt = status === "review" ? null : `${month}-${String(5 + orderIndex * 5).padStart(2, "0")}T09:30:00.000Z`;
        const lines: FinanceLineView[] = [
          { id: `${postingId}-revenue`, accrualDate: `${month}-10`, category: "revenue", categoryLabel: "成交收入", typeId: "1", typeName: "Продажа", postingNumber, sku: `SKU-${storeIndex + 1}01`, amount: financeMoney(sales, currency), quantity: 1, sellerPrice: financeMoney(sales, currency) },
          { id: `${postingId}-commission`, accrualDate: `${month}-10`, category: "commission", categoryLabel: "佣金", typeId: "2", typeName: "Комиссия за продажу", postingNumber, sku: `SKU-${storeIndex + 1}01`, amount: financeMoney(commission, currency), quantity: 1, sellerPrice: null },
          { id: `${postingId}-logistics`, accrualDate: `${month}-${String(11 + orderIndex).padStart(2, "0")}`, category: "logistics", categoryLabel: "物流费用", typeId: "29", typeName: "Доставка", postingNumber, sku: `SKU-${storeIndex + 1}01`, amount: financeMoney(logistics, currency), quantity: 1, sellerPrice: null },
          ...(promotion !== "0.00" ? [{ id: `${postingId}-promotion`, accrualDate: `${month}-12`, category: "promotion" as const, categoryLabel: "活动费用", typeId: "12", typeName: "Продвижение", postingNumber, sku: `SKU-${storeIndex + 1}01`, amount: financeMoney(promotion, currency), quantity: 1, sellerPrice: null }] : []),
          ...(returns !== "0.00" ? [{ id: `${postingId}-returns`, accrualDate: `${month}-15`, category: "returns" as const, categoryLabel: "退货/拒收", typeId: "6", typeName: "Возврат", postingNumber, sku: `SKU-${storeIndex + 1}01`, amount: financeMoney(returns, currency), quantity: 1, sellerPrice: null }] : []),
        ];
        return {
          postingId,
          storeId: store.id,
          storeName: store.name,
          storeColor: store.color,
          postingNumber,
          orderNumber: `ORDER-${storeIndex + 1}${String(orderIndex + 1).padStart(3, "0")}`,
          shipmentMonth: shipmentAt ? month : null,
          shipmentAt,
          shipmentTimeSource: status === "review" ? "missing" : "in_process_at",
          orderCurrency: currency,
          settlementCurrency: currency,
          items: [{ sku: `SKU-${storeIndex + 1}01`, offerId: `OFFER-${storeIndex + 1}01`, name: "轻量防水旅行收纳包", quantity: 1, currency }],
          breakdown: demoFinanceBreakdown(currency, sales, directCosts, "0.00", "0.00", { commission, logistics, promotion, returns }),
          status,
          cancelled: false,
          cancellationState: "none",
          exceptionReasons: status === "review" ? ["缺少发运时间"] : [],
          lastAccrualAt: `${month}-${String(15 + orderIndex).padStart(2, "0")}`,
          lines,
        } as FinanceOrderSummary & { lines: FinanceLineView[] };
      });
    });
}

/** Creates the finance summary with currency-separated totals and SKU rollups. */
export function createDemoFinanceOverview(month: string, selectedStoreId = "all"): FinanceOverview {
  const orders = createDemoFinanceOrders(month, selectedStoreId) as Array<FinanceOrderSummary & { lines: FinanceLineView[] }>;
  const stores = new Map<string, FinanceStoreSummary>();
  const skus = new Map<string, FinanceSkuSummary>();
  for (const order of orders) {
    const storeKey = `${order.storeId}:${order.settlementCurrency ?? "unsettled"}`;
    const store = stores.get(storeKey) ?? {
      storeId: order.storeId, storeName: order.storeName, storeColor: order.storeColor,
      settlementCurrency: order.settlementCurrency, orderCurrency: order.orderCurrency,
      orderCount: 0, salesQuantity: 0, skuCount: 0, breakdown: demoFinanceBreakdown(order.breakdown.sales.currency, "0.00", "0.00"),
      awaitingRevenueOrderCount: 0, directReceivableOrderCount: 0, pendingOrderCount: 0, stableOrderCount: 0, reviewOrderCount: 0, cancelledOrderCount: 0, cancelledNoRevenueOrderCount: 0, cancelledWithRevenueOrderCount: 0,
      lastAccrualAt: null,
    };
    store.orderCount += 1;
    store.salesQuantity += order.items.reduce((sum, item) => sum + item.quantity, 0);
    store.orderCurrency = store.orderCurrency === order.orderCurrency ? store.orderCurrency : null;
    addDemoBreakdown(store.breakdown, order.breakdown);
    if (order.status === "awaiting_revenue") store.awaitingRevenueOrderCount += 1;
    if (order.status === "direct_receivable") store.directReceivableOrderCount += 1;
    if (order.status === "pending_adjustments") store.pendingOrderCount += 1;
    if (order.status === "stable") store.stableOrderCount += 1;
    if (order.status === "review") store.reviewOrderCount += 1;
    store.lastAccrualAt = store.lastAccrualAt && store.lastAccrualAt > (order.lastAccrualAt ?? "") ? store.lastAccrualAt : order.lastAccrualAt;
    stores.set(storeKey, store);
    for (const item of order.items) {
      const skuKey = `${storeKey}:${item.sku}`;
      const sku = skus.get(skuKey) ?? {
        storeId: order.storeId, storeName: order.storeName, storeColor: order.storeColor, sku: item.sku,
        settlementCurrency: order.settlementCurrency, orderCurrency: order.orderCurrency,
        orderCount: 0, quantity: 0, breakdown: demoFinanceBreakdown(order.breakdown.sales.currency, "0.00", "0.00"),
        statusCounts: { awaiting_revenue: 0, direct_receivable: 0, pending_adjustments: 0, stable: 0, review: 0 },
      };
      sku.orderCount += 1;
      sku.quantity += item.quantity;
      sku.orderCurrency = sku.orderCurrency === order.orderCurrency ? sku.orderCurrency : null;
      addDemoBreakdown(sku.breakdown, order.breakdown);
      sku.statusCounts[order.status] += 1;
      skus.set(skuKey, sku);
    }
  }
  for (const store of stores.values()) {
    store.skuCount = [...skus.values()].filter((sku) => sku.storeId === store.storeId && sku.settlementCurrency === store.settlementCurrency).length;
    store.breakdown.sharedCosts.amount = store.settlementCurrency === "RUB" ? "2350.00" : "180.00";
    store.breakdown.directReceivable.amount = new Decimal(store.breakdown.sales.amount).plus(store.breakdown.directCosts.amount).toFixed(2);
  }
  const totals = new Map<string, FinanceMoneyBreakdown>();
  for (const store of stores.values()) {
    if (!store.settlementCurrency) continue;
    const total = totals.get(store.settlementCurrency) ?? demoFinanceBreakdown(store.settlementCurrency, "0.00", "0.00");
    addDemoBreakdown(total, store.breakdown);
    totals.set(store.settlementCurrency, total);
  }
  return {
    generatedAt: new Date().toISOString(),
    month,
    stores: [...stores.values()],
    skuSummaries: [...skus.values()],
    totalsByCurrency: [...totals.values()],
    unassignedFees: [],
    sync: createDemoFinanceSync(month),
  };
}

/** Returns the demo order list used by the finance table and its detail drawer. */
export function createDemoFinanceOrderPage(month: string, selectedStoreId = "all", sku?: string, status?: FinanceOrderStatus, page = 1, pageSize = 20): { items: FinanceOrderSummary[]; page: number; pageSize: number; total: number } {
  const all = createDemoFinanceOrders(month, selectedStoreId).filter((order) => (!sku || order.items.some((item) => item.sku.includes(sku))) && (!status || order.status === status));
  const start = (page - 1) * pageSize;
  return { items: all.slice(start, start + pageSize), page, pageSize, total: all.length };
}

/** Provides one demo accrual timeline for the finance detail drawer. */
export function createDemoFinanceOrderDetail(postingId: string, month = new Date().toISOString().slice(0, 7)): FinanceOrderDetail {
  const order = createDemoFinanceOrders(month).find((candidate) => candidate.postingId === postingId) as (FinanceOrderSummary & { lines: FinanceLineView[] }) | undefined;
  if (!order) throw new Error("演示财务订单不存在");
  return { ...order, lines: order.lines };
}

/** Provides representative finance exceptions without exposing buyer information. */
export function createDemoFinanceExceptions(month: string, selectedStoreId = "all"): FinanceExceptionView[] {
  const order = createDemoFinanceOrders(month, selectedStoreId).find((candidate) => candidate.status === "review");
  if (!order) return [];
  return [{
    id: `${order.postingId}-exception`, storeId: order.storeId, storeName: order.storeName, postingNumber: order.postingNumber, sku: null,
    category: "unknown", amount: financeMoney("-320.00", order.settlementCurrency ?? order.orderCurrency), reason: "订单缺少发运时间，无法归属发运月份", accrualDate: `${month}-15`,
  }];
}

/** Provides an immediately completed demo sync task for manual-rebuild interactions. */
export function createDemoFinanceSync(month: string, id = "demo-finance-sync"): FinanceSyncView {
  return { id, state: "completed", from: `${month}-01`, to: `${month}-28`, totalDays: 28, completedDays: 28, failedDays: 0, error: null, startedAt: new Date(Date.now() - 4_000).toISOString(), finishedAt: new Date().toISOString() };
}
