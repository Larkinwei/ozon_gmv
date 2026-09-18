import { CalendarDays, ChevronLeft, ChevronRight, PackageOpen, Search } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import type { OrderSearchFilters } from "../api";
import { fetchOrderSearch } from "../api";
import { OrderDetailDrawer } from "../components/OrderDetailDrawer";
import { formatBeijingTime, formatMoney } from "../format";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 20;

function localDateTimeValue(value: Date): string {
  return formatInTimeZone(value, "Asia/Shanghai", "yyyy-MM-dd'T'HH:mm");
}

function utcValue(value: string): string | undefined {
  return value ? fromZonedTime(value, "Asia/Shanghai").toISOString() : undefined;
}

function requiredUtcValue(value: string): string {
  const result = utcValue(value);
  if (!result) {
    throw new Error("时间不能为空");
  }
  return result;
}

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: localDateTimeValue(new Date(now.getTime() - 90 * DAY_MS)),
    to: localDateTimeValue(now),
  };
}

function statusLabel(status: string, cancelled: boolean): string {
  if (cancelled) return "已取消";
  const labels: Record<string, string> = {
    awaiting_packaging: "待打包",
    awaiting_deliver: "待发货",
    delivering: "配送中",
    delivered: "已送达",
    posting_created: "已创建",
    posting_canceled: "已取消",
  };
  return labels[status] ?? status;
}

function SearchProductImage({ imageUrl, productName }: { imageUrl: string | null; productName: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  if (!imageUrl || failed) {
    return <span className="order-search-image order-search-image--placeholder" aria-label="商品暂无主图"><PackageOpen size={20} aria-hidden="true" /></span>;
  }
  return <img className="order-search-image" src={imageUrl} alt={`${productName || "商品"} 主图`} width="54" height="54" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function SearchPagination({ page, pageSize, total, onPageChange }: { page: number; pageSize: number; total: number; onPageChange: (page: number) => void }): React.JSX.Element {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="order-search-pagination">
      <span>共 {total.toLocaleString("zh-CN")} 条 · 第 {page} / {pageCount} 页</span>
      <div>
        <button className="secondary-button compact-button" type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="上一页">
          <ChevronLeft size={16} aria-hidden="true" />上一页
        </button>
        <button className="secondary-button compact-button" type="button" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)} aria-label="下一页">
          下一页<ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export default function OrderSearchPage(): React.JSX.Element {
  const initialRange = defaultRange();
  const [keyword, setKeyword] = useState("");
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [filters, setFilters] = useState<OrderSearchFilters>(() => ({
    from: requiredUtcValue(initialRange.from),
    to: requiredUtcValue(initialRange.to),
    page: 1,
    pageSize: PAGE_SIZE,
  }));
  const searchQuery = useQuery({
    queryKey: ["order-search", filters],
    queryFn: () => fetchOrderSearch(filters),
    placeholderData: (previous) => previous,
    retry: false,
  });

  function submitSearch(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!from || !to) {
      setValidationError("请同时填写开始和结束时间");
      return;
    }
    const fromUtc = utcValue(from);
    const toUtc = utcValue(to);
    if (!fromUtc || !toUtc || fromUtc >= toUtc) {
      setValidationError("结束时间必须晚于开始时间");
      return;
    }
    setValidationError(null);
    setFilters({ ...(keyword.trim() ? { q: keyword.trim() } : {}), from: fromUtc, to: toUtc, page: 1, pageSize: PAGE_SIZE });
  }

  function resetSearch(): void {
    const nextRange = defaultRange();
    setKeyword("");
    setFrom(nextRange.from);
    setTo(nextRange.to);
    setValidationError(null);
    setFilters({ from: requiredUtcValue(nextRange.from), to: requiredUtcValue(nextRange.to), page: 1, pageSize: PAGE_SIZE });
  }

  const page = searchQuery.data?.page ?? filters.page ?? 1;
  return (
    <main className="admin-main order-search-main">
      <header className="order-search-header">
        <div>
          <p className="eyebrow">ORDER SEARCH / OZON</p>
          <h1>订单搜索</h1>
          <p>搜索本地已同步的 Ozon 订单，默认覆盖最近 90 天。</p>
        </div>
      </header>

      <form className="panel order-search-filter-panel" onSubmit={submitSearch}>
        <label className="order-search-field order-search-field--keyword">
          <span><Search size={14} aria-hidden="true" />关键词</span>
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="订单号、商品名称或 SKU" />
        </label>
        <div className="order-search-field order-search-field--range">
          <span><CalendarDays size={14} aria-hidden="true" />时间范围</span>
          <div className="order-search-range-controls">
            <label>
              <span className="sr-only">开始时间</span>
              <input aria-label="开始时间" type="datetime-local" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <span className="order-search-range-separator">至</span>
            <label>
              <span className="sr-only">结束时间</span>
              <input aria-label="结束时间" type="datetime-local" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </div>
        </div>
        <div className="order-search-actions">
          <button className="primary-button" type="submit"><Search size={16} aria-hidden="true" />搜索订单</button>
          <button className="secondary-button" type="button" onClick={resetSearch}>重置</button>
        </div>
      </form>
      {validationError && <p className="inline-error" role="alert">{validationError}</p>}

      <section className="panel order-search-results" aria-labelledby="order-search-results-title" aria-busy={searchQuery.isFetching}>
        <div className="order-search-results-heading">
          <div>
            <p className="eyebrow">LOCAL SYNCED ORDERS</p>
            <h2 id="order-search-results-title">搜索结果</h2>
          </div>
          {searchQuery.data && <span>{searchQuery.data.total.toLocaleString("zh-CN")} 条订单</span>}
        </div>
        {searchQuery.error ? (
          <div className="order-search-message" role="alert">
            <strong>订单搜索失败</strong>
            <p>{searchQuery.error instanceof Error ? searchQuery.error.message : "订单数据加载失败"}</p>
            <button className="secondary-button compact-button" type="button" onClick={() => void searchQuery.refetch()}>重新加载</button>
          </div>
        ) : searchQuery.isLoading ? (
          <div className="order-search-message" aria-busy="true">正在搜索订单…</div>
        ) : !searchQuery.data || searchQuery.data.items.length === 0 ? (
          <div className="order-search-message">当前条件下没有找到订单。</div>
        ) : (
          <>
            <div className="order-search-table-wrap">
              <table className="order-search-table">
                <thead>
                  <tr><th>主图</th><th>店铺</th><th>订单号</th><th>下单时间</th><th>商品 / 货号 / SKU</th><th>金额</th><th>履约 / 状态</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {searchQuery.data.items.map((order) => (
                    <tr key={order.id}>
                      <td><SearchProductImage imageUrl={order.imageUrl} productName={order.productNames[0] ?? ""} /></td>
                      <td><span className="order-search-store"><i style={{ background: order.storeColor }} />{order.storeName}</span></td>
                      <td><strong>{order.postingNumber}</strong><small>订单号 {order.orderNumber}</small></td>
                      <td>{formatBeijingTime(order.orderAt, "yyyy-MM-dd HH:mm:ss")}</td>
                      <td><span className="order-search-products">{order.productNames.join("、") || "商品名称暂不可用"}</span><small>{order.offerIds.length > 0 ? `货号：${order.offerIds.join("、")}` : ""}{order.offerIds.length > 0 && order.skus.length > 0 ? " · " : ""}{order.skus.length > 0 ? `SKU：${order.skus.join("、")}` : order.offerIds.length === 0 ? `${order.itemCount} 件商品` : ""}</small></td>
                      <td className="order-search-amount">{formatMoney(order.amount)}</td>
                      <td><span>{order.fulfillment}</span><small>{statusLabel(order.status, order.cancelled)}</small></td>
                      <td><button className="secondary-button compact-button" type="button" onClick={() => setSelectedOrderId(order.id)}>查看详情</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <SearchPagination page={page} pageSize={searchQuery.data.pageSize} total={searchQuery.data.total} onPageChange={(nextPage) => setFilters((current) => ({ ...current, page: nextPage }))} />
          </>
        )}
      </section>
      {selectedOrderId && <OrderDetailDrawer orderId={selectedOrderId} onClose={() => setSelectedOrderId(null)} />}
    </main>
  );
}
