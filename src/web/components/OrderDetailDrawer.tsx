import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PackageOpen, RefreshCw, X } from "lucide-react";

import type { OrderDetailItem } from "../../shared/contracts";
import { fetchOrderDetail } from "../api";
import { formatBeijingTime, formatMoney } from "../format";

interface OrderDetailDrawerProps {
  orderId: string;
  onClose: () => void;
}

interface ProductImageProps {
  item: OrderDetailItem;
}

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function ProductImage({ item }: ProductImageProps): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  if (!item.imageUrl || failed) {
    return (
      <span className="order-product-image is-placeholder" aria-label="商品暂无主图">
        <PackageOpen size={26} aria-hidden="true" />
      </span>
    );
  }
  return (
    <img
      className="order-product-image"
      src={item.imageUrl}
      alt={`${item.name} 主图`}
      width="80"
      height="80"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}

function DrawerSkeleton(): React.JSX.Element {
  return (
    <div className="order-detail-skeleton" aria-busy="true" aria-label="正在加载订单详情">
      <div />
      <div />
      <div />
    </div>
  );
}

export function OrderDetailDrawer({ orderId, onClose }: OrderDetailDrawerProps): React.JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const orderQuery = useQuery({
    queryKey: ["order-detail", orderId],
    queryFn: () => fetchOrderDetail(orderId),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) {
        return;
      }
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [onClose]);

  const order = orderQuery.data;
  return (
    <div className="order-detail-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside
        className="order-detail-drawer"
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="order-detail-title"
      >
        <header className="order-detail-heading">
          <div>
            <p className="eyebrow">ORDER DETAILS</p>
            <h2 id="order-detail-title">订单详情</h2>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={onClose} aria-label="关闭订单详情">
            <X size={20} aria-hidden="true" />
          </button>
        </header>

        {orderQuery.isLoading ? <DrawerSkeleton /> : orderQuery.error ? (
          <div className="order-detail-error" role="alert">
            <PackageOpen size={30} aria-hidden="true" />
            <strong>订单详情加载失败</strong>
            <p>{orderQuery.error.message}</p>
            <button className="secondary-button" type="button" onClick={() => void orderQuery.refetch()}>
              <RefreshCw size={16} aria-hidden="true" />
              重新加载
            </button>
          </div>
        ) : order ? (
          <div className="order-detail-content">
            <section className="order-detail-summary" aria-label="订单概要">
              <div className="order-detail-store">
                <span className="store-chip" style={{ "--store-color": order.storeColor } as React.CSSProperties}>
                  <span className="store-dot" aria-hidden="true" />
                  {order.storeName}
                </span>
                {order.cancelled && <span className="danger-label">已取消</span>}
              </div>
              <strong className="order-detail-amount">{formatMoney(order.amount)}</strong>
            </section>

            <dl className="order-detail-meta">
              <div><dt>发货单号</dt><dd>{order.postingNumber}</dd></div>
              <div><dt>Ozon 订单号</dt><dd>{order.orderNumber}</dd></div>
              <div><dt>下单时间</dt><dd>{formatBeijingTime(order.orderAt, "yyyy-MM-dd HH:mm:ss")}</dd></div>
              <div><dt>履约模式</dt><dd>{order.fulfillment}</dd></div>
              <div><dt>订单状态</dt><dd>{order.status}</dd></div>
              {order.substatus && <div><dt>子状态</dt><dd>{order.substatus}</dd></div>}
            </dl>

            <section className="order-detail-products" aria-labelledby="order-products-title">
              <div className="order-detail-section-title">
                <h3 id="order-products-title">商品明细</h3>
                <span>{order.items.reduce((sum, item) => sum + item.quantity, 0)} 件</span>
              </div>
              <div className="order-product-list">
                {order.items.map((item) => (
                  <article className="order-product-card" key={item.id}>
                    <ProductImage item={item} />
                    <div className="order-product-info">
                      <h4>{item.name || "商品名称暂不可用"}</h4>
                      <p>SKU：{item.sku}</p>
                      <p>Offer ID：{item.offerId || "—"}</p>
                      <div className="order-product-price">
                        <span>{formatMoney(item.unitPrice)} × {item.quantity}</span>
                        <strong>{formatMoney(item.subtotal)}</strong>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </aside>
    </div>
  );
}
