import { CirclePause, CirclePlay, PackageOpen } from "lucide-react";

import type { RecentOrder } from "../../shared/contracts";
import { formatBeijingTime, formatMoney } from "../format";

interface LiveOrdersProps {
  orders: RecentOrder[];
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  onOrderSelect: (id: string) => void;
}

export function LiveOrders({ orders, paused, onPausedChange, onOrderSelect }: LiveOrdersProps): React.JSX.Element {
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
              <button
                className={order.cancelled ? "order-row is-cancelled" : "order-row"}
                key={order.id}
                type="button"
                onClick={() => onOrderSelect(order.id)}
                aria-label={`查看订单 ${order.postingNumber} 详情`}
              >
                <div className="order-row__top">
                  <span className="store-chip" style={{ "--store-color": order.storeColor } as React.CSSProperties}>
                    <span className="store-dot" aria-hidden="true" />
                    {order.storeName}
                  </span>
                  <strong>{formatMoney(order.amount)}</strong>
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
                  <span>{order.fulfillment}</span>
                  <span>{order.itemCount} 件商品</span>
                </div>
                <div className="order-row__number">
                  <span>#{order.postingNumber}</span>
                  {order.cancelled && <span className="danger-label">已取消</span>}
                </div>
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}
