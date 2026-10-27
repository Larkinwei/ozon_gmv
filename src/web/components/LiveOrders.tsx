import { CirclePause, CirclePlay, PackageOpen } from "lucide-react";
import { useEffect, useRef } from "react";

import type { RecentOrder } from "../../shared/contracts";
import { HIDDEN_PLACEHOLDER } from "../dashboard-privacy";
import { formatBeijingTime, formatDashboardMoney } from "../format";
import { OrderImagePreview } from "./OrderImagePreview";

interface LiveOrdersProps {
  orders: RecentOrder[];
  totalOrders: number;
  onLoadMore: () => void;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onOrderSelect: (id: string) => void;
  privacyHidden?: boolean;
}

export function LiveOrders({ orders, totalOrders, onLoadMore, paused, onPausedChange, onOrderSelect, privacyHidden = false }: LiveOrdersProps): React.JSX.Element | null {
  const loadMoreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (privacyHidden || orders.length >= totalOrders || !loadMoreRef.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) onLoadMore();
    }, { rootMargin: "120px" });
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [onLoadMore, orders.length, privacyHidden, totalOrders]);

  if (privacyHidden) return null;

  return (
    <section className="panel live-panel" aria-labelledby="live-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">LIVE ORDERS</p>
          <h2 id="live-title">实时订单流</h2>
        </div>
        <button className="secondary-button compact-button" type="button" onClick={() => onPausedChange(!paused)} aria-pressed={paused}>
          {paused ? <CirclePlay size={17} aria-hidden="true" /> : <CirclePause size={17} aria-hidden="true" />}
          {paused ? "继续" : "暂停"}
        </button>
      </div>

      {paused && <div className="feed-paused">订单流已暂停，新订单仍在后台接收</div>}
      <div className="order-feed" aria-live="polite" aria-relevant="additions">
        {orders.length === 0 ? (
          <div className="empty-state">
            <PackageOpen size={28} aria-hidden="true" />
            当前时间段还没有订单
          </div>
        ) : (
          orders.map((order) => {
            const productLabel = order.productNames.join("、") || "商品名称暂不可用";
            return (
              <article className={order.cancelled ? "order-row is-cancelled" : "order-row"} key={order.id}>
                <OrderImagePreview src={order.imageUrl} alt={`${order.productNames[0] || "商品"} 主图`} fallbackLabel="商品暂无主图" width={52} height={52} className="order-row__image" />
                <button className="order-row__details" type="button" onClick={() => onOrderSelect(order.id)} aria-label={`查看订单 ${order.postingNumber} 详情`}>
                <div className="order-row__top">
                  <span className="store-chip" style={{ "--store-color": order.storeColor } as React.CSSProperties}>
                    <span className="store-dot" aria-hidden="true" />
                    {privacyHidden ? HIDDEN_PLACEHOLDER : order.storeName}
                  </span>
                  <strong>{formatDashboardMoney(order.amount)}</strong>
                </div>
                <p
                  className="order-row__product"
                  title={productLabel}
                  aria-label={`商品：${productLabel}`}
                >
                  <span>{order.productNames[0] || productLabel}</span>
                  {order.productNames.length > 1 && <small>+{order.productNames.length - 1} 种</small>}
                </p>
                <div className="order-row__meta">
                  <span>{formatBeijingTime(order.orderAt)}</span>
                  <span>{order.platform === "wildberries" ? "WB" : "Ozon"}</span>
                  <span>{order.fulfillment}</span>
                  <span>{order.itemCount} 件商品</span>
                </div>
                <div className="order-row__number">
                  <span>#{order.postingNumber}</span>
                  {order.cancelled && <span className="danger-label">已取消</span>}
                </div>
                </button>
              </article>
            );
          })
        )}
        {totalOrders > orders.length && <div className="live-feed-sentinel" ref={loadMoreRef} aria-label="继续向下滚动加载更多订单" />}
      </div>
    </section>
  );
}
