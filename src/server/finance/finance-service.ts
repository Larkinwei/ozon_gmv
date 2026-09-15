import Decimal from "decimal.js";

import type {
  FinanceExceptionView,
  FinanceCoverageStoreView,
  FinanceCoverageView,
  FinanceCategory,
  FinanceLineView,
  FinanceMoneyBreakdown,
  FinanceOrderDetail,
  FinanceOrderStatus,
  FinanceOrderSummary,
  FinanceOverview,
  FinanceSkuSummary,
  FinanceStoreSummary,
  FinanceSyncView,
  FinanceUnassignedFeeView,
  Money,
} from "../../shared/contracts";
import type { AppConfig } from "../config";
import { FinanceRepository, type FinanceLineRecord, type FinancePostingRecord, type FinanceSyncRunRecord } from "../db/finance-repository";
import { PostingsRepository } from "../db/postings-repository";
import { financeCategoryLabel, normalizeAccrual } from "./accrual-normalize";
import { decryptSecret } from "../security/encryption";
import { OzonClient } from "../ozon/client";
import { normalizePosting } from "../ozon/normalize";
import { StoresRepository, type StoreRecord } from "../db/stores-repository";
import type { ProxySettingsService } from "../services/proxy-settings-service";

const INITIAL_HISTORY_MONTHS = 12;
const ROLLING_ADJUSTMENT_DAYS = 180;
const FINANCE_STABILITY_DAYS = 30;

export interface FinanceOrderQuery {
  month: string;
  storeIds: string[];
  sku?: string;
  status?: FinanceOrderStatus;
  page: number;
  pageSize: number;
}

export interface FinanceOrderPage {
  items: FinanceOrderSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface FinanceExceptionQuery {
  month: string;
  storeIds: string[];
}

export interface FinanceSyncInput {
  storeIds: string[];
  from: string;
  to: string;
  mode: "ensure" | "rebuild";
}

export interface FinanceReader {
  getOverview(month: string, storeIds: string[]): Promise<FinanceOverview>;
  getCoverage(month: string, storeIds: string[]): Promise<FinanceCoverageView>;
  getOrders(query: FinanceOrderQuery): Promise<FinanceOrderPage>;
  getOrderDetail(postingId: string): Promise<FinanceOrderDetail | null>;
  getExceptions(query: FinanceExceptionQuery): Promise<FinanceExceptionView[]>;
  beginSync(input: FinanceSyncInput): Promise<FinanceSyncView>;
  getSyncRun(id: string): FinanceSyncView | null;
  start(): void;
  syncActiveStores(from: Date, to: Date): Promise<void>;
}

interface FinanceServiceOptions {
  now?: () => Date;
}

interface MonthData {
  activeStores: StoreRecord[];
  postings: FinancePostingRecord[];
  lines: FinanceLineRecord[];
  lineIndex: FinanceLineIndex;
  orders: FinanceOrderSummary[];
}

interface FinanceLineIndex {
  byPosting: Map<string, FinanceLineRecord[]>;
  byOrderNumber: Map<string, FinanceLineRecord[]>;
  byStoreSku: Map<string, FinanceLineRecord[]>;
}

function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function monthBounds(month: string): { fromDate: string; toDate: string; fromMs: number; toMs: number } {
  if (!isMonth(month)) {
    throw new RangeError(`月份格式不正确：${month}`);
  }
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const from = new Date(Date.UTC(year, monthIndex, 1));
  const to = new Date(Date.UTC(year, monthIndex + 1, 1));
  return {
    fromDate: from.toISOString().slice(0, 10),
    toDate: new Date(to.getTime() - 1).toISOString().slice(0, 10),
    fromMs: from.getTime(),
    toMs: to.getTime(),
  };
}

export function financeMonthSyncRange(month: string, now = new Date()): { from: string; to: string } | null {
  const bounds = monthBounds(month);
  const today = dateString(now);
  if (bounds.fromDate > today) return null;
  return { from: bounds.fromDate, to: today };
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateRange(from: Date, to: Date): string[] {
  const result: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor.getTime() <= end.getTime()) {
    result.push(dateString(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function addAmount(left: string, right: string): string {
  return new Decimal(left).plus(right).toFixed(2);
}

function zeroBreakdown(currency: string): FinanceMoneyBreakdown {
  const zero: Money = { amount: "0.00", currency };
  return {
    sales: { ...zero },
    commission: { ...zero },
    logistics: { ...zero },
    promotion: { ...zero },
    returns: { ...zero },
    otherDirect: { ...zero },
    unknown: { ...zero },
    directCosts: { ...zero },
    directReceivable: { ...zero },
    sharedCosts: { ...zero },
    unknownAmount: { ...zero },
  };
}

function addBreakdown(target: FinanceMoneyBreakdown, source: FinanceMoneyBreakdown): void {
  target.sales.amount = addAmount(target.sales.amount, source.sales.amount);
  target.commission.amount = addAmount(target.commission.amount, source.commission.amount);
  target.logistics.amount = addAmount(target.logistics.amount, source.logistics.amount);
  target.promotion.amount = addAmount(target.promotion.amount, source.promotion.amount);
  target.returns.amount = addAmount(target.returns.amount, source.returns.amount);
  target.otherDirect.amount = addAmount(target.otherDirect.amount, source.otherDirect.amount);
  target.unknown.amount = addAmount(target.unknown.amount, source.unknown.amount);
  target.directCosts.amount = addAmount(target.directCosts.amount, source.directCosts.amount);
  target.directReceivable.amount = addAmount(target.directReceivable.amount, source.directReceivable.amount);
  target.sharedCosts.amount = addAmount(target.sharedCosts.amount, source.sharedCosts.amount);
  target.unknownAmount.amount = addAmount(target.unknownAmount.amount, source.unknownAmount.amount);
}

function feeBreakdownKey(category: FinanceCategory): "commission" | "logistics" | "promotion" | "returns" | "otherDirect" | "unknown" | null {
  switch (category) {
    case "commission": return "commission";
    case "logistics": return "logistics";
    case "promotion": return "promotion";
    case "returns": return "returns";
    case "other_direct": return "otherDirect";
    case "unknown": return "unknown";
    default: return null;
  }
}

function addLineToBreakdown(target: FinanceMoneyBreakdown, line: FinanceLineRecord): void {
  if (line.category === "revenue") {
    target.sales.amount = addAmount(target.sales.amount, line.amount);
    target.directReceivable.amount = addAmount(target.directReceivable.amount, line.amount);
    return;
  }
  if (line.category === "shared") {
    target.sharedCosts.amount = addAmount(target.sharedCosts.amount, line.amount);
    return;
  }
  const key = feeBreakdownKey(line.category);
  if (key) {
    target[key].amount = addAmount(target[key].amount, line.amount);
  }
  target.directCosts.amount = addAmount(target.directCosts.amount, line.amount);
  target.directReceivable.amount = addAmount(target.directReceivable.amount, line.amount);
  if (line.category === "unknown") {
    target.unknownAmount.amount = addAmount(target.unknownAmount.amount, line.amount);
  }
}

function confirmedFinanceLines(lines: FinanceLineRecord[]): FinanceLineRecord[] {
  return lines.filter((line) => line.category !== "unknown");
}

function lineCurrencies(lines: FinanceLineRecord[]): string[] {
  return [...new Set(lines.map((line) => line.currency).filter(Boolean))];
}

function settlementCurrency(lines: FinanceLineRecord[]): string | null {
  const currencies = lineCurrencies(lines);
  return currencies.length === 1 ? currencies[0] ?? null : null;
}

function usableBreakdownLines(lines: FinanceLineRecord[]): FinanceLineRecord[] {
  return lineCurrencies(lines).length > 1 ? [] : lines;
}

function statusForPosting(posting: FinancePostingRecord, lines: FinanceLineRecord[], now: Date, exceptionReasons: string[]): FinanceOrderStatus {
  if (!posting.shipmentAtMs || exceptionReasons.length > 0) {
    return "review";
  }
  const revenueFound = lines.some((line) => line.category === "revenue");
  if (!revenueFound) {
    return "awaiting_revenue";
  }
  if (lines.every((line) => line.category === "revenue")) {
    return "direct_receivable";
  }
  const lastAccrualAt = lines.reduce((latest, line) => line.accrualDate > latest ? line.accrualDate : latest, "");
  const stableAt = new Date(`${lastAccrualAt || dateString(new Date(posting.shipmentAtMs))}T00:00:00.000Z`);
  const ageDays = (now.getTime() - stableAt.getTime()) / 86_400_000;
  return ageDays >= FINANCE_STABILITY_DAYS ? "stable" : "pending_adjustments";
}

function isCancelledPosting(posting: FinancePostingRecord): boolean {
  return posting.status.toLowerCase().includes("cancel");
}

function toOrderItems(posting: FinancePostingRecord): FinanceOrderSummary["items"] {
  return posting.items.map((item) => ({ sku: item.sku, offerId: item.offerId, name: item.name, quantity: item.quantity, currency: item.currency }));
}

function orderExceptionReasons(posting: FinancePostingRecord, lines: FinanceLineRecord[]): string[] {
  const reasons: string[] = [];
  const currencies = lineCurrencies(lines);
  if (!posting.shipmentAtMs) reasons.push("缺少发运时间");
  if (currencies.length > 1) reasons.push("订单包含多种财务币种，无法合计");
  if (posting.items.length > 1 && lines.some((line) => line.postingNumber === posting.postingNumber && !line.sku && line.category !== "shared")) {
    reasons.push("部分费用无法匹配到 SKU");
  }
  return reasons;
}

/** Matches direct posting lines first, then SKU-only lines without weakening store isolation. */
function indexFinanceLines(lines: FinanceLineRecord[]): FinanceLineIndex {
  const byPosting = new Map<string, FinanceLineRecord[]>();
  const byOrderNumber = new Map<string, FinanceLineRecord[]>();
  const byStoreSku = new Map<string, FinanceLineRecord[]>();
  for (const line of lines) {
    if (line.postingNumber) {
      const postingLines = byPosting.get(`${line.storeId}:${line.postingNumber}`) ?? [];
      postingLines.push(line);
      byPosting.set(`${line.storeId}:${line.postingNumber}`, postingLines);
    }
    if (line.unitNumber) {
      const orderLines = byOrderNumber.get(`${line.storeId}:${line.unitNumber}`) ?? [];
      orderLines.push(line);
      byOrderNumber.set(`${line.storeId}:${line.unitNumber}`, orderLines);
    }
    if (line.sku) {
      const skuLines = byStoreSku.get(`${line.storeId}:${line.sku}`) ?? [];
      skuLines.push(line);
      byStoreSku.set(`${line.storeId}:${line.sku}`, skuLines);
    }
  }
  return { byPosting, byOrderNumber, byStoreSku };
}

function linesForPosting(posting: Pick<FinancePostingRecord, "storeId" | "postingNumber" | "orderNumber" | "items">, lines: FinanceLineRecord[], index = indexFinanceLines(lines)): FinanceLineRecord[] {
  const direct = index.byPosting.get(`${posting.storeId}:${posting.postingNumber}`) ?? [];
  if (direct.length > 0) return direct;
  const orderNumberLines = index.byOrderNumber.get(`${posting.storeId}:${posting.orderNumber}`) ?? [];
  if (orderNumberLines.length > 0) return orderNumberLines;
  const skus = new Set(posting.items.map((item) => item.sku));
  return [...skus].flatMap((sku) => (index.byStoreSku.get(`${posting.storeId}:${sku}`) ?? []).filter((line) => !line.postingNumber));
}

function toOrderSummary(posting: FinancePostingRecord, lines: FinanceLineRecord[], now: Date): FinanceOrderSummary {
  const confirmedLines = confirmedFinanceLines(lines);
  const resolvedSettlementCurrency = settlementCurrency(confirmedLines);
  const breakdown = zeroBreakdown(resolvedSettlementCurrency ?? posting.currency);
  for (const line of usableBreakdownLines(confirmedLines)) addLineToBreakdown(breakdown, line);
  const exceptionReasons = orderExceptionReasons(posting, confirmedLines);
  const lastAccrualAt = confirmedLines.reduce((latest, line) => line.accrualDate > latest ? line.accrualDate : latest, "") || null;
  const cancelled = isCancelledPosting(posting);
  const cancellationState = !cancelled
    ? "none"
    : confirmedLines.some((line) => line.category === "revenue")
      ? "with_revenue"
      : "no_revenue";
  return {
    postingId: posting.id,
    storeId: posting.storeId,
    storeName: posting.storeName,
    storeColor: posting.storeColor,
    postingNumber: posting.postingNumber,
    orderNumber: posting.orderNumber,
    shipmentMonth: posting.shipmentAtMs ? dateString(new Date(posting.shipmentAtMs)).slice(0, 7) : null,
    shipmentAt: posting.shipmentAtMs ? new Date(posting.shipmentAtMs).toISOString() : null,
    shipmentTimeSource: posting.shipmentTimeSource,
    orderCurrency: posting.currency,
    settlementCurrency: resolvedSettlementCurrency,
    items: toOrderItems(posting),
    breakdown,
    status: statusForPosting(posting, confirmedLines, now, exceptionReasons),
    cancelled,
    cancellationState,
    exceptionReasons,
    lastAccrualAt,
  };
}

function toSyncView(run: FinanceSyncRunRecord | null): FinanceSyncView {
  if (!run) {
    return { id: null, state: "idle", from: null, to: null, totalDays: 0, completedDays: 0, failedDays: 0, error: null, startedAt: null, finishedAt: null };
  }
  return {
    id: run.id,
    state: run.state,
    from: run.fromDate,
    to: run.toDate,
    totalDays: run.totalDays,
    completedDays: run.completedDays,
    failedDays: run.failedDays,
    error: run.error,
    startedAt: run.startedAtMs ? new Date(run.startedAtMs).toISOString() : null,
    finishedAt: run.finishedAtMs ? new Date(run.finishedAtMs).toISOString() : null,
  };
}

function summaryKey(storeId: string, settlementCurrency: string | null): string {
  return `${storeId}:${settlementCurrency ?? "unsettled"}`;
}

function createStoreSummary(order: FinanceOrderSummary): FinanceStoreSummary {
  return {
    storeId: order.storeId,
    storeName: order.storeName,
    storeColor: order.storeColor,
    settlementCurrency: order.settlementCurrency,
    orderCurrency: order.orderCurrency,
    orderCount: 0,
    salesQuantity: 0,
    skuCount: 0,
    breakdown: zeroBreakdown(order.breakdown.sales.currency),
    awaitingRevenueOrderCount: 0,
    directReceivableOrderCount: 0,
    pendingOrderCount: 0,
    stableOrderCount: 0,
    reviewOrderCount: 0,
    cancelledOrderCount: 0,
    cancelledNoRevenueOrderCount: 0,
    cancelledWithRevenueOrderCount: 0,
    lastAccrualAt: null,
  };
}

function unassignedFeesForMonth(lines: FinanceLineRecord[], stores: StoreRecord[], bounds: ReturnType<typeof monthBounds>): FinanceUnassignedFeeView[] {
  const storeMap = new Map(stores.map((store) => [store.id, store]));
  const groups = new Map<string, FinanceUnassignedFeeView>();
  for (const line of lines) {
    if (line.category !== "unknown" || line.sourceDate < bounds.fromDate || line.sourceDate > bounds.toDate) continue;
    const store = storeMap.get(line.storeId);
    if (!store) continue;
    const key = `${line.storeId}:${line.currency}:${line.typeId ?? ""}:${line.typeName ?? ""}`;
    const existing = groups.get(key);
    if (existing) {
      existing.amount.amount = addAmount(existing.amount.amount, line.amount);
      existing.lineCount += 1;
      if (line.sourceDate < existing.sourceDateFrom) existing.sourceDateFrom = line.sourceDate;
      if (line.sourceDate > existing.sourceDateTo) existing.sourceDateTo = line.sourceDate;
      continue;
    }
    groups.set(key, {
      storeId: store.id,
      storeName: store.name,
      storeColor: store.color,
      currency: line.currency,
      amount: { amount: line.amount, currency: line.currency },
      lineCount: 1,
      typeId: line.typeId,
      typeName: line.typeName,
      sourceDateFrom: line.sourceDate,
      sourceDateTo: line.sourceDate,
    });
  }
  return [...groups.values()].sort((left, right) => left.storeName.localeCompare(right.storeName) || left.currency.localeCompare(right.currency) || (left.typeName ?? left.typeId ?? "").localeCompare(right.typeName ?? right.typeId ?? ""));
}

function mergeOrderCurrency(current: string | null, next: string, hasPrevious: boolean): string | null {
  return !hasPrevious || current === next ? next : null;
}

function addStoreStatusCount(store: FinanceStoreSummary, status: FinanceOrderStatus): void {
  if (status === "awaiting_revenue") store.awaitingRevenueOrderCount += 1;
  if (status === "direct_receivable") store.directReceivableOrderCount += 1;
  if (status === "pending_adjustments") store.pendingOrderCount += 1;
  if (status === "stable") store.stableOrderCount += 1;
  if (status === "review") store.reviewOrderCount += 1;
}

function itemQuantitiesBySku(items: FinanceOrderSummary["items"]): Map<string, number> {
  const quantities = new Map<string, number>();
  for (const item of items) {
    quantities.set(item.sku, (quantities.get(item.sku) ?? 0) + item.quantity);
  }
  return quantities;
}

export class FinanceAnalysisService implements FinanceReader {
  private readonly activeStores = new Set<string>();
  private readonly now: () => Date;

  public constructor(
    private readonly config: AppConfig,
    private readonly stores: StoresRepository,
    private readonly repository: FinanceRepository,
    private readonly postings: PostingsRepository,
    private readonly proxySettings: ProxySettingsService,
    options: FinanceServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  public start(): void {
    void this.bootstrap().catch(() => undefined);
  }

  public async syncActiveStores(from: Date, to: Date): Promise<void> {
    const stores = (await this.stores.listActive()).filter((store) => store.platform === "ozon");
    await Promise.allSettled(stores.map((store) => this.syncStore(store.id, from, to, true)));
  }

  public async beginSync(input: FinanceSyncInput): Promise<FinanceSyncView> {
    const days = dateRange(new Date(`${input.from}T00:00:00.000Z`), new Date(`${input.to}T00:00:00.000Z`));
    const activeStoreCount = (await this.stores.listActive()).filter((store) => store.platform === "ozon" && (input.storeIds.length === 0 || input.storeIds.includes(store.id))).length;
    const totalDays = days.length * activeStoreCount;
    const existing = this.repository.findActiveRun(input.from, input.to, input.storeIds);
    if (existing) return toSyncView(existing);
    const run = this.repository.createRun(input.from, input.to, totalDays, input.storeIds, input.mode);
    void this.processRun(run.id, input).catch(() => undefined);
    return toSyncView(run);
  }

  public getSyncRun(id: string): FinanceSyncView | null {
    return toSyncView(this.repository.getRun(id));
  }

  public async getOverview(month: string, storeIds: string[]): Promise<FinanceOverview> {
    const data = await this.loadMonthData(month, storeIds);
    const storeSummaries = new Map<string, FinanceStoreSummary>();
    const skuSummaries = new Map<string, FinanceSkuSummary>();
    for (const order of data.orders) {
      const key = summaryKey(order.storeId, order.settlementCurrency);
      const current = storeSummaries.get(key) ?? createStoreSummary(order);
      current.orderCurrency = mergeOrderCurrency(current.orderCurrency, order.orderCurrency, current.orderCount > 0);
      current.orderCount += 1;
      current.salesQuantity += order.items.reduce((sum, item) => sum + item.quantity, 0);
      addBreakdown(current.breakdown, order.breakdown);
      if (order.cancelled) {
        current.cancelledOrderCount += 1;
        if (order.cancellationState === "no_revenue") current.cancelledNoRevenueOrderCount += 1;
        if (order.cancellationState === "with_revenue") current.cancelledWithRevenueOrderCount += 1;
      }
      else addStoreStatusCount(current, order.status);
      if (order.lastAccrualAt && (!current.lastAccrualAt || order.lastAccrualAt > current.lastAccrualAt)) current.lastAccrualAt = order.lastAccrualAt;
      storeSummaries.set(key, current);
      const postingLines = usableBreakdownLines(confirmedFinanceLines(linesForPosting(order, data.lines, data.lineIndex)));
      for (const [skuCode, quantity] of itemQuantitiesBySku(order.items)) {
        const skuKey = `${order.storeId}:${skuCode}:${order.settlementCurrency ?? "unsettled"}`;
        const sku = skuSummaries.get(skuKey) ?? {
          storeId: order.storeId,
          storeName: order.storeName,
          storeColor: order.storeColor,
          sku: skuCode,
          settlementCurrency: order.settlementCurrency,
          orderCurrency: order.orderCurrency,
          orderCount: 0,
          quantity: 0,
          breakdown: zeroBreakdown(order.breakdown.sales.currency),
          statusCounts: { awaiting_revenue: 0, direct_receivable: 0, pending_adjustments: 0, stable: 0, review: 0 },
        };
        sku.orderCount += 1;
        sku.quantity += quantity;
        sku.orderCurrency = mergeOrderCurrency(sku.orderCurrency, order.orderCurrency, sku.orderCount > 1);
        const itemLines = postingLines.filter((line) => line.sku === skuCode || (!line.sku && order.items.length === 1));
        for (const line of itemLines) addLineToBreakdown(sku.breakdown, line);
        if (!order.cancelled) sku.statusCounts[order.status] += 1;
        skuSummaries.set(skuKey, sku);
      }
    }
    for (const summary of storeSummaries.values()) {
      summary.skuCount = skuSummaries.size === 0
        ? 0
        : [...skuSummaries.values()].filter((sku) => sku.storeId === summary.storeId && sku.settlementCurrency === summary.settlementCurrency).length;
    }
    const bounds = monthBounds(month);
    for (const line of data.lines.filter((candidate) => candidate.category === "shared" && candidate.sourceDate >= bounds.fromDate && candidate.sourceDate <= bounds.toDate)) {
      const key = summaryKey(line.storeId, line.currency);
      let store = storeSummaries.get(key);
      if (!store) {
        const sourceStore = data.activeStores.find((candidate) => candidate.id === line.storeId);
        if (!sourceStore) continue;
        store = {
          storeId: sourceStore.id,
          storeName: sourceStore.name,
          storeColor: sourceStore.color,
          settlementCurrency: line.currency,
          orderCurrency: null,
          orderCount: 0,
          salesQuantity: 0,
          skuCount: 0,
          breakdown: zeroBreakdown(line.currency),
          pendingOrderCount: 0,
          awaitingRevenueOrderCount: 0,
          directReceivableOrderCount: 0,
          stableOrderCount: 0,
          reviewOrderCount: 0,
          cancelledOrderCount: 0,
          cancelledNoRevenueOrderCount: 0,
          cancelledWithRevenueOrderCount: 0,
          lastAccrualAt: null,
        };
        storeSummaries.set(key, store);
      }
      addLineToBreakdown(store.breakdown, line);
    }
    const totals = new Map<string, FinanceMoneyBreakdown>();
    for (const summary of storeSummaries.values()) {
      if (!summary.settlementCurrency) continue;
      const total = totals.get(summary.settlementCurrency) ?? zeroBreakdown(summary.settlementCurrency);
      addBreakdown(total, summary.breakdown);
      totals.set(summary.settlementCurrency, total);
    }
    return {
      generatedAt: this.now().toISOString(),
      month,
      stores: [...storeSummaries.values()],
      skuSummaries: [...skuSummaries.values()],
      totalsByCurrency: [...totals.values()],
      unassignedFees: unassignedFeesForMonth(data.lines, data.activeStores, bounds),
      sync: (() => {
        const range = financeMonthSyncRange(month, this.now());
        return range ? toSyncView(this.repository.latestRunForScope(range.from, range.to, storeIds)) : toSyncView(null);
      })(),
    };
  }

  public async getCoverage(month: string, storeIds: string[]): Promise<FinanceCoverageView> {
    const range = financeMonthSyncRange(month, this.now());
    const activeStores = (await this.stores.listActive()).filter((store) => store.platform === "ozon" && (storeIds.length === 0 || storeIds.includes(store.id)));
    if (!range) {
      return {
        month,
        from: null,
        to: null,
        totalDays: 0,
        completedDays: 0,
        failedDays: 0,
        missingDates: [],
        complete: true,
        future: true,
        stores: activeStores.map((store) => ({ storeId: store.id, totalDays: 0, completedDays: 0, failedDays: 0, missingDates: [], lastSyncedAt: null, complete: true })),
      };
    }
    const expectedDates = dateRange(new Date(`${range.from}T00:00:00.000Z`), new Date(`${range.to}T00:00:00.000Z`));
    const rawCoverage = this.repository.getFinanceCoverage(activeStores.map((store) => store.id), range.from, range.to);
    const stores: FinanceCoverageStoreView[] = activeStores.map((store) => {
      const current = rawCoverage.get(store.id) ?? { completedDates: [], failedDates: [], lastSyncedAtMs: null };
      const completed = new Set(current.completedDates);
      const missingDates = expectedDates.filter((date) => !completed.has(date));
      return {
        storeId: store.id,
        totalDays: expectedDates.length,
        completedDays: current.completedDates.length,
        failedDays: current.failedDates.length,
        missingDates,
        lastSyncedAt: current.lastSyncedAtMs ? new Date(current.lastSyncedAtMs).toISOString() : null,
        complete: missingDates.length === 0,
      };
    });
    const missingDates = [...new Set(stores.flatMap((store) => store.missingDates))].sort();
    return {
      month,
      from: range.from,
      to: range.to,
      totalDays: expectedDates.length * activeStores.length,
      completedDays: stores.reduce((sum, store) => sum + store.completedDays, 0),
      failedDays: stores.reduce((sum, store) => sum + store.failedDays, 0),
      missingDates,
      complete: stores.every((store) => store.complete),
      future: false,
      stores,
    };
  }

  public async getOrders(query: FinanceOrderQuery): Promise<FinanceOrderPage> {
    const data = await this.loadMonthData(query.month, query.storeIds);
    const filtered = data.orders.filter((order) => {
      if (query.sku && !order.items.some((item) => item.sku.includes(query.sku!))) return false;
      return !query.status || order.status === query.status;
    });
    const start = (query.page - 1) * query.pageSize;
    return { items: filtered.slice(start, start + query.pageSize), page: query.page, pageSize: query.pageSize, total: filtered.length };
  }

  public async getOrderDetail(postingId: string): Promise<FinanceOrderDetail | null> {
    const posting = this.repository.getPosting(postingId);
    if (!posting) return null;
    const lines = this.repository.listLines([posting.storeId]);
    const lineIndex = indexFinanceLines(lines);
    const postingLines = confirmedFinanceLines(linesForPosting(posting, lines, lineIndex));
    const summary = toOrderSummary(posting, postingLines, this.now());
    return {
      ...summary,
      lines: postingLines.map((line): FinanceLineView => ({
        id: line.id,
        accrualDate: line.accrualDate,
        category: line.category,
        categoryLabel: financeCategoryLabel(line.category),
        typeId: line.typeId,
        typeName: line.typeName,
        postingNumber: line.postingNumber,
        sku: line.sku,
        amount: { amount: line.amount, currency: line.currency },
        quantity: line.quantity,
        sellerPrice: line.sellerPrice ? { amount: line.sellerPrice, currency: line.currency } : null,
      })),
    };
  }

  public async getExceptions(query: FinanceExceptionQuery): Promise<FinanceExceptionView[]> {
    const data = await this.loadMonthData(query.month, query.storeIds);
    const allPostings = this.repository.listAllPostings(query.storeIds);
    const postingMap = new Map(allPostings.map((posting) => [`${posting.storeId}:${posting.postingNumber}`, posting]));
    const postingsBySku = new Map<string, FinancePostingRecord[]>();
    for (const posting of allPostings) {
      for (const item of posting.items) {
        const key = `${posting.storeId}:${item.sku}`;
        const matches = postingsBySku.get(key) ?? [];
        matches.push(posting);
        postingsBySku.set(key, matches);
      }
    }
    const bounds = monthBounds(query.month);
    const results: FinanceExceptionView[] = [];
    for (const line of data.lines) {
      if (line.category === "unknown") continue;
      let posting = line.postingNumber ? postingMap.get(`${line.storeId}:${line.postingNumber}`) : undefined;
      if (!posting && line.unitNumber) {
        const orderMatches = allPostings.filter((candidate) => candidate.storeId === line.storeId && candidate.orderNumber === line.unitNumber);
        posting = orderMatches.length === 1 ? orderMatches[0] : undefined;
      }
      if (!posting && line.sku) {
        const skuMatches = postingsBySku.get(`${line.storeId}:${line.sku}`) ?? [];
        posting = skuMatches.length === 1 ? skuMatches[0] : undefined;
      }
      const lineInMonth = line.sourceDate >= bounds.fromDate && line.sourceDate <= bounds.toDate;
      const postingInMonth = Boolean(posting?.shipmentAtMs && posting.shipmentAtMs >= bounds.fromMs && posting.shipmentAtMs < bounds.toMs);
      const inScope = line.category === "shared" ? lineInMonth : Boolean(posting ? postingInMonth || lineInMonth : lineInMonth);
      if (!inScope) continue;
      const postingLines = posting ? confirmedFinanceLines(linesForPosting(posting, data.lines, data.lineIndex)) : [];
      let reason: string | null = null;
      if (!posting && line.category !== "shared") reason = "财务流水找不到本地订单";
      else if (posting && !posting.shipmentAtMs) reason = "订单缺少发运时间";
      else if (posting && posting.items.length > 1 && !line.sku && line.category !== "shared") reason = "费用无法匹配到 SKU";
      else if (posting && lineCurrencies(postingLines).length > 1) reason = "同一订单存在多种结算币种";
      if (!reason) continue;
      results.push({
        id: line.id,
        storeId: line.storeId,
        storeName: posting?.storeName ?? "未知店铺",
        postingNumber: line.postingNumber,
        sku: line.sku,
        category: line.category,
        amount: { amount: line.amount, currency: line.currency },
        reason,
        accrualDate: line.accrualDate,
      });
    }
    return results;
  }

  private async loadMonthData(month: string, storeIds: string[]): Promise<MonthData> {
    const bounds = monthBounds(month);
    const activeStores = (await this.stores.listActive()).filter((store) => store.platform === "ozon" && (storeIds.length === 0 || storeIds.includes(store.id)));
    const ids = activeStores.map((store) => store.id);
    const postings = this.repository.listPostingsForMonth(ids, bounds.fromMs, bounds.toMs);
    const lines = this.repository.listLines(ids);
    const lineIndex = indexFinanceLines(lines);
    return { activeStores, postings, lines, lineIndex, orders: postings.map((posting) => toOrderSummary(posting, linesForPosting(posting, lines, lineIndex), this.now())) };
  }

  private async bootstrap(): Promise<void> {
    const activeStores = (await this.stores.listActive()).filter((store) => store.platform === "ozon");
    const now = this.now();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - INITIAL_HISTORY_MONTHS + 1, 1));
    const fromDate = dateString(from);
    const toDate = dateString(now);
    const storesNeedingCoverage = activeStores.filter((store) => !this.repository.hasCompleteFinanceCoverage(store.id, fromDate, toDate));
    await Promise.allSettled(storesNeedingCoverage.map((store) => this.syncStore(store.id, from, now, false)));
    await this.syncActiveStores(new Date(now.getTime() - 86_400_000), now);
  }

  private async processRun(runId: string, input: FinanceSyncInput): Promise<void> {
    const activeStores = (await this.stores.listActive()).filter((store) => store.platform === "ozon" && (input.storeIds.length === 0 || input.storeIds.includes(store.id)));
    const totalDays = dateRange(new Date(`${input.from}T00:00:00.000Z`), new Date(`${input.to}T00:00:00.000Z`)).length * activeStores.length;
    this.repository.updateRun(runId, { state: "running", startedAtMs: Date.now(), error: null });
    let completedDays = 0;
    let failedDays = 0;
    await Promise.all(activeStores.map(async (store) => {
      try {
          await this.syncStore(store.id, new Date(`${input.from}T00:00:00.000Z`), new Date(`${input.to}T00:00:00.000Z`), input.mode === "rebuild", () => {
          completedDays += 1;
          this.repository.updateRun(runId, { completedDays });
        });
      } catch {
        failedDays += dateRange(new Date(`${input.from}T00:00:00.000Z`), new Date(`${input.to}T00:00:00.000Z`)).length;
        this.repository.updateRun(runId, { failedDays });
      }
    }));
    this.repository.updateRun(runId, { state: failedDays > 0 ? "failed" : "completed", completedDays, failedDays, finishedAtMs: Date.now(), error: failedDays > 0 ? "部分店铺或日期同步失败，请查看店铺连接和异常记录" : null });
    if (totalDays === 0) this.repository.updateRun(runId, { state: "completed", finishedAtMs: Date.now() });
  }

  private async syncStore(storeId: string, from: Date, to: Date, force: boolean, onDayComplete?: () => void): Promise<void> {
    if (this.activeStores.has(storeId)) return;
    const store = await this.stores.findById(storeId);
    if (!store || !store.enabled || store.platform !== "ozon") return;
    this.activeStores.add(storeId);
    try {
      const client = this.createClient(store);
      const typeNames = await this.syncTypes(client, storeId).catch(() => this.repository.getAccrualTypeNames(storeId));
      await this.syncPostings(client, store, from, to);
      for (const date of dateRange(from, to)) {
        await this.syncDay(client, storeId, date, typeNames, force);
        onDayComplete?.();
      }
      await this.syncCashFlow(client, storeId, from, to);
    } finally {
      this.activeStores.delete(storeId);
    }
  }

  private createClient(store: StoreRecord): OzonClient {
    return new OzonClient({ clientId: store.clientId, apiKey: decryptSecret(store.apiKeyCiphertext, this.config.ENCRYPTION_KEY), baseUrl: this.config.OZON_API_BASE_URL, fetchImplementation: this.proxySettings.createFetch() });
  }

  private async syncTypes(client: OzonClient, storeId: string): Promise<Map<string, string>> {
    const types = await client.getFinanceAccrualTypes();
    this.repository.saveAccrualTypes(storeId, types);
    return new Map(types.map((type) => [type.id, type.name]));
  }

  private async syncPostings(client: OzonClient, store: StoreRecord, from: Date, to: Date): Promise<void> {
    const sources: Array<"FBO" | "FBS"> = [];
    if (store.fulfillmentModes.includes("FBO")) sources.push("FBO");
    if (store.fulfillmentModes.includes("FBS") || store.fulfillmentModes.includes("RFBS")) sources.push("FBS");
    for (const source of sources) {
      for await (const page of client.iteratePostingPages(source, from, to)) {
        for (const posting of page.postings) {
          await this.postings.upsert(store.id, normalizePosting(posting, source));
        }
      }
    }
  }

  private async syncDay(client: OzonClient, storeId: string, date: string, typeNames: Map<string, string>, force: boolean): Promise<void> {
    const checkpoint = this.repository.findDayCheckpoint(storeId, date);
    if (!force && checkpoint?.state === "completed") return;
    let cursor = force ? "" : checkpoint?.state === "running" ? checkpoint.cursor ?? "" : "";
    let firstPage = true;
    try {
      while (true) {
        const page = await client.getFinanceAccrualByDay(date, cursor);
        const lines = page.accruals.flatMap((accrual) => normalizeAccrual(accrual, date, typeNames));
        this.repository.replaceDayLines(storeId, date, lines, firstPage);
        firstPage = false;
        this.repository.saveDayCheckpoint(storeId, date, page.lastId, page.lastId ? "running" : "completed");
        if (!page.lastId || page.accruals.length === 0 || page.lastId === cursor) break;
        cursor = page.lastId;
      }
    } catch (error) {
      this.repository.saveDayCheckpoint(storeId, date, cursor || null, "failed", error instanceof Error ? error.message : "财务日期同步失败");
      throw error;
    }
  }

  private async syncCashFlow(client: OzonClient, storeId: string, from: Date, to: Date): Promise<void> {
    try {
      const report = await client.getFinanceCashFlowStatement(from, to);
      this.repository.saveCashFlowReport(storeId, dateString(from), dateString(to), report.raw);
    } catch {
      // 现金流是店铺级校验基线，不应阻断订单财务流水同步。
    }
  }
}
