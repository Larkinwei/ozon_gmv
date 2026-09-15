import { AlertTriangle, CalendarDays, CircleDollarSign, RefreshCw, Search, WalletCards, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { FinanceMoneyBreakdown, FinanceOrderDetail, FinanceOrderStatus, FinanceOrderSummary, FinanceOverview, FinanceSkuSummary, FinanceStoreSummary, FinanceSyncView, StoreView } from "../../shared/contracts";
import {
  fetchFinanceExceptions,
  fetchFinanceOrderDetail,
  fetchFinanceOrders,
  fetchFinanceOverview,
  fetchFinanceSync,
  fetchStores,
  startFinanceSync,
} from "../api";
import { formatBeijingTime, formatFinanceCurrencyName, formatFinanceMoney } from "../format";

const statusLabels: Record<FinanceOrderStatus, string> = {
  awaiting_revenue: "待同步收入",
  direct_receivable: "已产生直接回款",
  pending_adjustments: "待后续费用调整",
  stable: "财务已稳定",
  review: "需核对",
};

type FinanceFeeKey = "commission" | "logistics" | "promotion" | "returns" | "otherDirect" | "unknown";

const financeFeeDefinitions: Array<{ key: FinanceFeeKey; label: string }> = [
  { key: "commission", label: "平台佣金" },
  { key: "logistics", label: "物流费用" },
  { key: "promotion", label: "活动费用" },
  { key: "returns", label: "退货/拒收" },
  { key: "otherDirect", label: "其他订单费用" },
  { key: "unknown", label: "待确认费用" },
];

const FINANCE_QUERY_STALE_TIME = 10 * 60_000;
const FINANCE_QUERY_GC_TIME = 30 * 60_000;

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function amount(value: FinanceMoneyBreakdown, key: keyof FinanceMoneyBreakdown): string {
  return formatFinanceMoney(value[key]);
}

function settledAmount(value: FinanceMoneyBreakdown, settlementCurrency: string | null, key: keyof FinanceMoneyBreakdown): string {
  return settlementCurrency ? amount(value, key) : "—";
}

function currencyLabel(currency: string | null): string {
  return currency ? formatFinanceCurrencyName(currency) : "财务流水待同步";
}

function currencyPair(order: FinanceOrderSummary): React.JSX.Element {
  return (
    <span className="finance-currency-pair">
      <span>结算：{currencyLabel(order.settlementCurrency)}</span>
      <small>订单：{formatFinanceCurrencyName(order.orderCurrency)}</small>
    </span>
  );
}

function statusClass(status: FinanceOrderStatus): string {
  if (status === "stable" || status === "direct_receivable") return "is-success";
  if (status === "review") return "is-danger";
  return "is-warning";
}

function storeStatus(store: FinanceStoreSummary): { label: string; className: string } {
  if (store.reviewOrderCount > 0) return { label: `${store.reviewOrderCount} 条需核对`, className: "is-danger" };
  if (store.awaitingRevenueOrderCount > 0) return { label: `${store.awaitingRevenueOrderCount} 条待同步收入`, className: "is-warning" };
  if (store.pendingOrderCount > 0) return { label: `${store.pendingOrderCount} 条待调整`, className: "is-warning" };
  if (store.directReceivableOrderCount > 0) return { label: `${store.directReceivableOrderCount} 条已产生回款`, className: "is-success" };
  if (store.stableOrderCount > 0) return { label: "财务已稳定", className: "is-success" };
  return { label: "仅公共费用", className: "is-muted" };
}

function skuStatus(sku: FinanceSkuSummary): { label: string; className: string } {
  if (sku.statusCounts.review > 0) return { label: "需核对", className: "is-danger" };
  if (sku.statusCounts.awaiting_revenue > 0) return { label: "待同步收入", className: "is-warning" };
  if (sku.statusCounts.pending_adjustments > 0) return { label: "待调整", className: "is-warning" };
  if (sku.statusCounts.direct_receivable > 0) return { label: "已产生回款", className: "is-success" };
  if (sku.statusCounts.stable > 0) return { label: "已稳定", className: "is-success" };
  return { label: "—", className: "is-muted" };
}

function SyncStatus({ sync }: { sync: FinanceSyncView }): React.JSX.Element {
  if (sync.state === "idle") return <span className="finance-sync-state">尚未同步</span>;
  const progress = sync.totalDays > 0 ? `${sync.completedDays}/${sync.totalDays} 天` : sync.state === "completed" ? "已完成" : "处理中";
  return <span className={`finance-sync-state finance-sync-state--${sync.state}`}>{sync.state === "failed" ? "同步失败" : progress}</span>;
}

function BreakdownMetrics({ breakdown }: { breakdown: FinanceMoneyBreakdown }): React.JSX.Element {
  return (
    <div className="finance-breakdown-metrics">
      <div><span>成交收入</span><strong>{amount(breakdown, "sales")}</strong></div>
      {financeFeeDefinitions.map((fee) => <div key={fee.key}><span>{fee.label}</span><strong>{amount(breakdown, fee.key)}</strong></div>)}
      <div><span>订单费用合计</span><strong>{amount(breakdown, "directCosts")}</strong></div>
      <div><span>订单应回款</span><strong>{amount(breakdown, "directReceivable")}</strong></div>
      <div><span>店铺公共费用</span><strong>{amount(breakdown, "sharedCosts")}</strong></div>
    </div>
  );
}

function FinanceOrderDrawer({ detail, onClose }: { detail: FinanceOrderDetail; onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div className="finance-drawer-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="finance-drawer" role="dialog" aria-modal="true" aria-labelledby="finance-order-detail-title">
        <header className="finance-drawer-header">
          <div><p className="eyebrow">ORDER RECONCILIATION</p><h2 id="finance-order-detail-title">订单回款明细</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭订单回款明细"><X size={19} /></button>
        </header>
        <div className="finance-drawer-order-meta">
          <strong>{detail.storeName}</strong>
          <span>{detail.postingNumber}</span>
          <span>订单号 {detail.orderNumber}</span>
          <span>{currencyPair(detail)}</span>
          <span className={`finance-status ${statusClass(detail.status)}`}>{statusLabels[detail.status]}</span>
        </div>
        <div className="finance-drawer-highlight">
          <span>订单应回款</span>
          <strong>{settledAmount(detail.breakdown, detail.settlementCurrency, "directReceivable")}</strong>
          <small>发运月份 {detail.shipmentMonth ?? "待确定"} · 最后费用 {detail.lastAccrualAt ?? "—"}</small>
        </div>
        {detail.exceptionReasons.length > 0 && <p className="finance-alert finance-alert--warning"><AlertTriangle size={15} />{detail.exceptionReasons.join("；")}</p>}
        <h3>财务流水时间线</h3>
        <div className="finance-table-wrap">
          <table className="finance-table finance-detail-table">
            <thead><tr><th>发生日期</th><th>费用类别</th><th>SKU</th><th>类型</th><th>金额</th></tr></thead>
            <tbody>{detail.lines.map((line) => <tr key={line.id}><td>{line.accrualDate}</td><td>{line.categoryLabel}</td><td>{line.sku ?? "公共费用"}</td><td>{line.typeName ?? line.typeId ?? "—"}</td><td className={line.amount.amount.startsWith("-") ? "is-negative" : "is-positive"}>{formatFinanceMoney(line.amount)}</td></tr>)}</tbody>
          </table>
        </div>
      </aside>
    </div>
  );
}

function StoreSelect({ stores, value, onChange }: { stores: StoreView[]; value: string; onChange: (value: string) => void }): React.JSX.Element {
  return <label className="finance-filter-field"><span>店铺</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="all">全部 Ozon 店铺</option>{stores.filter((store) => store.platform === "ozon").map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>;
}

function SummaryCards({ overview }: { overview: FinanceOverview }): React.JSX.Element {
  return (
    <div className="finance-summary-cards">
      {overview.totalsByCurrency.map((total) => <article className="finance-summary-card" key={total.sales.currency}>
        <div className="finance-summary-card-title"><span className="finance-icon"><WalletCards size={17} /></span><span>{formatFinanceCurrencyName(total.sales.currency)}月度汇总</span></div>
        <strong>{amount(total, "directReceivable")}</strong>
        <small>订单应回款</small>
        <BreakdownMetrics breakdown={total} />
      </article>)}
      {overview.totalsByCurrency.length === 0 && <div className="finance-empty-state">当前月份还没有已归属发运月份的订单。</div>}
    </div>
  );
}

function StoreSummaryTable({ overview }: { overview: FinanceOverview }): React.JSX.Element {
  return <section className="panel finance-panel"><div className="finance-panel-heading"><div><p className="eyebrow">STORE SUMMARY</p><h2>店铺回款汇总</h2></div><span>{overview.stores.length} 个店铺 / 结算分组</span></div><div className="finance-table-wrap"><table className="finance-table finance-wide-table"><thead><tr><th>店铺</th><th>结算币种</th><th>发运订单</th><th>销售件数</th><th>SKU 数</th><th>成交收入</th>{financeFeeDefinitions.map((fee) => <th key={fee.key}>{fee.label}</th>)}<th>订单费用合计</th><th>订单应回款</th><th>店铺公共费用</th><th>状态</th></tr></thead><tbody>{overview.stores.map((store) => { const status = storeStatus(store); return <tr key={`${store.storeId}:${store.settlementCurrency ?? "unsettled"}`}><td><span className="finance-store-name"><i style={{ background: store.storeColor }} />{store.storeName}</span></td><td><span className="finance-currency-cell">{currencyLabel(store.settlementCurrency)}{store.orderCurrency && <small>订单：{formatFinanceCurrencyName(store.orderCurrency)}</small>}</span></td><td>{store.orderCount}</td><td>{store.salesQuantity}</td><td>{store.skuCount}</td><td>{settledAmount(store.breakdown, store.settlementCurrency, "sales")}</td>{financeFeeDefinitions.map((fee) => <td key={fee.key}>{settledAmount(store.breakdown, store.settlementCurrency, fee.key)}</td>)}<td>{settledAmount(store.breakdown, store.settlementCurrency, "directCosts")}</td><td className="is-emphasis">{settledAmount(store.breakdown, store.settlementCurrency, "directReceivable")}</td><td>{settledAmount(store.breakdown, store.settlementCurrency, "sharedCosts")}</td><td><span className={`finance-status ${status.className}`}>{status.label}</span></td></tr>; })}</tbody></table></div></section>;
}

function SkuSummaryTable({ overview }: { overview: FinanceOverview }): React.JSX.Element {
  return <section className="panel finance-panel"><div className="finance-panel-heading"><div><p className="eyebrow">SKU RECONCILIATION</p><h2>SKU 月度汇总</h2></div><span>后续月份费用仍归入原发运月份</span></div><div className="finance-table-wrap"><table className="finance-table finance-wide-table"><thead><tr><th>SKU</th><th>店铺</th><th>结算币种</th><th>含该 SKU 的订单数</th><th>销售件数</th><th>成交收入</th>{financeFeeDefinitions.map((fee) => <th key={fee.key}>{fee.label}</th>)}<th>订单费用合计</th><th>应回款</th><th>财务状态</th></tr></thead><tbody>{overview.skuSummaries.map((sku) => { const status = skuStatus(sku); return <tr key={`${sku.storeId}:${sku.sku}:${sku.settlementCurrency ?? "unsettled"}`}><td><code>{sku.sku}</code></td><td>{sku.storeName}</td><td><span className="finance-currency-cell">{currencyLabel(sku.settlementCurrency)}{sku.orderCurrency && <small>订单：{formatFinanceCurrencyName(sku.orderCurrency)}</small>}</span></td><td>{sku.orderCount}</td><td>{sku.quantity}</td><td>{settledAmount(sku.breakdown, sku.settlementCurrency, "sales")}</td>{financeFeeDefinitions.map((fee) => <td key={fee.key}>{settledAmount(sku.breakdown, sku.settlementCurrency, fee.key)}</td>)}<td>{settledAmount(sku.breakdown, sku.settlementCurrency, "directCosts")}</td><td className="is-emphasis">{settledAmount(sku.breakdown, sku.settlementCurrency, "directReceivable")}</td><td><span className={`finance-status ${status.className}`}>{status.label}</span></td></tr>; })}</tbody></table></div></section>;
}

function OrdersTable({ orders, onSelect }: { orders: FinanceOrderSummary[]; onSelect: (id: string) => void }): React.JSX.Element {
  return <section className="panel finance-panel"><div className="finance-panel-heading"><div><p className="eyebrow">ORDER LEDGER</p><h2>订单明细</h2></div><span>{orders.length} 条订单</span></div><div className="finance-table-wrap"><table className="finance-table finance-wide-table finance-orders-table"><thead><tr><th>店铺 / 订单</th><th>币种</th><th>发运月份</th><th>SKU</th><th>成交收入</th>{financeFeeDefinitions.map((fee) => <th key={fee.key}>{fee.label}</th>)}<th>订单费用合计</th><th>应回款</th><th>最后发生</th><th>状态</th><th>操作</th></tr></thead><tbody>{orders.map((order) => <tr key={order.postingId}><td><strong>{order.storeName}</strong><small>{order.postingNumber}</small></td><td>{currencyPair(order)}</td><td>{order.shipmentMonth ?? "待确定"}</td><td>{order.items.map((item) => `${item.sku} × ${item.quantity}`).join("、") || "—"}</td><td>{settledAmount(order.breakdown, order.settlementCurrency, "sales")}</td>{financeFeeDefinitions.map((fee) => <td key={fee.key}>{settledAmount(order.breakdown, order.settlementCurrency, fee.key)}</td>)}<td>{settledAmount(order.breakdown, order.settlementCurrency, "directCosts")}</td><td className="is-emphasis">{settledAmount(order.breakdown, order.settlementCurrency, "directReceivable")}</td><td>{order.lastAccrualAt ?? "—"}</td><td><span className={`finance-status ${statusClass(order.status)}`}>{statusLabels[order.status]}</span>{order.exceptionReasons.length > 0 && <small className="finance-status-reason">{order.exceptionReasons.join("；")}</small>}</td><td><button className="finance-detail-button" type="button" onClick={() => onSelect(order.postingId)}>查看明细</button></td></tr>)}</tbody></table>{orders.length === 0 && <div className="finance-empty-state">没有符合筛选条件的订单。</div>}</div></section>;
}

/** Presents Ozon's shipment-month financial reconciliation without exposing it to Wallboard. */
export default function FinanceAnalysisPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(currentMonth);
  const [storeId, setStoreId] = useState("all");
  const [sku, setSku] = useState("");
  const [selectedPostingId, setSelectedPostingId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores });
  const overviewQuery = useQuery({ queryKey: ["finance-overview", month, storeId], queryFn: () => fetchFinanceOverview(month, storeId), staleTime: FINANCE_QUERY_STALE_TIME, gcTime: FINANCE_QUERY_GC_TIME, refetchOnWindowFocus: false });
  const ordersQuery = useQuery({ queryKey: ["finance-orders", month, storeId, sku], queryFn: () => fetchFinanceOrders({ month, storeId, ...(sku ? { sku } : {}) }), staleTime: FINANCE_QUERY_STALE_TIME, gcTime: FINANCE_QUERY_GC_TIME, refetchOnWindowFocus: false });
  const exceptionsQuery = useQuery({ queryKey: ["finance-exceptions", month, storeId], queryFn: () => fetchFinanceExceptions(month, storeId), staleTime: FINANCE_QUERY_STALE_TIME, gcTime: FINANCE_QUERY_GC_TIME, refetchOnWindowFocus: false });
  const detailQuery = useQuery({ queryKey: ["finance-order-detail", selectedPostingId], queryFn: () => fetchFinanceOrderDetail(selectedPostingId as string), enabled: Boolean(selectedPostingId), staleTime: FINANCE_QUERY_STALE_TIME, gcTime: FINANCE_QUERY_GC_TIME, refetchOnWindowFocus: false });
  const syncMutation = useMutation({ mutationFn: () => startFinanceSync(month, storeId), onSuccess: (run) => setRunId(run.id) });
  const syncQuery = useQuery({ queryKey: ["finance-sync", runId], queryFn: () => fetchFinanceSync(runId as string), enabled: Boolean(runId), refetchInterval: (query) => query.state.data?.state === "queued" || query.state.data?.state === "running" ? 1_000 : false });
  const sync = syncQuery.data ?? overviewQuery.data?.sync;
  const ozonStores = useMemo(() => (storesQuery.data ?? []).filter((store) => store.platform === "ozon"), [storesQuery.data]);

  function refreshFinanceQueries(): void {
    void queryClient.invalidateQueries({ queryKey: ["finance-overview"] });
    void queryClient.invalidateQueries({ queryKey: ["finance-orders"] });
    void queryClient.invalidateQueries({ queryKey: ["finance-exceptions"] });
    void queryClient.invalidateQueries({ queryKey: ["finance-order-detail"] });
  }

  useEffect(() => {
    if (syncQuery.data?.state === "completed" || syncQuery.data?.state === "failed") {
      refreshFinanceQueries();
    }
  }, [queryClient, syncQuery.data?.state]);

  const overview = overviewQuery.data;
  const orders = ordersQuery.data?.items ?? [];
  const exceptions = exceptionsQuery.data ?? [];
  const orderCount = overview?.stores.reduce((sum, store) => sum + store.orderCount, 0) ?? orders.length;
  const salesQuantity = overview?.stores.reduce((sum, store) => sum + store.salesQuantity, 0) ?? 0;
  const unsettledCount = overview?.stores.reduce((sum, store) => sum + store.awaitingRevenueOrderCount + store.pendingOrderCount + store.reviewOrderCount, 0) ?? 0;
  const reviewAmount = overview?.totalsByCurrency.map((total) => formatFinanceMoney(total.unknownAmount)).join(" · ") || "—";

  return (
    <main className="admin-main finance-analysis-main">
      <header className="finance-page-header">
        <div><p className="eyebrow">FINANCE ANALYSIS / OZON</p><h1>订单回款</h1><p>按发运月份重组 Ozon 订单收入与后续费用，快速定位应回款和对账异常。</p></div>
        <div className="finance-page-actions"><button className="secondary-button" type="button" onClick={refreshFinanceQueries}><RefreshCw size={16} />刷新数据</button><button className="primary-button" type="button" disabled={syncMutation.isPending || sync?.state === "queued" || sync?.state === "running"} onClick={() => syncMutation.mutate()}><RefreshCw size={16} />{syncMutation.isPending ? "创建任务…" : "按月重算"}</button></div>
      </header>
      <section className="panel finance-filter-panel" aria-label="订单回款筛选">
        <label className="finance-filter-field"><span><CalendarDays size={14} />发运月份</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        <StoreSelect stores={ozonStores} value={storeId} onChange={setStoreId} />
        <label className="finance-filter-field finance-filter-field--search"><span><Search size={14} />SKU 搜索</span><input value={sku} onChange={(event) => setSku(event.target.value)} placeholder="输入 SKU" /></label>
        {sync && <div className="finance-sync-summary"><span>最近任务</span><SyncStatus sync={sync} />{sync.finishedAt && <small>{formatBeijingTime(sync.finishedAt, "MM-dd HH:mm")}</small>}</div>}
      </section>
      {overviewQuery.isLoading && <div className="finance-loading" aria-busy="true">正在加载订单回款数据…</div>}
      {overviewQuery.error && <section className="panel finance-alert finance-alert--danger"><AlertTriangle size={18} /><span>{overviewQuery.error instanceof Error ? overviewQuery.error.message : "订单回款数据加载失败"}</span><button className="secondary-button" type="button" onClick={() => void overviewQuery.refetch()}>重试</button></section>}
      {overview && <>
        <section className="finance-stat-strip"><div><span>发运订单数</span><strong>{orderCount}</strong></div><div><span>销售件数</span><strong>{salesQuantity}</strong></div><div><span>结算币种</span><strong>{overview.totalsByCurrency.length}</strong></div><div><span>财务未稳定订单</span><strong>{unsettledCount}</strong></div><div><span>待确认费用金额</span><strong className="finance-stat-multi-currency">{reviewAmount}</strong></div></section>
        <SummaryCards overview={overview} />
        <StoreSummaryTable overview={overview} />
        <SkuSummaryTable overview={overview} />
        <OrdersTable orders={orders} onSelect={setSelectedPostingId} />
        <section className="finance-bottom-grid"><article className="panel finance-panel finance-public-costs"><div className="finance-panel-heading"><div><p className="eyebrow">SHARED COSTS</p><h2>店铺公共费用</h2></div><CircleDollarSign size={18} /></div>{overview.stores.filter((store) => store.settlementCurrency).map((store) => <div className="finance-public-cost-row" key={`${store.storeId}:${store.settlementCurrency}`}><span>{store.storeName} · {currencyLabel(store.settlementCurrency)}</span><strong>{settledAmount(store.breakdown, store.settlementCurrency, "sharedCosts")}</strong></div>)}<p className="finance-panel-note">没有订单号或 SKU 的 NON_ITEM 流水不会被强行分摊到订单。</p></article><article className="panel finance-panel"><div className="finance-panel-heading"><div><p className="eyebrow">EXCEPTIONS</p><h2>财务异常</h2></div><span>{exceptions.length} 条</span></div>{exceptions.length === 0 ? <p className="finance-empty-state">当前月份没有待处理异常。</p> : <div className="finance-exception-list">{exceptions.map((exception) => <div key={exception.id}><AlertTriangle size={15} /><div><strong>{exception.reason}</strong><small>{exception.storeName} · {exception.postingNumber ?? "无订单号"} · {exception.accrualDate}</small></div><b>{formatFinanceMoney(exception.amount)}</b></div>)}</div>}</article></section>
      </>}
      {syncMutation.error && <p className="inline-error" role="alert">{syncMutation.error instanceof Error ? syncMutation.error.message : "同步任务创建失败"}</p>}
      {detailQuery.isLoading && <div className="finance-loading">正在加载订单明细…</div>}
      {detailQuery.data && <FinanceOrderDrawer detail={detailQuery.data} onClose={() => setSelectedPostingId(null)} />}
    </main>
  );
}
