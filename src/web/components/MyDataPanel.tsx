import {
  ChevronLeft,
  ChevronRight,
  Database,
  Rocket,
  FileSpreadsheet,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import type { MyDataFulfillmentMode, MyDataImportPreview, MyDataImportResult, MyDataProductPage, MyDataSort } from "../../shared/contracts";
import {
  clearMyData,
  commitMyDataImport,
  fetchMyDataOverview,
  fetchMyDataProducts,
  previewMyDataImport,
} from "../api";
import { formatMoney } from "../format";
import { useDialogKeyboard } from "./useDialogKeyboard";

interface MyDataPanelProps {
  onNotice: (notice: { tone: "success" | "error"; text: string }) => void;
}

const sortOptions: Array<{ value: MyDataSort; label: string }> = [
  { value: "monthlyUnits", label: "月销量" },
  { value: "monthlySales", label: "月销售额" },
  { value: "averageOrderValue", label: "客单价" },
  { value: "conversionRate", label: "转化率" },
  { value: "impressions", label: "展示量" },
];

function numberValue(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}

function formatPercent(value: number): string {
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}%`;
}

function fulfillmentLabel(mode: MyDataProductPage["items"][number]["fulfillmentMode"]): string {
  if (mode === "FBO") return "本土 FBO";
  if (mode === "FBS") return "跨境 FBS";
  if (mode === "RFBS") return "RFBS";
  return "未知";
}

/** Keeps imported product links restricted to secure external destinations. */
function safeProductUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Imports and filters daily MY snapshots while keeping the existing selection workspace visual language. */
export function MyDataPanel(props: MyDataPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [captureDay, setCaptureDay] = useState("");
  const [allDates, setAllDates] = useState(true);
  const [search, setSearch] = useState("");
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("");
  const [fulfillmentMode, setFulfillmentMode] = useState<MyDataFulfillmentMode | "">("");
  const [minUnits, setMinUnits] = useState("");
  const [maxUnits, setMaxUnits] = useState("");
  const [minAov, setMinAov] = useState("");
  const [maxAov, setMaxAov] = useState("");
  const [sort, setSort] = useState<MyDataSort>("monthlyUnits");
  const [page, setPage] = useState(1);
  const [showImport, setShowImport] = useState(false);

  const overviewQuery = useQuery({
    queryKey: ["my-data-overview", captureDay],
    queryFn: () => fetchMyDataOverview(captureDay || undefined),
  });
  useEffect(() => {
    if (!allDates && !captureDay && overviewQuery.data?.latestCaptureDay) {
      setCaptureDay(overviewQuery.data.latestCaptureDay);
    }
  }, [allDates, captureDay, overviewQuery.data?.latestCaptureDay]);

  const dateFilter: { allDates?: boolean; captureDay?: string } = {};
  if (allDates) {
    dateFilter.allDates = true;
  } else if (captureDay) {
    dateFilter.captureDay = captureDay;
  }
  const filters = {
    page,
    pageSize: 20,
    sort,
    ...dateFilter,
    ...(search.trim() ? { search: search.trim() } : {}),
    ...(keyword ? { keyword } : {}),
    ...(category ? { category } : {}),
    ...(fulfillmentMode ? { fulfillmentMode } : {}),
    ...(numberValue(minUnits) !== undefined ? { minMonthlyUnits: numberValue(minUnits) } : {}),
    ...(numberValue(maxUnits) !== undefined ? { maxMonthlyUnits: numberValue(maxUnits) } : {}),
    ...(numberValue(minAov) !== undefined ? { minAov: numberValue(minAov) } : {}),
    ...(numberValue(maxAov) !== undefined ? { maxAov: numberValue(maxAov) } : {}),
  };
  const productsQuery = useQuery({
    queryKey: ["my-data-products", filters],
    queryFn: () => fetchMyDataProducts(filters),
  });
  const clearMutation = useMutation({
    mutationFn: clearMyData,
    onSuccess: async () => {
      clearFilters();
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["my-data-overview"] }),
        queryClient.refetchQueries({ queryKey: ["my-data-products"] }),
      ]);
      props.onNotice({ tone: "success", text: "MY 数据已清空。" });
    },
    onError: (error) => props.onNotice({ tone: "error", text: error instanceof Error ? error.message : "清空失败" }),
  });

  function clearFilters(): void {
    setSearch("");
    setAllDates(true);
    setCaptureDay("");
    setKeyword("");
    setCategory("");
    setFulfillmentMode("");
    setMinUnits("");
    setMaxUnits("");
    setMinAov("");
    setMaxAov("");
    setPage(1);
  }

  function confirmClear(): void {
    if (window.confirm(`确定清空全部 MY 数据吗？这将删除 ${overviewQuery.data?.importCount ?? 0} 个导入批次和历史快照，且不可恢复。`)) {
      clearMutation.mutate();
    }
  }

  function renderDataState(): React.JSX.Element {
    if (overviewQuery.isFetching || productsQuery.isFetching) {
      return <div className="my-data-skeleton" aria-busy="true">正在刷新 MY 数据…</div>;
    }
    if (!hasData) {
      return <EmptyMyData onImport={() => setShowImport(true)} />;
    }
    if (productsQuery.isLoading) {
      return <div className="my-data-skeleton" aria-busy="true">正在筛选商品…</div>;
    }
    if (productsQuery.error) {
      return <div className="field-error" role="alert">{productsQuery.error.message}<button className="secondary-button compact-button" type="button" onClick={() => void productsQuery.refetch()}>重试</button></div>;
    }
    if (!productsQuery.data || productsQuery.data.items.length === 0) {
      return <div className="my-data-empty-filter">没有匹配商品。<button className="secondary-button compact-button" type="button" onClick={clearFilters}>清除筛选</button></div>;
    }
    return <MyDataTable items={productsQuery.data.items} onResell={(sku) => navigate(`/selection/resell/${encodeURIComponent(sku)}`)} />;
  }

  const totalPages = Math.max(1, Math.ceil((productsQuery.data?.total ?? 0) / 20));
  const hasData = (overviewQuery.data?.productCount ?? 0) > 0 || (productsQuery.data?.total ?? 0) > 0;
  return (
    <section className="selection-tab-panel my-data-panel" role="tabpanel" aria-label="MY 数据">
      <div className="my-data-heading">
        <div>
          <p className="eyebrow">MANUAL SNAPSHOTS</p>
          <h3>MY 数据筛选</h3>
          <p>月销量和月销售额是采集时的滚动指标；跨天数据保留为历史快照，不直接相加。客单价按月销售额 ÷ 月销量计算。</p>
        </div>
        <div className="my-data-actions">
          <button className="primary-button" type="button" onClick={() => setShowImport(true)}><Upload size={17} />导入 MY 数据</button>
          <button className="danger-button" type="button" disabled={!hasData || clearMutation.isPending} onClick={confirmClear}><Trash2 size={17} />清空数据</button>
        </div>
      </div>
      {overviewQuery.isLoading ? <div className="my-data-skeleton" aria-busy="true">正在读取 MY 数据…</div> : (
        <>
          <div className="my-data-kpis">
            <Metric label="当前商品数" value={(overviewQuery.data?.productCount ?? 0).toLocaleString("zh-CN")} hint={allDates ? "全部日期" : captureDay || "尚未导入"} />
            <Metric label="月销量合计" value={(overviewQuery.data?.monthlyUnits ?? 0).toLocaleString("zh-CN")} hint="当前采集日" />
            <Metric label="月销售额" value={overviewQuery.data ? formatMoney(overviewQuery.data.monthlySales) : "—"} hint="RUB" />
            <Metric label="平均客单价" value={overviewQuery.data?.averageOrderValue ? formatMoney(overviewQuery.data.averageOrderValue) : "—"} hint="月销售额 ÷ 月销量" />
          </div>
          <div className="my-data-toolbar">
            <label className="selection-search"><Search size={17} /><span className="sr-only">搜索 SKU 或商品名</span><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="搜索 SKU 或商品名" /></label>
            <label className="my-data-field"><span>采集日期</span><select value={allDates ? "__all__" : captureDay} onChange={(event) => { const value = event.target.value; setAllDates(value === "__all__"); setCaptureDay(value === "__all__" ? "" : value); setPage(1); }}><option value="">最新采集日</option><option value="__all__">全部日期</option>{(productsQuery.data?.captureDays ?? overviewQuery.data?.captureDays ?? []).map((day) => <option value={day} key={day}>{day}</option>)}</select></label>
            <label className="my-data-field"><span>关键词</span><select value={keyword} onChange={(event) => { setKeyword(event.target.value); setPage(1); }}><option value="">全部关键词</option>{(productsQuery.data?.keywords ?? []).map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
            <label className="my-data-field my-data-category-filter"><span>类目</span><select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">全部类目</option>{(productsQuery.data?.facets?.categories ?? []).map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
            <label className="my-data-field my-data-category-filter"><span>发货模式</span><select value={fulfillmentMode} onChange={(event) => { setFulfillmentMode(event.target.value as MyDataFulfillmentMode | ""); setPage(1); }}><option value="">全部发货模式</option>{(productsQuery.data?.facets?.fulfillmentModes ?? []).map((item) => <option value={item} key={item}>{fulfillmentLabel(item)}</option>)}</select></label>
            <label className="my-data-range"><span>月销量</span><input inputMode="numeric" value={minUnits} onChange={(event) => { setMinUnits(event.target.value); setPage(1); }} placeholder="最小" /><b>—</b><input inputMode="numeric" value={maxUnits} onChange={(event) => { setMaxUnits(event.target.value); setPage(1); }} placeholder="最大" /></label>
            <label className="my-data-range"><span>客单价 ₽</span><input inputMode="decimal" value={minAov} onChange={(event) => { setMinAov(event.target.value); setPage(1); }} placeholder="最小" /><b>—</b><input inputMode="decimal" value={maxAov} onChange={(event) => { setMaxAov(event.target.value); setPage(1); }} placeholder="最大" /></label>
            <label className="my-data-field"><span>排序</span><select value={sort} onChange={(event) => { setSort(event.target.value as MyDataSort); setPage(1); }}>{sortOptions.map((item) => <option value={item.value} key={item.value}>{item.label}降序</option>)}</select></label>
            <button className="secondary-button compact-button" type="button" onClick={clearFilters}><RefreshCw size={16} />重置筛选</button>
          </div>
          {allDates && <p className="my-data-filter-note" role="status">当前查看全部历史快照；指标卡仍显示最新采集日，月销量和月销售额不会跨日期相加。</p>}
          {renderDataState()}
          {(productsQuery.data?.total ?? 0) > 0 && <div className="selection-pagination"><span>共 {(productsQuery.data?.total ?? 0).toLocaleString("zh-CN")} 条快照</span><div><button className="icon-button" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="上一页"><ChevronLeft size={18} /></button><strong>{page} / {totalPages}</strong><button className="icon-button" type="button" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)} aria-label="下一页"><ChevronRight size={18} /></button></div></div>}
        </>
      )}
      {showImport && <MyDataImportDialog onClose={() => setShowImport(false)} onImported={async (result) => { setShowImport(false); setAllDates(true); setCaptureDay(""); setPage(1); await Promise.all([queryClient.refetchQueries({ queryKey: ["my-data-overview"] }), queryClient.refetchQueries({ queryKey: ["my-data-products"] })]); props.onNotice({ tone: "success", text: `MY 数据导入完成：新增 ${result.importedFiles} 个文件，${result.validRows.toLocaleString("zh-CN")} 条有效记录，跳过 ${result.duplicateFiles} 个重复文件。` }); }} />}
    </section>
  );
}

function Metric(props: { label: string; value: string; hint: string }): React.JSX.Element {
  return <div className="my-data-metric"><span>{props.label}</span><strong>{props.value}</strong><small>{props.hint}</small></div>;
}

function EmptyMyData(props: { onImport: () => void }): React.JSX.Element {
  return <div className="my-data-empty"><Database size={30} /><h4>还没有 MY 数据</h4><p>选择 MY 插件导出的文件夹，系统会读取其中全部 CSV/XLSX 并自动去重。</p><button className="primary-button" type="button" onClick={props.onImport}><Upload size={17} />选择文件夹导入</button></div>;
}

function MyDataTable(props: { items: MyDataProductPage["items"]; onResell: (sku: string) => void }): React.JSX.Element {
  return <div className="my-data-table-wrap"><table className="my-data-table"><thead><tr><th scope="col">商品</th><th scope="col">类目</th><th scope="col">SKU</th><th scope="col">月销量</th><th scope="col">月销售额</th><th scope="col">客单价</th><th scope="col">展示量</th><th scope="col">转化率</th><th scope="col">折扣</th><th scope="col">关键词</th><th scope="col">采集日</th><th scope="col">发货模式</th><th scope="col">操作</th></tr></thead><tbody>{props.items.map((item) => {
    const productUrl = safeProductUrl(item.productUrl);
    const productTitle = productUrl ? <a className="my-data-product-link my-data-product-title" href={productUrl} target="_blank" rel="noopener noreferrer" title={item.productName}>{item.productName}</a> : <span className="my-data-product-title" title={item.productName}>{item.productName}</span>;
    const sku = productUrl ? <a className="my-data-sku-link" href={productUrl} target="_blank" rel="noopener noreferrer" aria-label={`打开 ${item.sku} 商品详情`}>{item.sku}</a> : item.sku;
    return <tr key={item.id}><td><div className="my-data-product"><span className="my-data-thumb">{item.imageUrl ? <img src={item.imageUrl} alt={`${item.productName} 主图`} loading="lazy" /> : <FileSpreadsheet size={18} aria-label="无商品主图" />}</span>{productTitle}</div></td><td className="my-data-category" title={item.category}>{item.category || "—"}</td><td className="tabular-nums">{sku}</td><td className="tabular-nums">{item.monthlyUnits.toLocaleString("zh-CN")}</td><td className="tabular-nums">{formatMoney(item.monthlySales)}</td><td className="tabular-nums">{item.averageOrderValue ? formatMoney(item.averageOrderValue) : "—"}</td><td className="tabular-nums">{item.impressions.toLocaleString("zh-CN")}</td><td className="tabular-nums">{formatPercent(item.conversionRate)}</td><td className="tabular-nums">{formatPercent(item.discountRate)}</td><td>{item.keyword || "—"}</td><td className="tabular-nums">{item.captureDay}</td><td><span className={`my-data-fulfillment my-data-fulfillment--${item.fulfillmentMode.toLowerCase()}`}>{fulfillmentLabel(item.fulfillmentMode)}</span></td><td><button className="secondary-button compact-button my-data-resell-button" type="button" onClick={() => props.onResell(item.sku)}><Rocket size={15} />一键跟卖</button></td></tr>;
  })}</tbody></table></div>;
}

function MyDataImportDialog(props: { onClose: () => void; onImported: (result: MyDataImportResult) => Promise<void> }): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [folderName, setFolderName] = useState("MY 数据文件夹");
  const [preview, setPreview] = useState<MyDataImportPreview | null>(null);
  const [result, setResult] = useState<MyDataImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDialogKeyboard(props.onClose, dialogRef, closeButtonRef);

  async function chooseFolder(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const selected = Array.from(event.target.files ?? []).filter((file) => /\.(csv|xlsx)$/i.test(file.name));
    if (selected.length === 0) {
      setError("所选文件夹中没有 CSV 或 XLSX 文件。");
      return;
    }
    const path = selected[0]?.webkitRelativePath ?? "";
    setFolderName(path.split("/")[0] || "MY 数据文件夹");
    setFiles(selected);
    setPreview(null);
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      setPreview(await previewMyDataImport(selected, path.split("/")[0] || "MY 数据文件夹"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法预览文件夹");
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (!preview?.canCommit || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const nextResult = await commitMyDataImport(files, folderName);
      setResult(nextResult);
      await props.onImported(nextResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  const previewErrors = preview?.files.flatMap((file) => file.errors.map((item) => `${file.fileName} 第 ${item.row} 行：${item.message}`)) ?? [];
  return <div className="dialog-backdrop" role="presentation"><section ref={dialogRef} className="dialog my-data-import-dialog" role="dialog" aria-modal="true" aria-labelledby="my-data-import-title"><div className="dialog-heading"><div><p className="eyebrow">MY CSV / XLSX IMPORT</p><h2 id="my-data-import-title">导入 MY 数据</h2></div><button ref={closeButtonRef} className="icon-button" type="button" onClick={props.onClose} aria-label="关闭"><X size={20} /></button></div>{result ? <div className="import-complete" role="status"><div className="import-complete__icon"><FileSpreadsheet size={28} /></div><h3>导入完成</h3><p>新增 {result.importedFiles} 个文件，写入 {result.validRows.toLocaleString("zh-CN")} 条有效记录，跳过 {result.duplicateFiles} 个重复文件。</p><button className="primary-button" type="button" onClick={props.onClose}>查看 MY 数据</button></div> : <><button className="selection-dropzone" type="button" onClick={() => fileInput.current?.click()} disabled={busy}><Database size={25} /><strong>{files.length > 0 ? `${folderName}（${files.length} 个 CSV/XLSX）` : "选择 MY 数据文件夹"}</strong><span>系统会读取文件夹内全部 CSV 和 XLSX，重复导入自动跳过</span></button><input ref={fileInput} className="sr-only" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {...({ webkitdirectory: true, directory: true } as Record<string, unknown>)} multiple onChange={(event) => void chooseFolder(event)} />{busy && <div className="selection-loading" aria-busy="true">正在扫描 CSV/XLSX 和重复记录…</div>}{preview && <div className="my-data-preview"><div className="my-data-preview-grid"><Metric label="文件总数" value={String(preview.totalFiles)} hint={`新增 ${preview.newFiles} 个`} /><Metric label="有效记录" value={preview.validRows.toLocaleString("zh-CN")} hint={`重复行 ${preview.duplicateRows}`} /><Metric label="错误记录" value={String(preview.invalidRows)} hint={preview.invalidRows > 0 ? "提交后保留有效数据" : "格式正常"} /><Metric label="采集日期" value={preview.captureDays.at(-1) ?? "—"} hint={preview.captureDays.length > 1 ? `${preview.captureDays.length} 个日期` : ""} /></div><details><summary>查看文件明细</summary><ul>{preview.files.map((file) => <li key={`${file.fileName}-${file.fileHash}`}>{file.fileName}：{file.validRows} 条有效，{file.isDuplicateFile ? "已导入，跳过" : "待导入"}</li>)}</ul></details>{previewErrors.length > 0 && <details><summary>查看错误摘要（{previewErrors.length}）</summary><ul>{previewErrors.slice(0, 20).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></details>}</div>}{error && <div className="field-error" role="alert">{error}</div>}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={props.onClose}>取消</button><button className="primary-button" type="button" disabled={!preview?.canCommit || busy} onClick={() => void submit()}>{busy ? "正在导入…" : "确认导入"}</button></div></>}</section></div>;
}
