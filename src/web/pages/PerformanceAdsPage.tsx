import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, LoaderCircle, Megaphone, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

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

const LAST_STORE_KEY = "ozon-gmv:performance-ads-last-store-id";

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function daysBefore(date: string, count: number): string {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() - count);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function readLastStoreId(): string {
  try { return window.localStorage.getItem(LAST_STORE_KEY) ?? ""; } catch { return ""; }
}

function rememberStoreId(storeId: string): void {
  try { window.localStorage.setItem(LAST_STORE_KEY, storeId); } catch { /* Selection remains available for this session. */ }
}

function numberValue(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function money(value: unknown): string {
  return `₽${new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value ?? 0))}`;
}

function count(value: unknown): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(Number(value ?? 0));
}

/** Converts Ozon campaign state enums into operator-facing Chinese labels. */
function campaignStateLabel(state: unknown): string {
  const labels: Record<string, string> = {
    campaign_state_running: "投放中",
    campaign_state_inactive: "未启用",
    campaign_state_archived: "已归档",
  };
  const key = String(state ?? "unknown").toLowerCase();
  return labels[key] ?? "未知状态";
}

function reportDateRange(): { from: string; to: string } {
  const yesterday = daysBefore(todayIso(), 1);
  return { from: daysBefore(yesterday, 29), to: yesterday };
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }): React.JSX.Element {
  return <article className="performance-ads-kpi"><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</article>;
}

/** Monitors read-only Ozon Performance reports for one explicitly selected store. */
export default function PerformanceAdsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [storeId, setStoreId] = useState(readLastStoreId);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const initialRange = useMemo(reportDateRange, []);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [campaignState, setCampaignState] = useState("");
  const [message, setMessage] = useState("");
  const [selectedCampaignId, setSelectedCampaignId] = useState("");

  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores, staleTime: 30_000 });
  const stores = (storesQuery.data ?? []).filter((store) => store.enabled && store.platform === "ozon");
  useEffect(() => {
    if (!stores.length) return;
    const next = stores.some((store) => store.id === storeId) ? storeId : stores.some((store) => store.id === readLastStoreId()) ? readLastStoreId() : stores[0]!.id;
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
    queryKey: ["performance-ads", "data", storeId, from, to, campaignState],
    queryFn: () => fetchPerformanceAdsData(storeId, from, to, campaignState),
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
  const totals = data?.totals ?? {};
  const campaignRows = data?.campaigns ?? [];
  const skuRows = useMemo(() => {
    const rows = data?.skus ?? [];
    return selectedCampaignId ? rows.filter((row) => String(row.campaignId) === selectedCampaignId) : rows;
  }, [data?.skus, selectedCampaignId]);
  const selectedStore = stores.find((store) => store.id === storeId);
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

  return (
    <main className="performance-ads-page">
      <header className="performance-ads-header">
        <div>
          <p className="eyebrow">PERFORMANCE ADS</p>
          <h2>广告监测</h2>
          <p className="muted">读取 Ozon Performance 广告报表，分析消耗、点击和广告归因销售；不修改广告，也不并入 GMV 订单统计。</p>
        </div>
        <label className="performance-ads-store-select">目标店铺
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
              <label>开始日期<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
              <label>结束日期<input type="date" value={to} min={from} max={daysBefore(todayIso(), 1)} onChange={(event) => setTo(event.target.value)} /></label>
              <label>活动状态<select value={campaignState} onChange={(event) => setCampaignState(event.target.value)}><option value="">全部状态</option>{Array.from(new Set(campaignRows.map((row) => String(row.state ?? "unknown")))).map((state) => <option value={state} key={state}>{campaignStateLabel(state)}</option>)}</select></label>
              <span className="performance-ads-sync-state">{configQuery.data.status === "syncing" ? <><LoaderCircle className="spin" size={15} />正在同步</> : configQuery.data.lastFinishedAt ? `最近同步：${new Date(configQuery.data.lastFinishedAt).toLocaleString("zh-CN", { hour12: false })}` : "尚无同步记录"}</span>
            </div>
            {data?.skuHistoryLimited && <p className="performance-ads-note">Ozon SKU 报表接口仅允许查询近期数据；当前范围内 SKU 明细从最近可用日期开始，活动日报仍按所选日期范围查询。</p>}
            {configQuery.data.initialBackfillDone === false && <p className="performance-ads-note">首次连接后将回填近 30 天活动日报；后台每 30 分钟更新近期数据。</p>}
            {dataQuery.isLoading ? <div className="performance-ads-empty">正在读取广告报表…</div> : dataQuery.isError ? <div className="performance-ads-message is-error">{dataQuery.error instanceof Error ? dataQuery.error.message : "广告报表读取失败"}</div> : <>
              <div className="performance-ads-kpis">
                <MetricCard label="广告消耗" value={money(numberValue(totals, "expense"))} />
                <MetricCard label="曝光" value={count(numberValue(totals, "impressions"))} />
                <MetricCard label="点击 / CTR" value={`${count(numberValue(totals, "clicks"))} / ${numberValue(totals, "ctr").toFixed(2)}%`} />
                <MetricCard label="平均点击费用" value={money(numberValue(totals, "avgCpc"))} />
                <MetricCard label="广告归因订单" value={count(numberValue(totals, "orders"))} />
                <MetricCard label="广告归因销售额" value={money(numberValue(totals, "sales"))} hint="仅广告报表归因，不并入 GMV" />
                <MetricCard label="DRR" value={totals.drr === null || totals.drr === undefined ? "—" : `${numberValue(totals, "drr").toFixed(2)}%`} />
              </div>
              <div className="performance-ads-section-title"><h4>广告活动</h4><span>{campaignRows.length} 个活动</span></div>
              {campaignRows.length ? <div className="performance-ads-table-wrap"><table className="performance-ads-table"><thead><tr><th>活动</th><th>状态</th><th>消耗</th><th>曝光</th><th>点击</th><th>CTR</th><th>平均 CPC</th><th>归因订单</th><th>归因销售额</th><th>DRR</th></tr></thead><tbody>
                {campaignRows.map((row) => <tr className={selectedCampaignId === String(row.campaignId) ? "is-selected" : ""} key={String(row.campaignId)} onClick={() => setSelectedCampaignId((current) => current === String(row.campaignId) ? "" : String(row.campaignId))}>
                  <td><strong>{String(row.name ?? "未命名活动")}</strong><small>活动 ID：{String(row.campaignId)}</small></td><td>{campaignStateLabel(row.state)}</td><td>{money(row.expense)}</td><td>{count(row.impressions)}</td><td>{count(row.clicks)}</td><td>{numberValue(row, "ctr").toFixed(2)}%</td><td>{money(row.avgCpc)}</td><td>{count(row.orders)}</td><td>{money(row.sales)}</td><td>{row.drr == null ? "—" : `${numberValue(row, "drr").toFixed(2)}%`}</td>
                </tr>)}
              </tbody></table></div> : <div className="performance-ads-empty"><Megaphone size={20} />所选日期范围内没有广告活动报表。</div>}
              <div className="performance-ads-section-title"><h4>SKU 明细{selectedCampaignId ? " · 已按活动筛选" : ""}</h4><span>{skuRows.length} 条</span></div>
              {skuRows.length ? <div className="performance-ads-table-wrap"><table className="performance-ads-table performance-ads-sku-table"><thead><tr><th>SKU / 活动</th><th>消耗</th><th>曝光</th><th>点击</th><th>CTR</th><th>平均 CPC</th><th>归因订单</th><th>归因销售额</th><th>DRR</th></tr></thead><tbody>
                {skuRows.map((row, index) => <tr key={`${String(row.campaignId)}:${String(row.sku)}:${index}`}><td><strong>{String(row.sku ?? "—")}</strong><small>{String(row.campaignName ?? row.campaignId ?? "")}</small></td><td>{money(row.expense)}</td><td>{count(row.impressions)}</td><td>{count(row.clicks)}</td><td>{numberValue(row, "ctr").toFixed(2)}%</td><td>{money(row.avgCpc)}</td><td>{count(row.orders)}</td><td>{money(row.sales)}</td><td>{row.drr == null ? "—" : `${numberValue(row, "drr").toFixed(2)}%`}</td></tr>)}
              </tbody></table></div> : <div className="performance-ads-empty">暂无 SKU 明细。Ozon 的 SKU 报表仅提供近期数据，或当前活动尚无 SKU 归因结果。</div>}
            </>}
          </section>
          {configQuery.data.status === "success" && <p className="performance-ads-success"><CheckCircle2 size={16} />{selectedStore?.name} 的广告报表与 Seller 订单 GMV 分开统计。</p>}
        </>}
      </>}
    </main>
  );
}
