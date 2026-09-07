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
