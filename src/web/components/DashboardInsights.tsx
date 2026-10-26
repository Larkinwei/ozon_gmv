import { AlertTriangle, Clock3, Package, Timer } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { DashboardHourlyOrders, DashboardOrderStatus, DashboardOrderStatusCount, DashboardOverdueShipments, DashboardTopProduct } from "../../shared/contracts";
import { formatMoneyList } from "../format";

interface DashboardInsightsProps {
  orderStatuses: DashboardOrderStatusCount[];
  hourlyOrders: DashboardHourlyOrders[];
  topProducts: DashboardTopProduct[];
  overdueShipments: DashboardOverdueShipments;
  range: string;
}

const statusPresentation: Record<DashboardOrderStatus, { label: string; color: string }> = {
  awaiting_shipment: { label: "待发货", color: "#F59E0B" },
  in_transit: { label: "运输中", color: "#3B82F6" },
  delivered: { label: "已送达", color: "#22C55E" },
  cancelled: { label: "已取消", color: "#F87171" },
  other: { label: "其他状态", color: "#94A3B8" },
};

const statusOrder: DashboardOrderStatus[] = ["awaiting_shipment", "in_transit", "delivered", "cancelled", "other"];

function StatusDistribution({ orderStatuses, overdueShipments }: Pick<DashboardInsightsProps, "orderStatuses" | "overdueShipments">): React.JSX.Element {
  const counts = new Map(orderStatuses.map((entry) => [entry.status, entry.count]));
  const data = statusOrder.map((status) => ({
    status,
    name: statusPresentation[status].label,
    value: counts.get(status) ?? 0,
    color: statusPresentation[status].color,
  }));
  const total = data.reduce((sum, item) => sum + item.value, 0);

  return (
    <section className="panel insight-panel" aria-labelledby="status-distribution-title">
      <div className="panel-heading">
        <div><p className="eyebrow">ORDER STATUS</p><h2 id="status-distribution-title">订单状态分布</h2></div>
        <span className="panel-count">区间内 {total} 单</span>
      </div>
      <div className="status-insight-content">
        <div className="status-donut" role="img" aria-label={`订单状态分布，共 ${total} 单`}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart accessibilityLayer>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius="65%" outerRadius="92%" stroke="none" isAnimationActive={false}>
                {data.map((entry) => <Cell key={entry.status} fill={entry.color} />)}
              </Pie>
              <Tooltip formatter={(value) => [`${value ?? 0} 单`, "订单"]} />
            </PieChart>
          </ResponsiveContainer>
          <span className="status-donut-total"><strong>{total}</strong><small>订单</small></span>
        </div>
        <ul className="status-legend" aria-label="各订单状态数量">
          {data.map((entry) => (
            <li key={entry.status}>
              <span className="status-legend-label"><i style={{ background: entry.color }} aria-hidden="true" />{entry.name}</span>
              <strong>{entry.value} 单</strong>
            </li>
          ))}
        </ul>
      </div>
      <div className={`overdue-alert${overdueShipments.count > 0 ? " is-warning" : ""}`} role={overdueShipments.count > 0 ? "status" : undefined}>
        {overdueShipments.count > 0 ? <AlertTriangle size={17} aria-hidden="true" /> : <Timer size={17} aria-hidden="true" />}
        <span>{overdueShipments.count > 0
          ? `${overdueShipments.count} 笔 FBS/rFBS 订单超过 ${overdueShipments.thresholdHours} 小时仍待发货`
          : `当前没有超过 ${overdueShipments.thresholdHours} 小时的 FBS/rFBS 待发货订单`}</span>
      </div>
    </section>
  );
}

function HourlyDistribution({ hourlyOrders, range }: Pick<DashboardInsightsProps, "hourlyOrders" | "range">): React.JSX.Element {
  const total = hourlyOrders.reduce((sum, entry) => sum + entry.orders, 0);
  const peak = hourlyOrders.reduce<DashboardHourlyOrders | null>((highest, entry) => entry.orders > (highest?.orders ?? 0) ? entry : highest, null);
  const isToday = range === "today";
  return (
    <section className="panel insight-panel" aria-labelledby="hourly-distribution-title">
      <div className="panel-heading">
        <div><p className="eyebrow">TODAY BY HOUR</p><h2 id="hourly-distribution-title">今日时段分布</h2></div>
        <span className="panel-count">{total} 单</span>
      </div>
      {isToday ? (
        <>
          <div className="hourly-chart" role="img" aria-label={`今日每小时订单量，共 ${total} 单`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyOrders} margin={{ top: 8, right: 4, bottom: 0, left: -18 }} accessibilityLayer>
                <CartesianGrid stroke="var(--border-soft)" strokeDasharray="3 4" vertical={false} />
                <XAxis dataKey="hour" tickFormatter={(hour: number) => `${hour}`} interval={3} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis allowDecimals={false} width={34} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} />
                <Tooltip labelFormatter={(hour) => `${hour}:00–${Number(hour) + 1}:00`} formatter={(value) => [`${value ?? 0} 单`, "订单"]} />
                <Bar dataKey="orders" name="订单数" fill="var(--primary)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="insight-summary"><Clock3 size={14} aria-hidden="true" />{peak && peak.orders > 0 ? `高峰时段 ${peak.hour}:00–${peak.hour + 1}:00 · ${peak.orders} 单` : "今日暂未收到订单"}</p>
        </>
      ) : (
        <div className="insight-empty"><Clock3 size={20} aria-hidden="true" /><span>切换到“今天”查看按小时分布</span></div>
      )}
    </section>
  );
}

function TopProducts({ products }: { products: DashboardTopProduct[] }): React.JSX.Element {
  const maxQuantity = Math.max(...products.map((product) => product.quantity), 1);
  return (
    <section className="panel insight-panel" aria-labelledby="top-products-title">
      <div className="panel-heading">
        <div><p className="eyebrow">TOP SELLING PRODUCTS</p><h2 id="top-products-title">热销商品 TOP</h2></div>
        <span className="panel-count"><Package size={15} aria-hidden="true" /> {products.length} 款</span>
      </div>
      {products.length === 0 ? (
        <div className="insight-empty"><Package size={20} aria-hidden="true" /><span>当前区间暂无商品明细</span></div>
      ) : (
        <ol className="top-product-list">
          {products.slice(0, 5).map((product, index) => (
            <li key={`${product.sku}:${product.name}`}>
              <span className="top-product-rank">{String(index + 1).padStart(2, "0")}</span>
              <div className="top-product-info">
                <strong title={product.name}>{product.name || product.sku || "未命名商品"}</strong>
                <span>{product.sku || "无 SKU"} · {formatMoneyList(product.gmv)}</span>
                <span className="top-product-track" aria-hidden="true"><i style={{ width: `${Math.max((product.quantity / maxQuantity) * 100, 3)}%` }} /></span>
              </div>
              <b>{product.quantity} 件</b>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** Summarizes order state, today's rhythm, and best-selling items using the dashboard's current filters. */
export function DashboardInsights(props: DashboardInsightsProps): React.JSX.Element {
  return (
    <section className="dashboard-insights" aria-label="订单运营洞察">
      <StatusDistribution orderStatuses={props.orderStatuses} overdueShipments={props.overdueShipments} />
      <HourlyDistribution hourlyOrders={props.hourlyOrders} range={props.range} />
      <TopProducts products={props.topProducts} />
    </section>
  );
}
