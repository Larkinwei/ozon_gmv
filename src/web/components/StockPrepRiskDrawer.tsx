import { AlertTriangle, ShieldAlert, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { StockPrepOrder } from "../api";
import { OrderImagePreview } from "./OrderImagePreview";
import { useDialogKeyboard } from "./useDialogKeyboard";

interface StockPrepRiskDrawerProps {
  buyerPrefix: string | null;
  orders: StockPrepOrder[];
  approving: boolean;
  blacklisting: boolean;
  onClose: () => void;
  onApprove: () => void;
  onAddBlacklist: () => void;
}

const purchaseStateNames: Record<string, string> = {
  pending: "待采购",
  adding: "加购中",
  added: "已加购",
  failed: "加购失败",
  uncertain: "待核实",
  unmatched: "未匹配",
};

const ozonStatusNames: Record<string, string> = {
  awaiting_registration: "等待登记",
  awaiting_packaging: "等待打包",
  awaiting_deliver: "等待发货",
  delivering: "运输中",
  driver_pickup: "等待买家自提",
  delivered: "已送达",
  received: "已签收",
  done: "已完成",
  cancelled: "已取消",
  cancelled_by_client: "买家取消",
  cancelled_by_seller: "卖家取消",
  client_return: "买家退货",
  returned: "已退回",
};

/** Formats a fulfillment deadline while preserving overdue information. */
function deadlineLabel(timestamp: number | null | undefined): string {
  if (!timestamp) return "发货时限未知";
  const difference = timestamp - Date.now();
  const hours = Math.max(1, Math.ceil(Math.abs(difference) / 3_600_000));
  return difference < 0 ? `已逾期 ${hours} 小时` : `剩余 ${hours} 小时`;
}

/** Explains why this buyer or order cannot be selected without review. */
function riskReason(orders: StockPrepOrder[]): string {
  if (orders.some((order) => order.riskLevel === "blacklist")) return "该买家命中生效中的店铺黑名单，禁止自动加购。";
  if (Math.max(...orders.map((order) => order.currentOrderCount ?? 1)) > 1) return "同一买家存在多笔待采购订单，需要核对全部订单后决定是否放行。";
  return "同一订单购买多件，需要核对商品和数量后决定是否放行。";
}

/** Groups SKU rows back into Ozon postings for risk review. */
function groupOrders(orders: StockPrepOrder[]): Array<{ postingNumber: string; orderNumber: string; items: StockPrepOrder[] }> {
  const grouped = new Map<string, { postingNumber: string; orderNumber: string; items: StockPrepOrder[] }>();
  for (const order of orders) {
    const entry = grouped.get(order.postingNumber) ?? { postingNumber: order.postingNumber, orderNumber: order.orderNumber ?? order.postingNumber, items: [] };
    if (!entry.items.some((item) => item.offerId === order.offerId)) entry.items.push(order);
    grouped.set(order.postingNumber, entry);
  }
  return [...grouped.values()].sort((left, right) => {
    const leftDeadline = Math.min(...left.items.map((item) => item.shipmentDeadlineAt ?? Number.MAX_SAFE_INTEGER));
    const rightDeadline = Math.min(...right.items.map((item) => item.shipmentDeadlineAt ?? Number.MAX_SAFE_INTEGER));
    return leftDeadline - rightDeadline;
  });
}

/** Shows all current and historical evidence needed before releasing a risky buyer order group. */
export function StockPrepRiskDrawer(props: StockPrepRiskDrawerProps): React.JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  useDialogKeyboard(props.onClose, drawerRef, closeButtonRef);

  const currentOrders = useMemo(() => groupOrders(props.orders), [props.orders]);
  const history = props.orders[0]?.buyerHistory;
  const totalPieces = props.orders.reduce((sum, order) => sum + order.quantity, 0);
  const approved = props.orders.length > 0 && props.orders.every((order) => order.approved);
  const blacklisted = props.orders.some((order) => order.riskLevel === "blacklist");
  const canManageBuyer = Boolean(props.buyerPrefix);

  return (
    <div className="order-detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) props.onClose(); }}>
      <aside ref={drawerRef} className="order-detail-drawer stock-prep-risk-drawer" role="dialog" aria-modal="true" aria-labelledby="stock-prep-risk-detail-title">
        <header className="order-detail-heading">
          <div><p className="eyebrow">BUYER RISK DETAILS</p><h2 id="stock-prep-risk-detail-title">买家风险详情</h2></div>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={props.onClose} aria-label="关闭买家风险详情"><X size={20}/></button>
        </header>

        <div className="order-detail-content stock-prep-risk-drawer-content">
          <section className={`stock-prep-risk-drawer-alert${blacklisted ? " is-blocked" : ""}`}>
            {blacklisted ? <ShieldAlert size={22}/> : <AlertTriangle size={22}/>}<div><strong>{riskReason(props.orders)}</strong><p>本次处理范围：{currentOrders.length} 张发货单 · {props.orders.length} 个 SKU · {totalPieces} 件</p></div>
          </section>

          <section className="stock-prep-risk-drawer-section" aria-labelledby="stock-prep-buyer-summary-title">
            <div className="stock-prep-risk-drawer-title"><h3 id="stock-prep-buyer-summary-title">买家概要</h3><span>{approved ? "已人工放行" : blacklisted ? "黑名单拦截" : "待人工确认"}</span></div>
            <dl className="stock-prep-risk-drawer-metrics">
              <div><dt>买家编号</dt><dd>{props.buyerPrefix ?? "无法识别"}</dd></div>
              <div><dt>当前发货单</dt><dd>{currentOrders.length} 单</dd></div>
              <div><dt>当前 SKU</dt><dd>{props.orders.length} 个</dd></div>
              <div><dt>当前件数</dt><dd>{totalPieces} 件</dd></div>
            </dl>
          </section>

          <section className="stock-prep-risk-drawer-section" aria-labelledby="stock-prep-current-orders-title">
            <div className="stock-prep-risk-drawer-title"><h3 id="stock-prep-current-orders-title">当前待采购订单</h3><span>{currentOrders.length} 单</span></div>
            <div className="stock-prep-risk-drawer-orders">{currentOrders.map((currentOrder) => {
              const first = currentOrder.items[0]!;
              const sequence = history?.orderSequenceByPostingNumber[currentOrder.postingNumber];
              return <article key={currentOrder.postingNumber}>
                <header><div><strong>{currentOrder.postingNumber}</strong><small>Ozon 订单号：{currentOrder.orderNumber}</small></div><span>{deadlineLabel(first.shipmentDeadlineAt)}</span></header>
                <p>{sequence ? `近一年第 ${sequence} 次下单` : "下单次数待历史同步"} · {currentOrder.items.length} 个 SKU · {currentOrder.items.reduce((sum, item) => sum + item.quantity, 0)} 件</p>
                <div className="stock-prep-risk-drawer-products">{currentOrder.items.map((item) => <div key={`${item.postingNumber}-${item.offerId}`}>
                  <OrderImagePreview src={item.imageUrl} alt={`${item.offerId} 商品图`} fallbackLabel="暂无商品图" width={48} height={48} className="stock-prep-risk-drawer-image" placeholderClassName="stock-prep-risk-drawer-image is-empty"/>
                  <div><strong>{item.offerId}</strong><p>{item.productName}</p><small>{item.quantity} 件 · {purchaseStateNames[item.state] ?? item.state}</small></div>
                </div>)}</div>
              </article>;
            })}</div>
          </section>

          {history && <section className="stock-prep-risk-drawer-section" aria-labelledby="stock-prep-history-title">
            <div className="stock-prep-risk-drawer-title"><h3 id="stock-prep-history-title">近一年历史</h3><button className="secondary-button compact-button" type="button" disabled={!history.recentOrders.length} aria-expanded={historyExpanded} onClick={() => setHistoryExpanded((current) => !current)}>{historyExpanded ? "收起明细" : "查看明细"}</button></div>
            <dl className="stock-prep-risk-drawer-metrics">
              <div><dt>历史订单</dt><dd>{history.ordersInYear} 单</dd></div><div><dt>签收</dt><dd>{history.deliveredOrders} 单</dd></div>
              <div><dt>取消 / 拒收</dt><dd>{history.cancelledOrders} / {history.refusalOrders} 单</dd></div><div><dt>退货</dt><dd>{history.returnCount} 次 · {history.returnedPieces} 件</dd></div>
            </dl>
            {historyExpanded && <div className="stock-prep-risk-drawer-history">{history.recentOrders.map((historic) => <article key={historic.postingNumber}><div><strong>{historic.postingNumber}</strong><span>{new Date(historic.orderAt).toLocaleDateString("zh-CN")}</span></div><p>{ozonStatusNames[historic.status.toLowerCase()] ?? "其他状态"}{historic.cancellationInitiator ? ` · 发起方 ${historic.cancellationInitiator}` : ""}{historic.cancellationType ? ` · ${historic.cancellationType}` : ""}</p>{historic.returns.map((item, index) => <small key={`${item.type}-${index}`}>退货：{item.reason ?? item.type} · {item.status ?? "状态未知"} · {item.quantity} 件</small>)}</article>)}</div>}
          </section>}
        </div>

        <footer className="stock-prep-risk-drawer-actions">
          {!canManageBuyer && <small>发货单号无法识别买家编号，不能执行买家级操作。</small>}
          <button className="secondary-button" type="button" onClick={props.onClose}>关闭</button>
          {canManageBuyer && !blacklisted && <button className="secondary-button" type="button" disabled={props.blacklisting} onClick={props.onAddBlacklist}>{props.blacklisting ? "正在加入…" : "加入黑名单"}</button>}
          {canManageBuyer && !blacklisted && <button className="primary-button" type="button" disabled={approved || props.approving} onClick={props.onApprove}>{approved ? "已人工放行" : props.approving ? "正在放行…" : `人工放行 ${currentOrders.length} 单 · ${totalPieces} 件`}</button>}
        </footer>
      </aside>
    </div>
  );
}
