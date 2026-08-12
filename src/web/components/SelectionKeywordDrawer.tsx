import { ArrowDownRight, ArrowRight, ArrowUpRight, Plus, RefreshCw, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useRef } from "react";

import type { SelectionKeywordDetail, WordstatTrend } from "../../shared/contracts";
import { formatCompactNumber, formatMoney } from "../format";
import { useDialogKeyboard } from "./useDialogKeyboard";

interface SelectionKeywordDrawerProps {
  keyword: SelectionKeywordDetail | null;
  loading: boolean;
  refreshing: boolean;
  onClose: () => void;
  onAddCandidate: (keyword: SelectionKeywordDetail) => void;
  onRefreshWordstat: (keywordId: string) => void;
}

const trendLabels: Record<WordstatTrend, string> = { rising: "上升", stable: "稳定", falling: "下降" };

function formatRate(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(value);
}

function formatGrowth(value: number | null): string {
  if (value === null) {
    return "数据不足";
  }
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1, signDisplay: "always" }).format(value);
}

function TrendIcon({ trend }: { trend: WordstatTrend }): React.JSX.Element {
  if (trend === "rising") return <ArrowUpRight size={16} />;
  if (trend === "falling") return <ArrowDownRight size={16} />;
  return <ArrowRight size={16} />;
}

/** Shows Ozon demand and Wordstat trend as separate evidence layers. */
export function SelectionKeywordDrawer(props: SelectionKeywordDrawerProps): React.JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useDialogKeyboard(props.onClose, drawerRef, closeButtonRef);
  return (
    <div className="selection-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) props.onClose(); }}>
      <aside ref={drawerRef} className="selection-keyword-drawer" role="dialog" aria-modal="true" aria-labelledby="keyword-detail-title">
        <div className="selection-drawer-heading">
          <div><p className="eyebrow">KEYWORD EVIDENCE</p><h2 id="keyword-detail-title">关键词详情</h2></div>
          <button ref={closeButtonRef} className="icon-button" type="button" onClick={props.onClose} aria-label="关闭关键词详情"><X size={20} /></button>
        </div>
        {props.loading || !props.keyword ? <div className="selection-drawer-loading" aria-busy="true">正在读取关键词数据…</div> : (
          <div className="selection-drawer-content">
            <div className="keyword-detail-title"><span>Ozon 搜索词</span><h3>{props.keyword.phrase}</h3><small>数据日期 {props.keyword.snapshotDate}</small></div>
            <div className="keyword-detail-score">
              <div><span>批次需求分</span><strong>{props.keyword.demandScore ?? "—"}</strong></div>
              <p>{props.keyword.demandScore === null ? "本批次少于 10 条有效记录，暂不生成需求分。" : "基于同一导入批次内搜索、加购与下单指标的分位数。"}</p>
            </div>
            <dl className="keyword-metric-grid">
              <div><dt>搜索次数</dt><dd>{props.keyword.searchCount.toLocaleString("zh-CN")}</dd></div>
              <div><dt>加购转化率</dt><dd>{formatRate(props.keyword.cartRate)}</dd></div>
              <div><dt>下单转化率</dt><dd>{formatRate(props.keyword.orderRate)}</dd></div>
              <div><dt>买家平均价格</dt><dd>{props.keyword.averagePrice ? formatMoney(props.keyword.averagePrice) : "未导入"}</dd></div>
            </dl>
            <div className="selection-disclaimer"><strong>如何使用</strong><p>需求分只反映这批 Ozon 报表中的站内需求强弱，不代表销量、利润或完整选品结论。</p></div>

            <section className="wordstat-detail" aria-labelledby="wordstat-detail-heading">
              <div className="selection-section-heading"><div><p className="eyebrow">YANDEX WORDSTAT</p><h3 id="wordstat-detail-heading">俄罗斯外部需求趋势</h3></div><button className="secondary-button compact-button" type="button" onClick={() => props.onRefreshWordstat(props.keyword!.id)} disabled={props.refreshing}><RefreshCw className={props.refreshing ? "sync-spinner" : undefined} size={15} />{props.refreshing ? "提交中…" : "刷新"}</button></div>
              {!props.keyword.wordstat ? (
                <div className="wordstat-empty"><p>尚未补强该关键词。</p><button className="primary-button compact-button" type="button" onClick={() => props.onRefreshWordstat(props.keyword!.id)}>获取 Wordstat</button></div>
              ) : (
                <>
                  <div className="wordstat-summary-grid">
                    <div><span>近 30 天热度</span><strong>{formatCompactNumber(props.keyword.wordstat.totalCount30d)}</strong></div>
                    <div><span>近 3 个月增幅</span><strong>{formatGrowth(props.keyword.wordstat.growth3m)}</strong></div>
                    <div><span>同比增幅</span><strong>{formatGrowth(props.keyword.wordstat.growth12m)}</strong></div>
                    <div><span>趋势判断</span><strong className={`trend-badge trend-badge--${props.keyword.wordstat.trend}`}><TrendIcon trend={props.keyword.wordstat.trend} />{trendLabels[props.keyword.wordstat.trend]}</strong></div>
                  </div>
                  {props.keyword.wordstat.dynamics.length > 0 && (
                    <div className="wordstat-chart" aria-label="Wordstat 月度搜索趋势图">
                      <ResponsiveContainer width="100%" height={240}>
                        <LineChart data={props.keyword.wordstat.dynamics} margin={{ top: 10, right: 8, left: -14, bottom: 0 }}>
                          <CartesianGrid stroke="#1e293b" vertical={false} />
                          <XAxis dataKey="date" tickFormatter={(value: string) => value.slice(0, 7)} tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={22} />
                          <YAxis tickFormatter={(value: number) => formatCompactNumber(value)} tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                          <Tooltip labelFormatter={(value) => String(value).slice(0, 7)} formatter={(value) => [Number(value).toLocaleString("zh-CN"), "搜索热度"]} contentStyle={{ background: "#111c31", border: "1px solid #334155", borderRadius: 8 }} />
                          <Line type="monotone" dataKey="count" stroke="#22d3ee" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                        </LineChart>
                      </ResponsiveContainer>
                      <details className="chart-data-table"><summary>查看图表数据表</summary><div className="table-scroll"><table><thead><tr><th scope="col">月份</th><th scope="col">搜索热度</th></tr></thead><tbody>{props.keyword.wordstat.dynamics.map((point) => <tr key={point.date}><td>{point.date.slice(0, 7)}</td><td>{point.count.toLocaleString("zh-CN")}</td></tr>)}</tbody></table></div></details>
                    </div>
                  )}
                  <div className="related-query-grid">
                    <RelatedQueries title="热门相关搜索" items={props.keyword.wordstat.topRequests} />
                    <RelatedQueries title="关联查询" items={props.keyword.wordstat.associations} />
                  </div>
                  <p className="source-note">俄罗斯地区 225 · 全部设备 · 更新于 {new Date(props.keyword.wordstat.fetchedAt).toLocaleString("zh-CN")}</p>
                </>
              )}
            </section>
          </div>
        )}
        {props.keyword && <div className="selection-drawer-actions"><button className="primary-button" type="button" onClick={() => props.onAddCandidate(props.keyword!)}><Plus size={17} />加入候选池</button></div>}
      </aside>
    </div>
  );
}

function RelatedQueries(props: { title: string; items: Array<{ phrase: string; count: number }> }): React.JSX.Element {
  return (
    <div className="related-query-list"><h4>{props.title}</h4>{props.items.length === 0 ? <p>暂无数据</p> : <ol>{props.items.slice(0, 8).map((item) => <li key={item.phrase}><span>{item.phrase}</span><strong>{formatCompactNumber(item.count)}</strong></li>)}</ol>}</div>
  );
}
