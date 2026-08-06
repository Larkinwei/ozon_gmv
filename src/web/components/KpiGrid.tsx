import { Ban, PackageCheck, ReceiptText, RussianRuble } from "lucide-react";

import type { DashboardKpis } from "../../shared/contracts";
import { formatMoneyList } from "../format";

interface KpiGridProps {
  kpis: DashboardKpis;
}

export function KpiGrid({ kpis }: KpiGridProps): React.JSX.Element {
  const cards = [
    {
      label: "下单数量",
      value: new Intl.NumberFormat("zh-CN").format(kpis.orders),
      footnote: "当前筛选区间内的发货单",
      icon: PackageCheck,
      tone: "blue",
    },
    {
      label: "下单 GMV",
      value: formatMoneyList(kpis.gmv),
      footnote: "取消金额不会静默扣除",
      icon: RussianRuble,
      tone: "cyan",
    },
    {
      label: "平均客单价",
      value: formatMoneyList(kpis.averageOrderValue),
      footnote: "GMV ÷ 下单数量",
      icon: ReceiptText,
      tone: "violet",
    },
    {
      label: "取消订单",
      value: new Intl.NumberFormat("zh-CN").format(kpis.cancelledOrders),
      footnote: formatMoneyList(kpis.cancelledGmv),
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

