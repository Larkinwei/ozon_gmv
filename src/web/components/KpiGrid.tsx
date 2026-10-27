import { Ban, PackageCheck, ReceiptText, RussianRuble } from "lucide-react";

import type { DashboardComparison, DashboardKpis } from "../../shared/contracts";
import { dashboardCurrencySymbol, formatDashboardMoneyList } from "../format";

interface KpiGridProps {
  kpis: DashboardKpis;
  comparison: DashboardComparison;
}

function percentChange(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? "新增" : "持平";
  const change = ((current - previous) / previous) * 100;
  const direction = change > 0 ? "↑" : change < 0 ? "↓" : "→";
  return `${direction} ${Math.abs(change).toFixed(1)}%`;
}

function gmvComparison(kpis: DashboardKpis, comparison: DashboardComparison): string {
  const rows = kpis.gmv.flatMap((current) => {
    const previous = comparison.previousGmv.find((item) => item.currency === current.currency);
    if (!previous) return [];
    const currentAmount = Number(current.amount);
    const previousAmount = Number(previous.amount);
    return [`${dashboardCurrencySymbol(current.currency)} ${percentChange(currentAmount, previousAmount)}`];
  });
  return rows.length > 0 ? `${comparison.label} · ${rows.join(" / ")}` : `${comparison.label} · 暂无可比数据`;
}

export function KpiGrid({ kpis, comparison }: KpiGridProps): React.JSX.Element {
  const cards = [
    {
      label: "下单数量",
      value: new Intl.NumberFormat("zh-CN").format(kpis.orders),
      footnote: `${comparison.label} · ${percentChange(kpis.orders, comparison.previousOrders)}`,
      icon: PackageCheck,
      tone: "blue",
    },
    {
      label: "下单 GMV",
      value: formatDashboardMoneyList(kpis.gmv),
      footnote: gmvComparison(kpis, comparison),
      icon: RussianRuble,
      tone: "cyan",
    },
    {
      label: "平均客单价",
      value: formatDashboardMoneyList(kpis.averageOrderValue),
      footnote: "GMV ÷ 下单数量",
      icon: ReceiptText,
      tone: "violet",
    },
    {
      label: "取消订单",
      value: new Intl.NumberFormat("zh-CN").format(kpis.cancelledOrders),
      footnote: formatDashboardMoneyList(kpis.cancelledGmv),
      icon: Ban,
      tone: "red",
    },
  ];

  return (
    <section className="kpi-grid" aria-label="核心指标">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <article className={`kpi-card kpi-card--${card.tone}`} key={card.label}>
            <div className="kpi-card__header">
              <span>{card.label}</span>
              <span className="kpi-icon" aria-hidden="true">
                <Icon size={20} />
              </span>
            </div>
            <strong className="kpi-value">{card.value}</strong>
            <p>{card.footnote}</p>
          </article>
        );
      })}
    </section>
  );
}

