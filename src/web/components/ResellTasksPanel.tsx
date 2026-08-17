import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, CircleCheck, CircleX, Clock3, ExternalLink, Filter, History, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ResellStatus, ResellTaskDetailView, ResellTaskListItem } from "../../shared/contracts";
import { fetchResellTaskDetail, fetchResellTasks, fetchStores, retryResellTask } from "../api";
import { formatMoney } from "../format";

const statusLabels: Record<ResellStatus, string> = {
  draft: "草稿",
  preflight_failed: "预检失败",
  creating: "创建中",
  pending: "等待 Ozon 处理",
  created: "商品已创建",
  setting_images: "上传图片",
  setting_price: "设置价格",
  setting_stock: "设置库存",
  moderating: "等待审核",
  sellable: "已提交",
  needs_input: "需要补充",
  failed: "失败",
};

const statusValues: ResellStatus[] = ["draft", "preflight_failed", "creating", "pending", "created", "setting_images", "setting_price", "setting_stock", "moderating", "sellable", "needs_input", "failed"];

function statusTone(status: ResellStatus): string {
  if (status === "sellable") return "resell-history-status--success";
  if (["failed", "preflight_failed", "needs_input"].includes(status)) return "resell-history-status--error";
  if (status === "moderating") return "resell-history-status--warning";
  return "resell-history-status--active";
}

function statusIcon(status: ResellStatus): React.JSX.Element {
  if (status === "sellable") return <CircleCheck size={14} aria-hidden="true" />;
  if (["failed", "preflight_failed", "needs_input"].includes(status)) return <CircleX size={14} aria-hidden="true" />;
  return <Clock3 size={14} aria-hidden="true" />;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

function titleForTask(task: ResellTaskListItem): string {
  return task.productTitle?.trim() || "未命名商品";
}

/** Displays local follow-sale history and keeps task detail in one focused drawer. */
export function ResellTasksPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [storeId, setStoreId] = useState("");
  const [status, setStatus] = useState<ResellStatus | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sourceSku, setSourceSku] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pageSize = 20;
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores });
  const tasksQuery = useQuery({
    queryKey: ["resell-tasks", page, storeId, status, from, to, sourceSku],
    queryFn: () => fetchResellTasks({ page, pageSize, ...(storeId ? { storeId } : {}), ...(status ? { status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(sourceSku.trim() ? { sourceSku: sourceSku.trim() } : {}) }),
  });
  const detailQuery = useQuery({
    queryKey: ["resell-task-detail", selectedId],
    queryFn: () => fetchResellTaskDetail(selectedId!),
    enabled: Boolean(selectedId),
  });
  const retryMutation = useMutation({
    mutationFn: (id: string) => retryResellTask(id),
    onSuccess: async (_task, id) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["resell-tasks"] }),
        queryClient.invalidateQueries({ queryKey: ["resell-task-detail", id] }),
      ]);
    },
  });

  useEffect(() => {
    if (!selectedId) return;
    closeButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setSelectedId(null);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedId]);

  function resetFilters(): void {
    setStoreId(""); setStatus(""); setFrom(""); setTo(""); setSourceSku(""); setPage(1);
  }

  function openTask(taskId: string): void {
    setSelectedId(taskId);
  }

  const total = tasksQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const detail = detailQuery.data;
  return <section className="selection-tab-panel resell-history-panel" role="tabpanel" aria-label="跟卖任务">
    <div className="resell-history-heading"><div><p className="eyebrow">PUBLISH HISTORY</p><h3>跟卖任务</h3><p>查看所有本机提交的跟卖任务、Ozon 状态和失败原因。</p></div><History size={28} aria-hidden="true" /></div>
    <div className="resell-history-toolbar">
      <label className="selection-sort"><span>目标店铺</span><select value={storeId} onChange={(event) => { setStoreId(event.target.value); setPage(1); }}><option value="">全部店铺</option>{(storesQuery.data ?? []).map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      <label className="selection-sort"><Filter size={15} aria-hidden="true" /><span>状态</span><select value={status} onChange={(event) => { setStatus(event.target.value as ResellStatus | ""); setPage(1); }}><option value="">全部状态</option>{statusValues.map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}</select></label>
      <label className="resell-history-date"><CalendarDays size={15} aria-hidden="true" /><span>从</span><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} /></label>
      <label className="resell-history-date"><CalendarDays size={15} aria-hidden="true" /><span>到</span><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} /></label>
      <label className="selection-search resell-history-search"><Search size={16} /><span className="sr-only">搜索 SKU</span><input value={sourceSku} onChange={(event) => { setSourceSku(event.target.value); setPage(1); }} placeholder="搜索来源 SKU" /></label>
      <button className="secondary-button compact-button" type="button" onClick={resetFilters}><RefreshCw size={15} />重置筛选</button>
    </div>
    {tasksQuery.isLoading ? <div className="selection-table-loading" aria-busy="true">正在读取跟卖任务…</div> : tasksQuery.error ? <div className="page-error" role="alert"><h3>任务历史加载失败</h3><p>{tasksQuery.error.message}</p><button className="secondary-button compact-button" type="button" onClick={() => void tasksQuery.refetch()}>重新加载</button></div> : tasksQuery.data?.items.length === 0 ? <div className="selection-empty"><History size={31} /><h3>{total > 0 ? "没有符合筛选条件的任务" : "还没有跟卖任务"}</h3><p>{total > 0 ? "可以清除筛选后再查看。" : "提交跟卖后，任务会显示在这里。"}</p>{total > 0 && <button className="secondary-button" type="button" onClick={resetFilters}>清除筛选</button>}</div> : <>
      <div className="table-scroll resell-history-table-wrap"><table className="selection-keyword-table resell-history-table"><thead><tr><th>创建时间</th><th>店铺</th><th>商品标题</th><th>SKU / Offer ID</th><th>价格 / VAT</th><th>库存 / Product ID</th><th>状态</th><th>最后错误</th></tr></thead><tbody>{tasksQuery.data?.items.map((task) => <tr key={task.id} tabIndex={0} role="button" aria-label={`查看 ${titleForTask(task)} 的跟卖任务`} onClick={() => openTask(task.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openTask(task.id); } }}><td data-label="创建时间" className="tabular-nums">{formatDateTime(task.createdAt)}</td><td data-label="店铺">{task.storeName}</td><td data-label="商品标题"><span className="resell-history-title" title={titleForTask(task)}>{titleForTask(task)}</span></td><td data-label="SKU / Offer ID"><span>{task.sourceSku}</span><small>{task.targetOfferId}</small></td><td data-label="价格 / VAT"><span>{formatMoney(task.price)}</span><small>VAT {task.vat}</small></td><td data-label="库存 / Product ID"><span>{task.stock} 件</span><small>{task.productId ?? "等待返回"}</small></td><td data-label="状态"><span className={`resell-history-status ${statusTone(task.status)}`}>{statusIcon(task.status)}<span className="resell-history-status__label">{statusLabels[task.status]}</span></span></td><td data-label="最后错误"><span className="resell-history-error">{task.lastError ?? "—"}</span></td></tr>)}</tbody></table></div>
      <div className="selection-pagination"><span>共 {total} 条</span><div><button className="icon-button" type="button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}><ChevronLeft size={17} /></button><strong>{page} / {totalPages}</strong><button className="icon-button" type="button" aria-label="下一页" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}><ChevronRight size={17} /></button></div></div>
    </>}
    {selectedId && <div className="selection-drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><aside className="resell-history-drawer" role="dialog" aria-modal="true" aria-labelledby="resell-history-detail-title"><div className="selection-drawer-heading"><div><p className="eyebrow">TASK DETAIL</p><h2 id="resell-history-detail-title">跟卖任务详情</h2></div><button ref={closeButtonRef} className="icon-button" type="button" onClick={() => setSelectedId(null)} aria-label="关闭详情"><X size={18} /></button></div>{detailQuery.isLoading ? <div className="selection-drawer-loading" aria-busy="true">正在读取任务详情…</div> : detailQuery.error ? <div className="page-error" role="alert"><p>{detailQuery.error.message}</p><button className="secondary-button compact-button" type="button" onClick={() => void detailQuery.refetch()}>重新加载</button></div> : detail && <ResellTaskDetail detail={detail} retrying={retryMutation.isPending} onRetry={() => retryMutation.mutate(detail.id)} />}</aside></div>}
  </section>;
}

function ResellTaskDetail(props: { detail: ResellTaskDetailView; retrying: boolean; onRetry: () => void }): React.JSX.Element {
  const task = props.detail;
  const canRetry = ["failed", "needs_input", "moderating"].includes(task.status) && !task.productId;
  return <div className="resell-history-detail"><div className="resell-history-detail__status"><span className={`resell-history-status ${statusTone(task.status)}`}>{statusIcon(task.status)}<span className="resell-history-status__label">{statusLabels[task.status]}</span></span><strong>{formatMoney(task.price)}</strong></div><dl className="resell-history-detail__grid"><div><dt>目标店铺</dt><dd>{task.storeName}</dd></div><div><dt>来源 SKU</dt><dd>{task.sourceSku}</dd></div><div><dt>商品标题</dt><dd>{task.productTitle ?? "—"}</dd></div><div><dt>Offer ID</dt><dd>{task.targetOfferId}</dd></div><div><dt>模式 / 履约</dt><dd>{task.mode === "quick" ? "快速创建" : "编辑后上架"} / {task.fulfillmentMode}</dd></div><div><dt>仓库</dt><dd>{task.warehouseId || "—"}</dd></div><div><dt>VAT / 库存</dt><dd>{task.vat} / {task.stock} 件</dd></div><div><dt>图片数量</dt><dd>{task.imageCount} 张</dd></div><div><dt>Ozon Task ID</dt><dd>{task.ozonTaskId ?? "—"}</dd></div><div><dt>Product ID</dt><dd>{task.productId ?? "—"}</dd></div></dl>{task.sourceUrl && <a className="secondary-button compact-button" href={task.sourceUrl} target="_blank" rel="noreferrer">打开来源商品 <ExternalLink size={14} /></a>}{task.lastError && <div className="field-error resell-history-detail__error" role="alert"><AlertCircle size={17} />{task.lastError}</div>}{task.productId && ["failed", "needs_input", "moderating"].includes(task.status) && <p className="resell-warning"><AlertCircle size={16} />商品已在 Ozon 创建，请先修正已有商品，不要重复创建。</p>}{canRetry && <button className="secondary-button" type="button" onClick={props.onRetry} disabled={props.retrying}>{props.retrying ? "重新提交中…" : "重新提交任务"}</button>}<section className="resell-history-timeline" aria-label="状态时间线"><h3>状态时间线</h3>{task.events.map((event, index) => <div className="resell-history-event" key={`${event.createdAt}-${index}`}><span className={`resell-history-status ${statusTone(event.status)}`}><span className="resell-history-status__label">{statusLabels[event.status]}</span></span><time>{formatDateTime(event.createdAt)}</time>{event.message && <p>{event.message}</p>}</div>)}</section><dl className="resell-history-detail__timestamps"><div><dt>创建时间</dt><dd>{formatDateTime(task.createdAt)}</dd></div><div><dt>更新时间</dt><dd>{formatDateTime(task.updatedAt)}</dd></div><div><dt>完成时间</dt><dd>{task.completedAt ? formatDateTime(task.completedAt) : "—"}</dd></div></dl></div>;
}
