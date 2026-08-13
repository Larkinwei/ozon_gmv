import {
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Filter,
  PackagePlus,
  PackageSearch,
  Search,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import type {
  SelectionCategoryPeriod,
  SelectionMarketProductRankingListItem,
  SelectionMarketQuerySort,
  SelectionMarketRankingSort,
} from "../../shared/contracts";
import {
  fetchSelectionMarketQueries,
  fetchSelectionProductRanking,
  fetchSelectionProductRankings,
} from "../api";
import { formatCompactNumber, formatMoney } from "../format";

interface CategoryContext {
  id: string;
  name: string;
  level1Name: string;
}

function percent(value: number): string {
  return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2 }).format(value);
}

function MetricPair(props: { primary: ReactNode; secondary?: ReactNode }): React.JSX.Element {
  return <div className="discovery-metric-pair"><strong>{props.primary}</strong>{props.secondary !== undefined && <small>{props.secondary}</small>}</div>;
}

export function DiscoverySourceSwitch(props: {
  value: "cloud" | "import";
  cloudLabel: string;
  importLabel: string;
  onChange: (value: "cloud" | "import") => void;
}): React.JSX.Element {
  return <div className="discovery-source-switch" aria-label="数据源切换">{(["cloud", "import"] as const).map((value) => <button type="button" className={props.value === value ? "is-active" : ""} aria-pressed={props.value === value} onClick={() => props.onChange(value)} key={value}>{value === "cloud" ? props.cloudLabel : props.importLabel}</button>)}</div>;
}

function CategoryContextBar(props: { context: CategoryContext; mode: "products" | "queries"; onMode: (mode: "products" | "queries") => void; onClear: () => void }): React.JSX.Element {
  return <div className="category-context-bar"><div><span>类目分析</span><i>/</i><span>{props.context.level1Name}</span><i>/</i><strong>{props.context.name}</strong></div><nav aria-label="类目关联数据"><button type="button" className={props.mode === "products" ? "is-active" : ""} onClick={() => props.onMode("products")}>热销商品</button><button type="button" className={props.mode === "queries" ? "is-active" : ""} onClick={() => props.onMode("queries")}>关联热搜词</button></nav><button className="icon-button" type="button" onClick={props.onClear} aria-label="退出类目详情"><X size={17} /></button></div>;
}

const productSorts: Array<{ value: SelectionMarketRankingSort; label: string }> = [
  { value: "orderedAmount", label: "下单金额" }, { value: "orderedUnits", label: "下单件数" },
  { value: "turnoverGrowth", label: "销售额增幅" }, { value: "missedSales", label: "错失销售" },
  { value: "conversionRate", label: "下单转化率" }, { value: "averagePrice", label: "平均价格" },
];

/** Displays official Ozon bestseller rankings from the shared discovery snapshot. */
export function DiscoveryProductsPanel(props: {
  category: CategoryContext | null;
  periodDays: SelectionCategoryPeriod;
  onPeriod: (period: SelectionCategoryPeriod) => void;
  onCategoryMode: (mode: "products" | "queries") => void;
  onClearCategory: () => void;
  onCandidate: (item: SelectionMarketProductRankingListItem) => void;
}): React.JSX.Element {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [minimumPrice, setMinimumPrice] = useState("");
  const [maximumPrice, setMaximumPrice] = useState("");
  const [sort, setSort] = useState<SelectionMarketRankingSort>("orderedAmount");
  const [detailId, setDetailId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["selection-product-rankings", page, props.periodDays, sort, search, minimumPrice, maximumPrice, props.category?.id],
    queryFn: () => fetchSelectionProductRankings({
      page, pageSize: 20, periodDays: props.periodDays, sort,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(minimumPrice ? { minimumPrice: Number(minimumPrice) } : {}),
      ...(maximumPrice ? { maximumPrice: Number(maximumPrice) } : {}),
      ...(props.category ? { categoryId: props.category.id } : {}),
    }),
  });
  const detail = useQuery({ queryKey: ["selection-product-ranking", detailId], queryFn: () => fetchSelectionProductRanking(detailId!), enabled: Boolean(detailId) });
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / 20));
  return <section className="discovery-ranking-panel">
    {props.category && <CategoryContextBar context={props.category} mode="products" onMode={props.onCategoryMode} onClear={props.onClearCategory} />}
    <div className="discovery-period-row"><div className="period-switch">{([7, 28] as const).map((period) => <button type="button" className={props.periodDays === period ? "is-active" : ""} onClick={() => { props.onPeriod(period); setPage(1); }} key={period}>近 {period} 天</button>)}</div><span>{props.category ? "三级类目官方 Top 50" : "Ozon 全站官方 Top 1000"}</span></div>
    <div className="market-product-toolbar discovery-toolbar"><label className="selection-search"><Search size={17} /><span className="sr-only">搜索商品</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索商品、品牌、卖家或类目" /></label><div className="selection-filter-group"><Filter size={16} /><label><span>价格从</span><input value={minimumPrice} onChange={(event) => { setMinimumPrice(event.target.value); setPage(1); }} placeholder="₽ 0" /></label><label><span>到</span><input value={maximumPrice} onChange={(event) => { setMaximumPrice(event.target.value); setPage(1); }} placeholder="₽ 5000" /></label></div><label className="selection-sort"><ArrowDownUp size={16} /><select aria-label="官方商品榜排序" value={sort} onChange={(event) => { setSort(event.target.value as SelectionMarketRankingSort); setPage(1); }}>{productSorts.map((item) => <option value={item.value} key={item.value}>{item.label}优先</option>)}</select></label></div>
    <div className="selection-score-note market-product-boundary"><PackageSearch size={17} /><p><strong>官方榜单范围，不生成综合机会分</strong><span>商品与类目优先显示 Ozon 的 zh-Hans 本地化值；品牌、卖家仍保留平台原文。全站 Top 1000、三级类目 Top 50。</span></p></div>
    {query.isLoading ? <div className="selection-table-loading">正在读取云端热销商品…</div> : query.error ? <div className="page-error"><h3>云端商品榜加载失败</h3><p>{query.error.message}</p></div> : (query.data?.items.length ?? 0) === 0 ? <div className="selection-empty"><PackageSearch size={31} /><h3>{props.category ? "该类目暂无官方商品榜" : "还没有云端热销商品"}</h3><p>请在主采集机完成一次统一市场同步，再刷新云端数据。</p></div> : <><div className="selection-table-card"><div className="table-scroll"><table className="selection-keyword-table discovery-product-table"><thead><tr><th>排名</th><th>商品信息</th><th>类目</th><th>销售表现</th><th>增幅</th><th>平均价格</th><th>下单转化</th><th>库存</th><th><span className="sr-only">操作</span></th></tr></thead><tbody>{query.data!.items.map((item) => <tr key={`${item.id}-${item.rank}`}><td className="discovery-rank"><em>#{item.rank}</em></td><td><button className="market-product-link" type="button" onClick={() => setDetailId(item.id)}><strong>{item.name}</strong><small>{item.brand || "无品牌"} · {item.seller || "未知卖家"}</small></button></td><td><MetricPair primary={item.categoryLevel3 || "未分类"} secondary={item.categoryLevel1 || "—"} /></td><td><MetricPair primary={formatMoney(item.orderedAmount)} secondary={`${item.orderedUnits.toLocaleString("zh-CN")} 件`} /></td><td><span className={`market-growth ${item.turnoverGrowth !== null && item.turnoverGrowth < 0 ? "is-negative" : ""}`}>{item.turnoverGrowth === null ? "—" : percent(item.turnoverGrowth)}</span></td><td>{formatMoney(item.averagePrice)}</td><td>{percent(item.impressionToOrderRate)}</td><td>{item.stock?.toLocaleString("zh-CN") ?? "—"}</td><td><button className="icon-button" type="button" onClick={() => props.onCandidate(item)} aria-label={`将 ${item.name} 加入候选池`}><PackagePlus size={17} /></button></td></tr>)}</tbody></table></div></div><div className="selection-pagination"><span>共 {query.data!.total.toLocaleString("zh-CN")} 条榜单记录</span><div><button className="icon-button" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="上一页"><ChevronLeft size={18} /></button><strong>{page} / {totalPages}</strong><button className="icon-button" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} aria-label="下一页"><ChevronRight size={18} /></button></div></div></>}
    {detailId && <div className="dialog-backdrop" role="presentation"><aside className="dialog discovery-detail-drawer" role="dialog" aria-modal="true" aria-label="官方热销商品详情"><div className="dialog-heading"><div><p className="eyebrow">OZON BESTSELLER</p><h2>{detail.data?.name ?? "正在读取商品详情…"}</h2></div><button className="icon-button" type="button" onClick={() => setDetailId(null)} aria-label="关闭"><X size={20} /></button></div>{detail.data && <><div className="discovery-detail-kpis"><div><span>榜单排名</span><strong>#{detail.data.rank}</strong></div><div><span>下单金额</span><strong>{formatMoney(detail.data.orderedAmount)}</strong></div><div><span>下单件数</span><strong>{detail.data.orderedUnits.toLocaleString("zh-CN")}</strong></div><div><span>库存</span><strong>{detail.data.stock?.toLocaleString("zh-CN") ?? "—"}</strong></div></div><dl className="discovery-detail-list"><div><dt>流量</dt><dd>{detail.data.impressions.toLocaleString("zh-CN")} 展示 · {detail.data.cardViews.toLocaleString("zh-CN")} 卡片浏览</dd></div><div><dt>转化</dt><dd>下单 {percent(detail.data.impressionToOrderRate)} · 搜索加购 {percent(detail.data.searchToCartRate)}</dd></div><div><dt>促销 / 广告</dt><dd>促销 {detail.data.promotionDays} 天 · 广告 {detail.data.advertisedDays} 天 · DRR {percent(detail.data.advertisingCostShare)}</dd></div><div><dt>供给</dt><dd>FBO {detail.data.fboStock?.toLocaleString("zh-CN") ?? "—"} · FBS {detail.data.fbsStock?.toLocaleString("zh-CN") ?? "—"}</dd></div></dl><div className="dialog-actions"><a className="secondary-button" href={detail.data.ozonUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开 Ozon</a><button className="primary-button" type="button" onClick={() => props.onCandidate(detail.data!)}><PackagePlus size={16} />加入候选池</button></div></>}</aside></div>}
  </section>;
}

const querySorts: Array<{ value: SelectionMarketQuerySort; label: string }> = [
  { value: "searchCount", label: "搜索热度" }, { value: "cartRate", label: "加购转化" },
  { value: "orderedUnits", label: "下单件数" }, { value: "orderRate", label: "下单转化" },
  { value: "orderedAmount", label: "GMV" }, { value: "competition", label: "竞争卖家较少" },
];

/** Displays the seven-day Ozon market-query rankings, including level-one category linkage. */
export function DiscoveryQueriesPanel(props: {
  category: CategoryContext | null;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onWordstat: () => void;
  wordstatPending: boolean;
  onCategoryMode: (mode: "products" | "queries") => void;
  onClearCategory: () => void;
}): React.JSX.Element {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [groupName, setGroupName] = useState("");
  const [sort, setSort] = useState<SelectionMarketQuerySort>("searchCount");
  const query = useQuery({
    queryKey: ["selection-market-queries", page, search, groupName, sort, props.category?.id],
    queryFn: () => fetchSelectionMarketQueries({ page, pageSize: 20, sort, ...(search.trim() ? { search: search.trim() } : {}), ...(groupName && !props.category ? { groupName } : {}), ...(props.category ? { categoryId: props.category.id } : {}) }),
  });
  const totalPages = Math.max(1, Math.ceil((query.data?.total ?? 0) / 20));
  return <section className="discovery-ranking-panel">
    {props.category && <CategoryContextBar context={props.category} mode="queries" onMode={props.onCategoryMode} onClear={props.onClearCategory} />}
    <div className="discovery-period-row"><div><strong>近 7 天</strong><small>当前账号的近 28 天接口返回 403，首版固定为 7 天。</small></div><span>{props.category ? "关联范围：所属一级类目官方请求分组" : "Ozon 全站 Top 10000"}</span></div>
    <div className="selection-toolbar discovery-toolbar"><label className="selection-search"><Search size={17} /><input aria-label="搜索云端热词" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索俄文热词" /></label>{!props.category && <label className="selection-sort"><span>请求分组</span><select value={groupName} onChange={(event) => { setGroupName(event.target.value); setPage(1); }}><option value="">全站榜单</option>{query.data?.groups.map((group) => <option value={group} key={group}>{group}</option>)}</select></label>}<label className="selection-sort"><ArrowDownUp size={16} /><select aria-label="云端热词排序" value={sort} onChange={(event) => { setSort(event.target.value as SelectionMarketQuerySort); setPage(1); }}>{querySorts.map((item) => <option value={item.value} key={item.value}>{item.label}优先</option>)}</select></label><button className="secondary-button compact-button" type="button" disabled={props.selectedIds.size === 0 || props.wordstatPending} onClick={props.onWordstat}><Sparkles size={16} />Wordstat 补强 {props.selectedIds.size > 0 && `(${props.selectedIds.size})`}</button></div>
    <div className="selection-score-note"><TrendingUp size={17} /><p><strong>俄文原始搜索词 · Ozon 官方搜索行为</strong><span>{props.category ? "热词来自俄罗斯买家的真实输入，只精确到所属一级类目请求分组；中文翻译不是 Ozon 官方字段。" : "热词保留买家输入原文，避免机器翻译改变选品含义；全站最多 10000 条，分组最多 50 条。"}</span></p></div>
    {query.isLoading ? <div className="selection-table-loading">正在读取云端热搜词…</div> : query.error ? <div className="page-error"><h3>云端热词加载失败</h3><p>{query.error.message}</p></div> : (query.data?.items.length ?? 0) === 0 ? <div className="selection-empty"><Search size={31} /><h3>{query.data?.categoryLink?.queryScope === "unavailable" ? "该类目暂无可关联热词" : "没有匹配的云端热词"}</h3><p>{props.category ? "Ozon 没有为该一级类目提供可用请求分组。" : "请完成统一市场同步或调整筛选。"}</p></div> : <><div className="selection-table-card"><div className="table-scroll"><table className="selection-keyword-table discovery-query-table"><thead><tr><th><span className="sr-only">选择</span></th><th>排名</th><th>热搜词（俄文原词）</th><th>搜索热度</th><th>加购表现</th><th>下单表现</th><th>成交表现</th><th>竞争情况</th><th>搜索质量</th><th>Wordstat</th></tr></thead><tbody>{query.data!.items.map((item) => <tr key={`${item.id}-${item.groupName}-${item.rank}`}><td><input type="checkbox" checked={props.selectedIds.has(item.id)} onChange={() => props.onToggle(item.id)} aria-label={`选择 ${item.phrase}`} /></td><td className="discovery-rank"><em>#{item.rank}</em></td><td className="discovery-query-phrase"><strong>{item.phrase}</strong><small>{item.groupName ?? "全站榜单"}</small></td><td>{formatCompactNumber(item.searchCount)}</td><td><MetricPair primary={item.searchesWithCart.toLocaleString("zh-CN")} secondary={`加购率 ${percent(item.cartRate)}`} /></td><td><MetricPair primary={item.orderedUnits.toLocaleString("zh-CN")} secondary={`下单率 ${percent(item.orderRate)}`} /></td><td><MetricPair primary={formatMoney(item.orderedAmount)} secondary={`均价 ${formatMoney(item.averagePrice)}`} /></td><td><MetricPair primary={`${item.productViews.toLocaleString("zh-CN")} 次浏览`} secondary={`${item.competingSellers.toLocaleString("zh-CN")} 个卖家`} /></td><td><MetricPair primary={`无结果 ${percent(item.noResultRate)}`} secondary={`无操作 ${percent(item.noInteractionRate)}`} /></td><td><span className={`wordstat-status wordstat-status--${item.wordstatStatus}`}>{item.wordstatStatus === "ready" ? "已完成" : item.wordstatStatus === "queued" ? "处理中" : item.wordstatStatus === "failed" ? "失败" : "未补强"}</span></td></tr>)}</tbody></table></div></div><div className="selection-pagination"><span>共 {query.data!.total.toLocaleString("zh-CN")} 条热词记录</span><div><button className="icon-button" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="上一页"><ChevronLeft size={18} /></button><strong>{page} / {totalPages}</strong><button className="icon-button" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} aria-label="下一页"><ChevronRight size={18} /></button></div></div></>}
  </section>;
}
