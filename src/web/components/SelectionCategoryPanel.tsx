import {
  ArrowDownUp,
  ChartScatter,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Filter,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  SelectionCategoryPeriod,
  SelectionCategorySort,
  SelectionDiscoverySourceSettings,
} from "../../shared/contracts";
import {
  fetchSelectionCategories,
  fetchSelectionCategoryOverview,
  fetchSelectionDiscoverySettings,
  fetchSelectionDiscoverySync,
  refreshSelectionDiscoveryFromCloud,
  startSelectionDiscoverySync,
  updateSelectionDiscoverySettings,
} from "../api";
import { formatMoney } from "../format";
import { CategoryOpportunityMap } from "./CategoryOpportunityMap";

interface CategoryNotice {
  tone: "success" | "error";
  text: string;
}

const sortOptions: Array<{ value: SelectionCategorySort; label: string }> = [
  { value: "gmv", label: "规模" },
  { value: "growth", label: "增幅" },
  { value: "averagePrice", label: "平均价格" },
  { value: "competition", label: "卖家较少" },
  { value: "concentration", label: "头部集中度较低" },
];

function percent(value: number | null): string {
  return value === null
    ? "—"
    : new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(value);
}

/** Renders read-only category analytics plus the one explicit synchronization action. */
export function SelectionCategoryPanel(props: {
  onNotice: (notice: CategoryNotice) => void;
  onOpenCategory?: (category: { id: string; name: string; level1Name: string }, period: SelectionCategoryPeriod) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const checkedCloud = useRef(false);
  const [periodDays, setPeriodDays] = useState<SelectionCategoryPeriod>(28);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SelectionCategorySort>("gmv");
  const [search, setSearch] = useState("");
  const [categoryLevel1Id, setCategoryLevel1Id] = useState("");
  const [minimumPrice, setMinimumPrice] = useState("");
  const [maximumPrice, setMaximumPrice] = useState("");
  const [minimumGmv, setMinimumGmv] = useState("");
  const [maximumGmv, setMaximumGmv] = useState("");
  const [minimumGrowth, setMinimumGrowth] = useState("");
  const [maximumGrowth, setMaximumGrowth] = useState("");
  const [maximumSellerCount, setMaximumSellerCount] = useState("");
  const [minimumBuyoutRate, setMinimumBuyoutRate] = useState("");
  const [maximumLeaderShare, setMaximumLeaderShare] = useState("");

  const filters = {
    page, pageSize: 100, periodDays, sort,
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(categoryLevel1Id ? { categoryLevel1Id } : {}),
    ...(minimumPrice ? { minimumPrice: Number(minimumPrice) } : {}),
    ...(maximumPrice ? { maximumPrice: Number(maximumPrice) } : {}),
    ...(minimumGmv ? { minimumGmv: Number(minimumGmv) } : {}),
    ...(maximumGmv ? { maximumGmv: Number(maximumGmv) } : {}),
    ...(minimumGrowth ? { minimumGrowth: Number(minimumGrowth) } : {}),
    ...(maximumGrowth ? { maximumGrowth: Number(maximumGrowth) } : {}),
    ...(maximumSellerCount ? { maximumSellerCount: Number(maximumSellerCount) } : {}),
    ...(minimumBuyoutRate ? { minimumBuyoutRate: Number(minimumBuyoutRate) } : {}),
    ...(maximumLeaderShare ? { maximumLeaderShare: Number(maximumLeaderShare) } : {}),
  };
  const pageQuery = useQuery({
    queryKey: ["selection-categories", filters],
    queryFn: () => fetchSelectionCategories(filters),
  });
  const overviewQuery = useQuery({
    queryKey: ["selection-category-overview", periodDays],
    queryFn: () => fetchSelectionCategoryOverview(periodDays),
  });
  const settingsQuery = useQuery({ queryKey: ["selection-discovery-settings"], queryFn: fetchSelectionDiscoverySettings });
  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["selection-categories"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-category-overview"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-discovery-sync"] }),
    ]);
  };
  useEffect(() => {
    const settings = settingsQuery.data;
    if (checkedCloud.current || !settings?.cloudBaseUrl || settings.collectorEnabled) {
      return;
    }
    checkedCloud.current = true;
    void refreshSelectionDiscoveryFromCloud().then(invalidate).catch(() => {
      // Offline clients intentionally retain the last verified SQLite snapshot.
    });
  }, [settingsQuery.data]);
  const totalPages = Math.max(1, Math.ceil((pageQuery.data?.total ?? 0) / 100));
  const chartData = useMemo(() => (pageQuery.data?.items ?? []).filter((item) => (
    item.gmvGrowth !== null && item.topFiveSellerShare !== null
  )).map((item) => ({
    name: item.name,
    growth: (item.gmvGrowth ?? 0) * 100,
    concentration: (item.topFiveSellerShare ?? 0) * 100,
    gmv: Number(item.gmv.amount),
    currency: item.gmv.currency,
  })), [pageQuery.data?.items]);

  function resetFilters(): void {
    setSearch(""); setCategoryLevel1Id(""); setMinimumPrice(""); setMaximumPrice("");
    setMinimumGmv(""); setMaximumGmv(""); setMinimumGrowth(""); setMaximumGrowth("");
    setMaximumSellerCount(""); setMinimumBuyoutRate(""); setMaximumLeaderShare(""); setPage(1);
  }

  const isCollector = settingsQuery.data?.collectorEnabled ?? false;
  return (
    <section className="selection-tab-panel category-analysis" role="tabpanel" aria-label="类目分析">
      <div className="category-analysis__heading">
        <div className="period-switch" aria-label="统计周期">
          {([7, 28] as const).map((period) => <button type="button" className={periodDays === period ? "is-active" : ""} aria-pressed={periodDays === period} onClick={() => { setPeriodDays(period); setPage(1); }} key={period}>近 {period} 天</button>)}
        </div>
      </div>
      <div className="selection-score-note category-risk-note"><ShieldAlert size={17} /><p><strong>Seller 后台私有接口，低频手工采集</strong><span>接口可能随 Ozon 页面升级变化；云端只包含标准化类目、商品和热词指标，不含 Cookie、请求头、店铺资料或身份信息。</span></p></div>
      <div className="category-kpi-grid" aria-label="类目快照概览">
        <article><span>一级类目</span><strong>{overviewQuery.data?.summaries.length ?? 0}</strong><small>不累加卖家与品牌数</small></article>
        <article><span>三级类目</span><strong>{overviewQuery.data?.categoryCount.toLocaleString("zh-CN") ?? "—"}</strong><small>{overviewQuery.data?.collectedAt ? new Date(overviewQuery.data.collectedAt).toLocaleString("zh-CN") : "等待首份快照"}</small></article>
        <article><span>筛选范围 GMV</span><strong>{overviewQuery.data ? formatMoney(overviewQuery.data.totalGmv) : "—"}</strong><small>可安全相加口径</small></article>
        <article><span>订购件数</span><strong>{overviewQuery.data?.totalOrderedUnits.toLocaleString("zh-CN") ?? "—"}</strong><small>当前 {periodDays} 天周期</small></article>
      </div>
      <div className="category-toolbar">
        <label className="selection-search"><Search size={17} /><span className="sr-only">搜索三级或一级类目</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索一级或三级类目" /></label>
        <label className="selection-sort"><span>一级类目</span><select value={categoryLevel1Id} onChange={(event) => { setCategoryLevel1Id(event.target.value); setPage(1); }}><option value="">全部一级类目</option>{pageQuery.data?.facets.categoryLevel1.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
        <label className="selection-sort"><ArrowDownUp size={16} /><span className="sr-only">类目排序</span><select value={sort} onChange={(event) => { setSort(event.target.value as SelectionCategorySort); setPage(1); }}>{sortOptions.map((option) => <option value={option.value} key={option.value}>{option.label}优先</option>)}</select></label>
        <details className="category-advanced-filters"><summary><Filter size={16} />高级筛选</summary><div>
          <RangeFields label="平均价格 ₽" minimum={minimumPrice} maximum={maximumPrice} onMinimum={setMinimumPrice} onMaximum={setMaximumPrice} />
          <RangeFields label="GMV ₽" minimum={minimumGmv} maximum={maximumGmv} onMinimum={setMinimumGmv} onMaximum={setMaximumGmv} />
          <RangeFields label="GMV 增幅 %" minimum={minimumGrowth} maximum={maximumGrowth} onMinimum={setMinimumGrowth} onMaximum={setMaximumGrowth} />
          <label><span>卖家数最多</span><input inputMode="numeric" value={maximumSellerCount} onChange={(event) => setMaximumSellerCount(event.target.value)} /></label>
          <label><span>买断率至少 %</span><input inputMode="decimal" value={minimumBuyoutRate} onChange={(event) => setMinimumBuyoutRate(event.target.value)} /></label>
          <label><span>前五卖家份额不高于 %</span><input inputMode="decimal" value={maximumLeaderShare} onChange={(event) => setMaximumLeaderShare(event.target.value)} /></label>
          <button className="secondary-button compact-button" type="button" onClick={resetFilters}>清除筛选</button>
        </div></details>
      </div>
      {pageQuery.isLoading ? <div className="selection-table-loading" aria-busy="true">正在读取类目快照…</div> : pageQuery.error ? <div className="page-error"><h3>类目数据加载失败</h3><p>{pageQuery.error.message}</p></div> : !pageQuery.data?.snapshotId ? <div className="selection-empty"><ChartScatter size={31} /><h3>还没有类目快照</h3><p>{isCollector ? "请前往“数据源”发起统一市场同步。" : "请前往“数据源”刷新主采集机发布的云端快照。"}</p></div> : pageQuery.data.items.length === 0 ? <div className="selection-empty"><Search size={31} /><h3>没有匹配的类目</h3><p>当前搜索或筛选条件没有结果。</p><button className="secondary-button compact-button" type="button" onClick={resetFilters}>清除筛选</button></div> : <>
        <CategoryOpportunityMap points={chartData} />
        <CategoryTable items={pageQuery.data.items} periodDays={periodDays} onOpen={props.onOpenCategory} />
        <div className="selection-pagination"><span>共 {pageQuery.data.total.toLocaleString("zh-CN")} 个三级类目</span><div><button className="icon-button" type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="上一页"><ChevronLeft size={18} /></button><strong>{page} / {totalPages}</strong><button className="icon-button" type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} aria-label="下一页"><ChevronRight size={18} /></button></div></div>
      </>}
    </section>
  );
}

function RangeFields(props: { label: string; minimum: string; maximum: string; onMinimum: (value: string) => void; onMaximum: (value: string) => void }): React.JSX.Element {
  return <div className="category-range"><span>{props.label}</span><input inputMode="decimal" value={props.minimum} onChange={(event) => props.onMinimum(event.target.value)} placeholder="最低" /><i>—</i><input inputMode="decimal" value={props.maximum} onChange={(event) => props.onMaximum(event.target.value)} placeholder="最高" /></div>;
}

function CategoryTable(props: { items: Awaited<ReturnType<typeof fetchSelectionCategories>>["items"]; periodDays: SelectionCategoryPeriod; onOpen?: ((category: { id: string; name: string; level1Name: string }, period: SelectionCategoryPeriod) => void) | undefined }): React.JSX.Element {
  return <div className="selection-table-card"><div className="table-scroll"><table className="selection-keyword-table category-table"><thead><tr><th scope="col">三级类目</th><th scope="col">一级类目</th><th scope="col">订购金额</th><th scope="col">增幅</th><th scope="col">件数</th><th scope="col">平均价格</th><th scope="col">卖家 / 品牌</th><th scope="col">买断率</th><th scope="col">前五卖家</th></tr></thead><tbody>{props.items.map((item) => <tr key={item.id}><td data-label="三级类目"><button className="category-link" type="button" onClick={() => props.onOpen?.({ id: item.id, name: item.name, level1Name: item.categoryLevel1Name }, props.periodDays)}><strong>{item.name}</strong><small>ID {item.id} · 查看商品与热词</small></button></td><td data-label="一级类目">{item.categoryLevel1Name}</td><td data-label="订购金额">{formatMoney(item.gmv)}</td><td data-label="增幅"><span className={`market-growth ${item.gmvGrowth !== null && item.gmvGrowth < 0 ? "is-negative" : ""}`}>{percent(item.gmvGrowth)}</span></td><td data-label="件数">{item.orderedUnits.toLocaleString("zh-CN")}</td><td data-label="平均价格">{formatMoney(item.averagePrice)}</td><td data-label="卖家 / 品牌"><strong>{item.sellerCount?.toLocaleString("zh-CN") ?? "—"}</strong><small>{item.brandCount?.toLocaleString("zh-CN") ?? "—"} 品牌</small></td><td data-label="买断率">{percent(item.buyoutRate)}</td><td data-label="前五卖家">{percent(item.topFiveSellerShare)}</td></tr>)}</tbody></table></div></div>;
}

/** Settings card shared by the data-source tab. */
export function SelectionCategorySourceCard(props: { settings: SelectionDiscoverySourceSettings | undefined; onSaved: () => Promise<void>; onNotice: (notice: CategoryNotice) => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [collectorEnabled, setCollectorEnabled] = useState(false);
  const [opencliPath, setOpencliPath] = useState("");
  const [cloudBaseUrl, setCloudBaseUrl] = useState("");
  const [uploadToken, setUploadToken] = useState("");
  const syncQuery = useQuery({
    queryKey: ["selection-discovery-sync"],
    queryFn: fetchSelectionDiscoverySync,
    refetchInterval: (query) => query.state.data?.status === "running" ? 1_000 : false,
  });
  useEffect(() => {
    if (props.settings) {
      setCollectorEnabled(props.settings.collectorEnabled);
      setOpencliPath(props.settings.opencliPath);
      setCloudBaseUrl(props.settings.cloudBaseUrl ?? "");
    }
  }, [props.settings]);
  const mutation = useMutation({
    mutationFn: () => updateSelectionDiscoverySettings({
      collectorEnabled,
      opencliPath: opencliPath.trim(),
      cloudBaseUrl: cloudBaseUrl.trim() || null,
      ...(uploadToken.trim() ? { uploadToken: uploadToken.trim() } : {}),
    }),
    onSuccess: async () => { setUploadToken(""); props.onNotice({ tone: "success", text: "市场数据源设置已保存。" }); await props.onSaved(); },
    onError: (error) => props.onNotice({ tone: "error", text: error.message }),
  });
  const invalidateMarketData = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["selection-discovery-sync"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-categories"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-category-overview"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-product-rankings"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-market-queries"] }),
      queryClient.invalidateQueries({ queryKey: ["selection-overview"] }),
    ]);
  };
  const syncMutation = useMutation({
    mutationFn: startSelectionDiscoverySync,
    onSuccess: async () => { props.onNotice({ tone: "success", text: "统一市场同步已启动，将依次采集类目、商品和热词。" }); await invalidateMarketData(); },
    onError: (error) => props.onNotice({ tone: "error", text: error.message }),
  });
  const refreshMutation = useMutation({
    mutationFn: refreshSelectionDiscoveryFromCloud,
    onSuccess: async () => { props.onNotice({ tone: "success", text: "已更新到云端最新市场快照。" }); await invalidateMarketData(); },
    onError: (error) => props.onNotice({ tone: "error", text: error.message }),
  });
  const sync = syncQuery.data;
  const isCollector = props.settings?.collectorEnabled ?? false;
  const actionPending = syncMutation.isPending || refreshMutation.isPending || sync?.status === "running";
  return <article className="source-card source-card--categories"><div className="source-card__heading"><div className="source-icon source-icon--cyan"><ChartScatter size={20} /></div><div><p className="eyebrow">OZON MARKET CLOUD</p><h3>统一市场采集与云端快照</h3><p>同步类目、热销商品和热搜词；其他设备只读同一份云端快照。</p></div><span className={`source-state ${props.settings?.cloudBaseUrl ? "is-ready" : ""}`}>{isCollector ? "主采集机" : props.settings?.cloudBaseUrl ? "只读客户端" : "待配置"}</span></div><section className="discovery-source-control" aria-label="统一市场同步"><div><strong>{isCollector ? "从 Ozon Seller 同步全部市场数据" : "读取主采集机发布的市场快照"}</strong><small>{isCollector ? `批量读取类目、热销商品和热搜词，预计 ${props.settings?.estimatedDurationMinutes.join("～") ?? "8～15"} 分钟；遇到 429 会自动降速。` : "断网时继续使用本机最后一次成功缓存。"}</small></div><button className="primary-button" type="button" disabled={!props.settings || actionPending || (!isCollector && !props.settings.cloudBaseUrl)} onClick={() => isCollector ? syncMutation.mutate() : refreshMutation.mutate()}>{isCollector ? <RefreshCw size={16} className={actionPending ? "is-spinning" : ""} /> : <CloudDownload size={16} />}{actionPending ? "正在同步…" : isCollector ? "一键同步全部市场数据" : "刷新云端数据"}</button></section>{sync?.status === "running" && <div className="category-sync-progress" role="status" aria-live="polite"><div><span style={{ width: `${sync.totalSteps > 0 ? (sync.completedSteps / sync.totalSteps) * 100 : 0}%` }} /></div><p>{sync.currentItem ?? "正在读取一级类目…"}<strong>{sync.completedSteps} / {sync.totalSteps || "—"}</strong></p></div>}{sync?.status === "failed" && <div className="page-error category-sync-error"><h3>上次市场同步未完成</h3><p>{sync.error}</p><small>成功分页已保留，点击同步会从断点继续。</small></div>}<form className="category-source-form" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><label className="category-collector-toggle"><input type="checkbox" checked={collectorEnabled} onChange={(event) => setCollectorEnabled(event.target.checked)} /><span><strong>将当前设备设为主采集机</strong><small>不要在多台设备同时开启采集。</small></span></label><label className="field"><span>OpenCLI 可执行文件</span><input value={opencliPath} onChange={(event) => setOpencliPath(event.target.value)} required={collectorEnabled} disabled={!collectorEnabled} /></label><label className="field"><span>市场快照云端服务地址</span><input type="url" value={cloudBaseUrl} onChange={(event) => setCloudBaseUrl(event.target.value)} placeholder="https://market-data.example.com" /></label><label className="field"><span>上传 Bearer 密钥</span><input type="password" autoComplete="new-password" value={uploadToken} onChange={(event) => setUploadToken(event.target.value)} disabled={!collectorEnabled} placeholder={props.settings?.hasUploadToken ? "已加密保存；留空保持现有密钥" : "仅主采集机填写"} /><small>AES-256-GCM 加密保存，接口永不返回明文。</small></label><button className="secondary-button" type="submit" disabled={mutation.isPending}>{mutation.isPending ? "正在保存…" : "保存市场数据源设置"}</button></form></article>;
}
