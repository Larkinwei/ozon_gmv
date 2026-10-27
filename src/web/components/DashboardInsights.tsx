import { Clock3, ImageOff, Package } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { DashboardDailyOrders, DashboardHourlyOrders, DashboardOrderStatus, DashboardOrderStatusCount, DashboardStatusRange, DashboardTopProduct } from "../../shared/contracts";
import { formatDashboardMoneyList } from "../format";
import { OrderImagePreview } from "./OrderImagePreview";

interface DashboardInsightsProps {
  orderStatuses: DashboardOrderStatusCount[];
  hourlyOrders: DashboardHourlyOrders[];
  dailyOrders: DashboardDailyOrders[];
  timeDistributionMode: "hourly" | "daily";
  topProducts: DashboardTopProduct[];
  statusRange: DashboardStatusRange;
}

const statusPresentation: Record<DashboardOrderStatus, { label: string; color: string }> = {
  awaiting_shipment: { label: "待发货", color: "#F59E0B" },
  in_transit: { label: "运输中", color: "#3B82F6" },
  delivered: { label: "已签收", color: "#22C55E" },
  cancelled: { label: "已取消", color: "#F87171" },
  other: { label: "其他状态", color: "#94A3B8" },
};

const statusOrder: DashboardOrderStatus[] = ["awaiting_shipment", "in_transit", "delivered", "cancelled", "other"];

function StatusDistribution({ orderStatuses, statusRange }: Pick<DashboardInsightsProps, "orderStatuses" | "statusRange">): React.JSX.Element {
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
        <span className="panel-count">{statusRange.label} · {total} 单</span>
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
    </section>
  );
}

function HourlyDistribution({ hourlyOrders, dailyOrders, timeDistributionMode }: Pick<DashboardInsightsProps, "hourlyOrders" | "dailyOrders" | "timeDistributionMode">): React.JSX.Element {
  const isHourly = timeDistributionMode === "hourly";
  const total = isHourly
    ? hourlyOrders.reduce((sum, entry) => sum + entry.orders, 0)
    : dailyOrders.reduce((sum, entry) => sum + entry.orders, 0);
  const peakHour = hourlyOrders.reduce<DashboardHourlyOrders | null>((highest, entry) => entry.orders > (highest?.orders ?? 0) ? entry : highest, null);
  const peakDay = dailyOrders.reduce<DashboardDailyOrders | null>((highest, entry) => entry.orders > (highest?.orders ?? 0) ? entry : highest, null);
  return (
    <section className="panel insight-panel" aria-labelledby="hourly-distribution-title">
      <div className="panel-heading">
        <div><p className="eyebrow">ORDER TIME DISTRIBUTION</p><h2 id="hourly-distribution-title">{isHourly ? "今日每小时订单" : "每日订单量"}</h2></div>
        <span className="panel-count">{isHourly ? `${total} 单` : `${dailyOrders.length} 天 · ${total} 单`}</span>
      </div>
      {isHourly ? (
        <>
          <div className="hourly-chart" role="img" aria-label={`所选单日每小时订单量，共 ${total} 单`}>
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
          <p className="insight-summary"><Clock3 size={14} aria-hidden="true" />{peakHour && peakHour.orders > 0 ? `高峰时段 ${peakHour.hour}:00–${peakHour.hour + 1}:00 · ${peakHour.orders} 单` : "所选日期暂未收到订单"}</p>
        </>
      ) : (
        <div className="hourly-chart daily-orders-chart" role="img" aria-label={`所选区间每天订单量，共 ${total} 单`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dailyOrders} margin={{ top: 8, right: 4, bottom: 0, left: -18 }} accessibilityLayer>
              <CartesianGrid stroke="var(--border-soft)" strokeDasharray="3 4" vertical={false} />
              <XAxis dataKey="day" tickFormatter={(day: string) => day.slice(5)} interval="preserveStartEnd" minTickGap={20} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} width={34} tick={{ fill: "var(--muted)", fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip labelFormatter={(day) => `${day}`} formatter={(value) => [`${value ?? 0} 单`, "当天订单"]} />
              <Bar dataKey="orders" name="当天订单" fill="var(--cyan)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {!isHourly && <p className="insight-summary"><Clock3 size={14} aria-hidden="true" />{peakDay && peakDay.orders > 0 ? `单量最高 ${peakDay.day} · ${peakDay.orders} 单` : "所选区间暂未收到订单"}</p>}
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
          {products.map((product, index) => (
            <li key={`${product.sku}:${product.name}`}>
              <span className="top-product-rank">{String(index + 1).padStart(2, "0")}</span>
              {product.imageUrl ? <OrderImagePreview src={product.imageUrl} alt={`${product.name || product.sku} 主图`} fallbackLabel="暂无商品主图" width={42} height={42} className="top-product-image__img" placeholderClassName="top-product-image" /> : <span className="top-product-image"><ImageOff size={17} aria-label="暂无商品主图" /></span>}
              <div className="top-product-info">
                <strong title={product.name}>{product.name || product.sku || "未命名商品"}</strong>
                <span>SKU {product.sku || "—"} · {formatDashboardMoneyList(product.gmv)}</span>
                <div className="top-product-offers" title={product.offerIds.join("、")}>
                  <span>货号 {product.offerIds.length > 0 ? product.offerIds[0] : "—"}</span>
                  {product.offerIds.length > 1 && <details><summary>查看其余 {product.offerIds.length - 1} 个</summary><span>{product.offerIds.slice(1).join("、")}</span></details>}
                </div>
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
      <StatusDistribution orderStatuses={props.orderStatuses} statusRange={props.statusRange} />
      <HourlyDistribution hourlyOrders={props.hourlyOrders} dailyOrders={props.dailyOrders} timeDistributionMode={props.timeDistributionMode} />
      <TopProducts products={props.topProducts} />
    </section>
  );
}
