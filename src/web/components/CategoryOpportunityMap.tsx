import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { formatMoney } from "../format";

export interface CategoryOpportunityPoint {
  name: string;
  growth: number;
  concentration: number;
  gmv: number;
  currency: string;
}

function opportunityLabel(point: CategoryOpportunityPoint): string {
  if (point.growth >= 0 && point.concentration < 50) {
    return "优先关注";
  }
  if (point.growth >= 0) {
    return "增长但集中";
  }
  if (point.concentration < 50) {
    return "竞争分散";
  }
  return "谨慎进入";
}

function CategoryOpportunityTooltip(props: {
  active: boolean;
  point: CategoryOpportunityPoint | undefined;
}): React.JSX.Element | null {
  if (!props.active || !props.point) {
    return null;
  }
  const point = props.point;
  return (
    <div className="category-opportunity-tooltip">
      <strong>{point.name}</strong>
      <span>{opportunityLabel(point)}</span>
      <dl>
        <div><dt>GMV 增幅</dt><dd>{point.growth.toFixed(1)}%</dd></div>
        <div><dt>前五卖家份额</dt><dd>{point.concentration.toFixed(1)}%</dd></div>
        <div><dt>类目 GMV</dt><dd>{formatMoney({ amount: String(point.gmv), currency: point.currency })}</dd></div>
      </dl>
    </div>
  );
}

/** Explains and plots growth, seller concentration, and GMV for category screening. */
export function CategoryOpportunityMap(props: { points: CategoryOpportunityPoint[] }): React.JSX.Element {
  return (
    <article className="category-quadrant-card">
      <div className="selection-section-heading">
        <div>
          <p className="eyebrow">CATEGORY OPPORTUNITY MAP</p>
          <h3>类目机会地图</h3>
          <span>用来筛选“应该先研究哪些类目”，不是自动推荐，也不代表利润高低。</span>
        </div>
      </div>
      <div className="category-chart-guide" aria-label="图表阅读方法">
        <span><i>1</i><strong>每个圆点</strong>一个三级类目</span>
        <span><i>2</i><strong>越往上</strong>GMV 增长越快</span>
        <span><i>3</i><strong>越往左</strong>头部卖家越不集中</span>
        <span><i>4</i><strong>圆点越大</strong>类目 GMV 越高</span>
      </div>
      <div className="category-quadrant" role="img" aria-label="三级类目机会地图：横轴为前五卖家份额，纵轴为 GMV 增幅，圆点大小为 GMV">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 20, right: 28, bottom: 42, left: 30 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,.16)" />
            <XAxis
              type="number"
              dataKey="concentration"
              name="前五卖家份额"
              unit="%"
              domain={[0, 100]}
              tick={{ fill: "#8fa1bd", fontSize: 11 }}
              label={{ value: "前五卖家份额（越左越分散）", position: "insideBottom", offset: -26, fill: "#94a3b8", fontSize: 12 }}
            />
            <YAxis
              type="number"
              dataKey="growth"
              name="GMV 增幅"
              unit="%"
              domain={[(minimum: number) => Math.min(minimum, 0), (maximum: number) => Math.max(maximum, 0)]}
              tick={{ fill: "#8fa1bd", fontSize: 11 }}
              label={{ value: "GMV 增幅（越高增长越快）", angle: -90, position: "insideLeft", offset: -18, fill: "#94a3b8", fontSize: 12 }}
            />
            <ZAxis type="number" dataKey="gmv" range={[45, 900]} />
            <ReferenceLine x={50} stroke="#64748b" strokeDasharray="4 4" />
            <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={(tooltip) => <CategoryOpportunityTooltip active={tooltip.active} point={tooltip.payload?.[0]?.payload as CategoryOpportunityPoint | undefined} />}
            />
            <Scatter data={props.points} fill="#41d7e7" fillOpacity={0.72} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="category-quadrant-legend" aria-label="四个区域的含义">
        <article className="is-focus"><strong>优先关注</strong><span>高增长 · 低集中</span><small>需求增长快，头部卖家控制较弱，适合优先深入看商品、价格和利润。</small></article>
        <article><strong>增长但集中</strong><span>高增长 · 高集中</span><small>市场在增长，但头部优势强，需要评估差异化能力。</small></article>
        <article><strong>竞争分散</strong><span>低增长 · 低集中</span><small>竞争格局分散，但需求没有明显增长，可作为补充方向。</small></article>
        <article className="is-caution"><strong>谨慎进入</strong><span>低增长 · 高集中</span><small>增长偏弱且头部集中，通常不是首选研究对象。</small></article>
      </div>
    </article>
  );
}
