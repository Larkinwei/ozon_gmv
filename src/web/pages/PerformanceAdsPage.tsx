import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowDownWideNarrow, CheckCircle2, LoaderCircle, Megaphone, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import {
  fetchPerformanceAdsConfig,
  fetchPerformanceAdsData,
  fetchStores,
  savePerformanceAdsConfig,
  startPerformanceAdsBackfill,
  syncPerformanceAds,
  testPerformanceAdsConfig,
  type PerformanceAdsData,
} from "../api";
import { OrderImagePreview } from "../components/OrderImagePreview";
import type { PerformanceAdsCampaign, PerformanceAdsDiagnostic, PerformanceAdsMetric, PerformanceAdsSku, PerformanceAdsTrendPoint } from "../../shared/contracts";

const LAST_STORE_KEY = "ozon-gmv:performance-ads-last-store-id";

type TrendMetric = "expense" | "sales" | "clicks" | "orders" | "drr";
type CampaignSort = "expense" | "sales" | "drr" | "ctr" | "clicks" | "orders" | "name";
type ReportSection = "overview" | "campaigns" | "skus";

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function daysBefore(date: string, count: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() - count);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

/** Returns the date a number of calendar months before the given date, clamping month-end overflow. */
function monthsBefore(date: string, monthCount: number): string {
  const value = new Date(`${date}T12:00:00`);
  const day = value.getDate();
  value.setDate(1);
  value.setMonth(value.getMonth() - monthCount);
  const lastDay = new Date(value.getFullYear(), value.getMonth() + 1, 0).getDate();
  value.setDate(Math.min(day, lastDay));
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

/** Builds inclusive report presets ending on the latest completed day. */
function reportRangePresets(): Array<{ label: string; from: string; to: string }> {
  const to = daysBefore(todayIso(), 1);
  return [
    { label: "近 7 天", from: daysBefore(to, 6), to },
    { label: "近 15 天", from: daysBefore(to, 14), to },
    { label: "近 1 个月", from: monthsBefore(to, 1), to },
    { label: "近 3 个月", from: monthsBefore(to, 3), to },
    { label: "近 6 个月", from: monthsBefore(to, 6), to },
  ];
}

function readLastStoreId(): string {
  try { return window.localStorage.getItem(LAST_STORE_KEY) ?? ""; } catch { return ""; }
}

function rememberStoreId(storeId: string): void {
  try { window.localStorage.setItem(LAST_STORE_KEY, storeId); } catch { /* Selection remains available for this session. */ }
}

function money(value: string | number): string {
  return `₽${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value ?? 0))}`;
}

function count(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value ?? 0));
}

/** Converts Ozon campaign state enums into operator-facing Chinese labels. */
function campaignStateLabel(state: string): string {
  const labels: Record<string, string> = {
    campaign_state_running: "投放中",
    campaign_state_inactive: "未启用",
    campaign_state_archived: "已归档",
    campaign_state_paused: "已暂停",
    campaign_state_ended: "已结束",
  };
  return labels[state.toLowerCase()] ?? "未知状态";
}

function reportDateRange(): { from: string; to: string } {
  const yesterday = daysBefore(todayIso(), 1);
  return { from: daysBefore(yesterday, 29), to: yesterday };
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }): React.JSX.Element {
  return <article className="performance-ads-kpi"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</article>;
}

function metricForSort(campaign: PerformanceAdsCampaign, sort: CampaignSort): number | string {
  if (sort === "name") return campaign.name.toLocaleLowerCase();
  if (sort === "drr") return campaign.drr ?? -1;
  if (sort === "expense" || sort === "sales") return Number(campaign[sort]);
  return campaign[sort];
}

function compareCampaigns(left: PerformanceAdsCampaign, right: PerformanceAdsCampaign, sort: CampaignSort): number {
  const leftValue = metricForSort(left, sort);
  const rightValue = metricForSort(right, sort);
  if (sort === "name") return String(leftValue).localeCompare(String(rightValue), "zh-CN");
  return Number(rightValue) - Number(leftValue);
}

function metricLabel(metric: TrendMetric): string {
  return ({ expense: "广告消耗", sales: "归因销售额", clicks: "点击", orders: "归因订单", drr: "DRR" })[metric];
}

function metricValue(point: PerformanceAdsTrendPoint, metric: TrendMetric): number {
  if (metric === "expense" || metric === "sales") return Number(point[metric]);
  if (metric === "drr") return point.drr ?? 0;
  return point[metric];
}

function formatTrendValue(value: number, metric: TrendMetric): string {
  if (metric === "expense" || metric === "sales") return money(value);
  if (metric === "drr") return `${value.toFixed(2)}%`;
  return count(value);
}

function skuProductLabel(row: PerformanceAdsSku): string {
  return row.product.name ?? row.sku;
}

function hasLocalProduct(row: PerformanceAdsSku): boolean {
  return Boolean(row.product.name || row.product.offerId || row.product.imageUrl);
}

function diagnosticAction(diagnostic: PerformanceAdsDiagnostic): string {
  return `查看活动：${diagnostic.campaignName}`;
}

/** Monitors read-only Ozon Performance reports for one explicitly selected store. */
export default function PerformanceAdsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const campaignTableRef = useRef<HTMLElement>(null);
  const [storeId, setStoreId] = useState(readLastStoreId);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const initialRange = useMemo(reportDateRange, []);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [campaignState, setCampaignState] = useState("");
  const [campaignSearch, setCampaignSearch] = useState("");
  const [campaignSort, setCampaignSort] = useState<CampaignSort>("expense");
  const [trendMetric, setTrendMetric] = useState<TrendMetric>("expense");
  const [message, setMessage] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [reportSection, setReportSection] = useState<ReportSection>("overview");

  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores, staleTime: 30_000 });
  const stores = (storesQuery.data ?? []).filter((store) => store.enabled && store.platform === "ozon");
  useEffect(() => {
    if (!stores.length) return;
    const previous = readLastStoreId();
    const next = stores.some((store) => store.id === storeId) ? storeId : stores.some((store) => store.id === previous) ? previous : stores[0]!.id;
    if (next !== storeId) setStoreId(next);
    rememberStoreId(next);
  }, [storeId, stores]);

  const configQuery = useQuery({
    queryKey: ["performance-ads", "config", storeId],
    queryFn: () => fetchPerformanceAdsConfig(storeId),
    enabled: Boolean(storeId),
    refetchInterval: (query) => query.state.data?.status === "syncing" ? 5_000 : false,
  });
  const dataQuery = useQuery({
    queryKey: ["performance-ads", "data", storeId, from, to, campaignState, selectedCampaignId],
    queryFn: () => fetchPerformanceAdsData(storeId, from, to, campaignState, selectedCampaignId),
    enabled: Boolean(storeId && configQuery.data?.configured),
    refetchInterval: configQuery.data?.status === "syncing" ? 5_000 : false,
  });
  const invalidate = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["performance-ads", "config", storeId] }),
      queryClient.invalidateQueries({ queryKey: ["performance-ads", "data", storeId] }),
    ]);
  };

  const connectMutation = useMutation({
    mutationFn: async (): Promise<string> => {
      const config = await savePerformanceAdsConfig(storeId, {
        ...(clientId.trim() ? { clientId } : {}),
        ...(clientSecret.trim() ? { clientSecret } : {}),
      });
      setClientSecret("");
      setClientId("");
      await testPerformanceAdsConfig(storeId);
      if (!config.initialBackfillDone) {
        const result = await startPerformanceAdsBackfill(storeId);
        return `连接成功。${result.message}；SKU 报表按 Ozon 接口允许的近期日期获取。`;
      }
      return "Performance API 连接成功。";
    },
    onSuccess: async (result) => { setMessage(result); await invalidate(); },
    onError: (error) => setMessage(error instanceof Error ? error.message : "保存或连接测试失败"),
  });
  const syncMutation = useMutation({
    mutationFn: () => syncPerformanceAds(storeId, from, to),
    onSuccess: async () => { setMessage("广告报表同步已完成。"); await invalidate(); },
    onError: (error) => setMessage(error instanceof Error ? error.message : "广告报表同步失败"),
  });

  const data = dataQuery.data;
  const totals = data?.totals;
  const campaignRows = data?.campaigns ?? [];
  const visibleCampaigns = useMemo(() => campaignRows
    .filter((row) => `${row.name} ${row.campaignId}`.toLocaleLowerCase().includes(campaignSearch.trim().toLocaleLowerCase()))
    .sort((left, right) => compareCampaigns(left, right, campaignSort)), [campaignRows, campaignSearch, campaignSort]);
  const skuRows = data?.skus ?? [];
  const selectedCampaign = campaignRows.find((row) => row.campaignId === selectedCampaignId);
  const ignoredDiagnosticCount = campaignRows.filter((row) => row.state !== "campaign_state_running").length;
  const selectedStore = stores.find((store) => store.id === storeId);
  const rangePresets = reportRangePresets();
  const saving = connectMutation.isPending;
  const syncing = syncMutation.isPending || configQuery.data?.status === "syncing";

  function chooseStore(value: string): void {
    setStoreId(value);
    rememberStoreId(value);
    setMessage("");
    setSelectedCampaignId("");
    setClientId("");
    setClientSecret("");
  }

  function chooseRange(fromValue: string, toValue: string): void {
    setFrom(fromValue);
    setTo(toValue);
    setSelectedCampaignId("");
  }

  function selectCampaign(campaignId: string): void {
    setSelectedCampaignId((current) => current === campaignId ? "" : campaignId);
  }

  function openDiagnosticCampaign(campaignId: string): void {
    setSelectedCampaignId(campaignId);
    setReportSection("campaigns");
    window.requestAnimationFrame(() => campaignTableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function clearCampaignFilter(): void {
    setSelectedCampaignId("");
  }

  return (
    <main className="admin-main performance-ads-page">
      <header className="performance-ads-header">
        <div>
          <p className="eyebrow">PERFORMANCE ADS</p>
          <h2>广告监测</h2>
          <p className="muted">读取 Ozon Performance 广告报表，分析消耗、点击和广告归因销售；不修改广告，也不并入 GMV 订单统计。</p>
        </div>
        <label className="performance-ads-store-select operations-store-select">目标店铺
          <select value={storeId} onChange={(event) => chooseStore(event.target.value)} disabled={!stores.length}>
            {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
          </select>
        </label>
      </header>

      {storesQuery.isLoading ? <section className="performance-ads-panel">正在读取店铺…</section> : !stores.length ? (
        <section className="performance-ads-panel performance-ads-empty"><AlertCircle size={20} />请先添加并启用一家 Ozon 店铺。</section>
      ) : <>
        <section className="performance-ads-panel">
          <div className="performance-ads-panel-heading"><div><p className="eyebrow">PERFORMANCE API</p><h3>店铺凭据</h3></div>
            {configQuery.data?.configured && <span className="performance-ads-configured"><ShieldCheck size={15} />已配置 {configQuery.data.clientIdMasked}</span>}
          </div>
          <p className="muted">Performance API 凭据独立于 Seller API。Secret 加密保存在本机，保存后不会再次显示。</p>
          <form className="performance-ads-credentials" onSubmit={(event) => { event.preventDefault(); setMessage(""); connectMutation.mutate(); }}>
            <label>Client ID<input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" placeholder={configQuery.data?.configured ? "已配置；留空保留原 Client ID" : "输入 Performance API Client ID"} required={!configQuery.data?.configured} /></label>
            <label>Client Secret<input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" placeholder={configQuery.data?.configured ? "已配置；留空保留原 Secret" : "输入 Performance API Client Secret"} required={!configQuery.data?.configured} /></label>
            <button className="primary-button" type="submit" disabled={saving || (!configQuery.data?.configured && (!clientId.trim() || !clientSecret.trim()))}>
              {saving ? <><LoaderCircle className="spin" size={16} />正在保存并测试…</> : <><ShieldCheck size={16} />保存并测试连接</>}
            </button>
          </form>
          {message && <p className={`performance-ads-message${/失败|error|HTTP/i.test(message) ? " is-error" : ""}`} role="status">{message}</p>}
          {configQuery.data?.lastError && <p className="performance-ads-message is-error" role="status">最近同步失败：{configQuery.data.lastError}</p>}
        </section>

        {configQuery.data?.configured && <>
          <section className="performance-ads-panel">
            <div className="performance-ads-panel-heading"><div><p className="eyebrow">REPORT RANGE</p><h3>广告报表</h3></div>
              <button type="button" className="secondary-button" disabled={syncing} onClick={() => syncMutation.mutate()}>
                {syncing ? <><LoaderCircle className="spin" size={16} />同步中</> : <><RefreshCw size={16} />刷新报表</>}
              </button>
            </div>
            <div className="performance-ads-toolbar">
              <label>开始日期<input type="date" value={from} max={to} onChange={(event) => chooseRange(event.target.value, to)} /></label>
              <label>结束日期<input type="date" value={to} min={from} max={daysBefore(todayIso(), 1)} onChange={(event) => chooseRange(from, event.target.value)} /></label>
              <div className="performance-ads-range-presets" role="group" aria-label="报表日期快捷范围">
                {rangePresets.map((preset) => {
                  const active = from === preset.from && to === preset.to;
                  return <button key={preset.label} type="button" className={active ? "is-active" : ""} aria-pressed={active} onClick={() => chooseRange(preset.from, preset.to)}>{preset.label}</button>;
                })}
              </div>
              <label>活动状态<select value={campaignState} onChange={(event) => setCampaignState(event.target.value)}><option value="">全部状态</option>{Array.from(new Set(campaignRows.map((row) => row.state))).map((state) => <option value={state} key={state}>{campaignStateLabel(state)}</option>)}</select></label>
              <span className="performance-ads-sync-state">{configQuery.data.status === "syncing" ? <><LoaderCircle className="spin" size={15} />正在同步</> : configQuery.data.lastFinishedAt ? `最近同步：${new Date(configQuery.data.lastFinishedAt).toLocaleString("zh-CN", { hour12: false })}` : "尚无同步记录"}</span>
            </div>
            {data?.skuHistoryLimited && <p className="performance-ads-note">Ozon SKU 报表接口仅允许查询近期数据；当前范围内 SKU 明细从最近可用日期开始，活动日报仍按所选日期范围查询。</p>}
            {configQuery.data.initialBackfillDone === false && <p className="performance-ads-note">首次连接后将回填近 30 天活动日报；后台每小时更新近期数据。</p>}
            {dataQuery.isLoading ? <div className="performance-ads-empty">正在读取广告报表…</div> : dataQuery.isError ? <div className="performance-ads-message is-error">{dataQuery.error instanceof Error ? dataQuery.error.message : "广告报表读取失败"}</div> : totals && <>
              <nav className="performance-ads-report-tabs" role="tablist" aria-label="广告报表内容">
                <button type="button" role="tab" aria-selected={reportSection === "overview"} className={reportSection === "overview" ? "is-active" : ""} onClick={() => setReportSection("overview")}>数据概览</button>
                <button type="button" role="tab" aria-selected={reportSection === "campaigns"} className={reportSection === "campaigns" ? "is-active" : ""} onClick={() => setReportSection("campaigns")}>广告活动 <span>{campaignRows.length}</span></button>
                <button type="button" role="tab" aria-selected={reportSection === "skus"} className={reportSection === "skus" ? "is-active" : ""} onClick={() => setReportSection("skus")}>SKU 明细 <span>{skuRows.length}</span></button>
              </nav>

              {selectedCampaignId && <div className="performance-ads-active-filter" role="status">
                <span>当前活动筛选：<strong>{selectedCampaign?.name ?? selectedCampaignId}</strong></span>
                <button type="button" className="secondary-button" onClick={clearCampaignFilter}>退出活动筛选</button>
              </div>}

              {reportSection === "overview" && <>
              <div className="performance-ads-kpis">
                <MetricCard label="广告消耗" value={money(totals.expense)} />
                <MetricCard label="曝光" value={count(totals.impressions)} />
                <MetricCard label="点击 / CTR" value={`${count(totals.clicks)} / ${totals.ctr.toFixed(2)}%`} />
                <MetricCard label="平均点击费用" value={money(totals.avgCpc)} />
                <MetricCard label="广告归因订单" value={count(totals.orders)} />
                <MetricCard label="广告归因销售额" value={money(totals.sales)} hint="仅广告报表归因，不并入 GMV" />
                <MetricCard label="DRR" value={totals.drr === null ? "—" : `${totals.drr.toFixed(2)}%`} />
              </div>

              <section className="performance-ads-trend" aria-label="广告日趋势">
                <div className="performance-ads-section-title"><div><h4>广告趋势</h4><span>按 Ozon 报表自然日统计</span></div>
                  <label className="performance-ads-inline-select">趋势指标<select value={trendMetric} onChange={(event) => setTrendMetric(event.target.value as TrendMetric)}>
                    <option value="expense">广告消耗</option><option value="sales">归因销售额</option><option value="clicks">点击</option><option value="orders">归因订单</option><option value="drr">DRR</option>
                  </select></label>
                </div>
                {data?.trend.length ? <div className="performance-ads-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={data.trend.map((point) => ({ ...point, value: metricValue(point, trendMetric) }))} margin={{ top: 12, right: 18, left: 8, bottom: 4 }}>
                      <CartesianGrid stroke="var(--border, #26354b)" strokeDasharray="3 5" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={(value: string) => value.slice(5)} minTickGap={24} stroke="var(--muted, #94a3b8)" tick={{ fontSize: 11 }} />
                      <YAxis width={76} tickFormatter={(value: number) => trendMetric === "expense" || trendMetric === "sales" ? `₽${count(value)}` : trendMetric === "drr" ? `${value}%` : count(value)} stroke="var(--muted, #94a3b8)" tick={{ fontSize: 11 }} />
                      <Tooltip labelFormatter={(label: ReactNode) => label} formatter={(value: number | string | ReadonlyArray<number | string> | undefined) => [formatTrendValue(Number(value ?? 0), trendMetric), metricLabel(trendMetric)]} contentStyle={{ background: "var(--surface-raised, #172033)", border: "1px solid var(--border, #334155)", borderRadius: 9 }} />
                      <Line type="monotone" dataKey="value" name={metricLabel(trendMetric)} stroke="#38bdf8" strokeWidth={2.5} dot={data.trend.length < 20} activeDot={{ r: 5 }} connectNulls={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div> : <div className="performance-ads-empty">所选日期范围内暂无趋势数据。</div>}
              </section>

              <section className="performance-ads-diagnostics" aria-label="广告异常诊断">
                <div className="performance-ads-section-title"><div><h4>异常诊断</h4><span>仅诊断投放中活动；已忽略 {ignoredDiagnosticCount} 个已暂停、结束、未启用或归档活动</span></div><span>{data?.diagnostics.length ?? 0} 项</span></div>
                {data?.diagnostics.length ? <div className="performance-ads-diagnostic-list">{data.diagnostics.map((diagnostic) => <article className={`performance-ads-diagnostic is-${diagnostic.severity}`} key={diagnostic.id}>
                  <div><strong>{diagnostic.title}</strong><span className="performance-ads-diagnostic-campaign">{diagnostic.campaignName}<em>{campaignStateLabel(diagnostic.campaignState)}</em></span><p>{diagnostic.detail}</p><small>{diagnostic.recommendation}</small></div>
                  <button type="button" className="secondary-button" aria-label={diagnosticAction(diagnostic)} onClick={() => openDiagnosticCampaign(diagnostic.campaignId)}>查看活动</button>
                </article>)}</div> : <div className="performance-ads-empty performance-ads-empty--compact"><CheckCircle2 size={18} />当前范围未发现需要提醒的活动。</div>}
              </section>
              </>}

              {reportSection === "campaigns" && <section ref={campaignTableRef} className="performance-ads-campaign-section" role="tabpanel">
                <div className="performance-ads-section-title"><h4>广告活动{selectedCampaignId ? " · 趋势和 SKU 已按活动筛选" : ""}</h4><span>{visibleCampaigns.length} / {campaignRows.length} 个活动</span></div>
                <div className="performance-ads-table-toolbar">
                  <label className="performance-ads-search"><Search size={16} aria-hidden="true" /><input value={campaignSearch} onChange={(event) => setCampaignSearch(event.target.value)} placeholder="搜索活动名称或 ID" aria-label="搜索活动名称或 ID" /></label>
                  <label className="performance-ads-sort"><ArrowDownWideNarrow size={16} aria-hidden="true" /><select value={campaignSort} onChange={(event) => setCampaignSort(event.target.value as CampaignSort)} aria-label="活动排序">
                    <option value="expense">消耗从高到低</option><option value="sales">归因销售额从高到低</option><option value="drr">DRR 从高到低</option><option value="ctr">CTR 从高到低</option><option value="clicks">点击从高到低</option><option value="orders">归因订单从高到低</option><option value="name">活动名称</option>
                  </select></label>
                  {selectedCampaignId && <button type="button" className="secondary-button" onClick={clearCampaignFilter}>退出活动筛选</button>}
                </div>
                {visibleCampaigns.length ? <div className="performance-ads-table-wrap"><table className="performance-ads-table"><thead><tr><th>活动</th><th>状态</th><th>消耗</th><th>曝光</th><th>点击</th><th>CTR</th><th>平均 CPC</th><th>归因订单</th><th>归因销售额</th><th>DRR</th></tr></thead><tbody>
                  {visibleCampaigns.map((row) => <tr className={selectedCampaignId === row.campaignId ? "is-selected" : ""} key={row.campaignId}>
                    <td><button type="button" className="performance-ads-campaign-select" aria-pressed={selectedCampaignId === row.campaignId} onClick={() => selectCampaign(row.campaignId)}><strong>{row.name}</strong><small>活动 ID：{row.campaignId}</small></button></td><td>{campaignStateLabel(row.state)}</td><td>{money(row.expense)}</td><td>{count(row.impressions)}</td><td>{count(row.clicks)}</td><td>{row.ctr.toFixed(2)}%</td><td>{money(row.avgCpc)}</td><td>{count(row.orders)}</td><td>{money(row.sales)}</td><td>{row.drr === null ? "—" : `${row.drr.toFixed(2)}%`}</td>
                  </tr>)}
                </tbody></table></div> : <div className="performance-ads-empty"><Megaphone size={20} />{campaignRows.length ? "没有符合搜索条件的活动。" : "所选日期范围内没有广告活动报表。"}</div>}
              </section>}

              {reportSection === "skus" && <section className="performance-ads-sku-section" role="tabpanel">
                <div className="performance-ads-section-title"><h4>SKU 明细{selectedCampaignId ? " · 已按活动筛选" : ""}</h4><span>{skuRows.length} 条</span></div>
                {skuRows.length ? <div className="performance-ads-table-wrap"><table className="performance-ads-table performance-ads-sku-table"><thead><tr><th>商品信息</th><th>所属活动</th><th>消耗</th><th>曝光</th><th>点击</th><th>CTR</th><th>平均 CPC</th><th>归因订单</th><th>归因销售额</th><th>DRR</th></tr></thead><tbody>
                  {skuRows.map((row, index) => <tr key={`${row.campaignId}:${row.sku}:${index}`}>
                    <td><div className="performance-ads-product-cell">
                      <OrderImagePreview src={row.product.imageUrl} alt={skuProductLabel(row)} fallbackLabel="无商品图片" width={44} height={44} className="performance-ads-product-image" />
                      <div><strong>{row.product.productUrl ? <a href={row.product.productUrl} target="_blank" rel="noreferrer">{skuProductLabel(row)}</a> : skuProductLabel(row)}</strong>
                        <small>Ozon SKU：{row.product.ozonSku ?? row.sku}</small><small>Seller 货号：{row.product.offerId ?? "未匹配"}</small>
                        {!hasLocalProduct(row) && <small className="performance-ads-unmatched">未匹配本地商品信息</small>}
                      </div>
                    </div></td><td>{row.campaignName || row.campaignId}</td><td>{money(row.expense)}</td><td>{count(row.impressions)}</td><td>{count(row.clicks)}</td><td>{row.ctr.toFixed(2)}%</td><td>{money(row.avgCpc)}</td><td>{count(row.orders)}</td><td>{money(row.sales)}</td><td>{row.drr === null ? "—" : `${row.drr.toFixed(2)}%`}</td>
                  </tr>)}
                </tbody></table></div> : <div className="performance-ads-empty">暂无 SKU 明细。Ozon 的 SKU 报表仅提供近期数据，或当前活动尚无 SKU 归因结果。</div>}
              </section>}
            </>}
          </section>
          {configQuery.data.status === "success" && <p className="performance-ads-success"><CheckCircle2 size={16} />{selectedStore?.name} 的广告报表与 Seller 订单 GMV 分开统计。</p>}
        </>}
      </>}
    </main>
  );
}
