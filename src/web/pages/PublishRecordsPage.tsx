import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ClipboardList, Package, RefreshCw, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { archiveOnlineProducts, fetchOnlineProductWarehouses, fetchOnlineProducts, fetchResellTasks, fetchStores, submitPublishDistribution, updateOnlineProductPrices, updateOnlineProductSourceLinks, updateOnlineProductStocks, type OnlineProductPage, type OnlineProductUpdateResult, type PublishDistributionResult } from "../api";
import "./PublishRecordsPage.css";

type ViewMode = "online" | "uploaded" | "distribution";
type OnlineStatusTab = "all" | "selling" | "ready" | "error" | "needs_edit" | "offline" | "archived";
type OnlineBatchAction = "price" | "stock" | "source" | "archive";

const onlineStatusTabs: Array<{ id: OnlineStatusTab; label: string }> = [
  { id: "all", label: "所有" }, { id: "selling", label: "销售中" }, { id: "ready", label: "准备出售" },
  { id: "error", label: "错误" }, { id: "needs_edit", label: "待修改" }, { id: "offline", label: "已下架" }, { id: "archived", label: "已归档" },
];
const onlineBatchLabels: Record<OnlineBatchAction, string> = { price: "批量改价", stock: "批量修改库存", source: "修改原产品链接", archive: "确认批量归档" };
const onlineBatchConfirmLabels: Record<OnlineBatchAction, string> = { price: "确定修改", stock: "确定修改", source: "确定修改", archive: "确认归档" };

/** Maps Seller status fields to the visible status tabs without inventing missing states. */
function onlineStatusBucket(item: OnlineProductPage["items"][number]): OnlineStatusTab | null {
  if (item.archived === true) return "archived";
  const status = `${item.status ?? ""} ${item.validationStatus ?? ""}`.toLowerCase();
  if (item.statusFailed || /fail|error|ошиб|ошибка|拒绝/.test(status)) return "error";
  if (/прода[её]тся|selling|on_sale/.test(status)) return "selling";
  if (/готов|ready_to_sell|ready to sell/.test(status)) return "ready";
  if (/измен|доработ|needs_edit|needs edit/.test(status)) return "needs_edit";
  if (/снят|отключ|disabled|not_visible|not visible|скрыт/.test(status)) return "offline";
  return null;
}

/** Shows live Ozon cards or persisted publish-task outcomes for the product workflow. */
export default function PublishRecordsPage(props: { mode: ViewMode }): React.JSX.Element {
  const queryClient = useQueryClient();
  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores });
  const stores = (storesQuery.data ?? []).filter((store) => store.enabled && store.platform === "ozon");
  const [storeId, setStoreId] = useState("");
  const [search, setSearch] = useState("");
  const [offerSearch, setOfferSearch] = useState("");
  const [minimumPrice, setMinimumPrice] = useState("");
  const [maximumPrice, setMaximumPrice] = useState("");
  const [minimumWeight, setMinimumWeight] = useState("");
  const [maximumWeight, setMaximumWeight] = useState("");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");
  const [onlineStatus, setOnlineStatus] = useState<OnlineStatusTab>("all");
  const [onlinePageSize, setOnlinePageSize] = useState(20);
  const [onlinePage, setOnlinePage] = useState(1);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [syncMessage, setSyncMessage] = useState("");
  const [batchAction, setBatchAction] = useState<OnlineBatchAction | null>(null);
  const [priceEdits, setPriceEdits] = useState<Record<string, { price: string; oldPrice: string; minimumPrice: string }>>({});
  const [stockEdits, setStockEdits] = useState<Record<string, string>>({});
  const [sourceEdits, setSourceEdits] = useState<Record<string, string>>({});
  const [warehouseId, setWarehouseId] = useState("");
  const [onlineBatchResult, setOnlineBatchResult] = useState<OnlineProductUpdateResult | null>(null);
  const visibility = onlineStatus === "archived" ? "ARCHIVED" : onlineStatus === "offline" ? "INVISIBLE" : "ALL";
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [targetStoreIds, setTargetStoreIds] = useState<string[]>([]);
  const [confirmDistribution, setConfirmDistribution] = useState(false);
  const [distributionResult, setDistributionResult] = useState<PublishDistributionResult | null>(null);
  const activeStoreId = storeId || stores[0]?.id || "";
  const selectedSyncMutation = useMutation({
    mutationFn: () => fetchOnlineProducts(activeStoreId, "ALL", selectedProductIds),
    onSuccess: (result) => {
      queryClient.setQueryData(["online-products", activeStoreId, visibility], (current: typeof result | undefined) => {
        const previous = new Map((current?.items ?? []).map((item) => [item.productId, item]));
        return { ...result, items: result.items.map((item) => ({ ...previous.get(item.productId), ...item, hasFboStocks: item.hasFboStocks ?? previous.get(item.productId)?.hasFboStocks ?? null, hasFbsStocks: item.hasFbsStocks ?? previous.get(item.productId)?.hasFbsStocks ?? null })) };
      });
      setSyncMessage(`已同步所选 ${result.items.length} 个商品`);
      setSelectedProductIds([]);
    },
  });
  const distributionMutation = useMutation({
    mutationFn: () => submitPublishDistribution(selectedTaskIds, targetStoreIds),
    onSuccess: (result) => { setDistributionResult(result); setConfirmDistribution(false); setSelectedTaskIds([]); void queryClient.invalidateQueries({ queryKey: ["publish-tasks"] }); },
  });
  const warehousesQuery = useQuery({ queryKey: ["online-product-warehouses", activeStoreId], queryFn: () => fetchOnlineProductWarehouses(activeStoreId), enabled: props.mode === "online" && batchAction === "stock" && Boolean(activeStoreId) });
  const onlineBatchMutation = useMutation({
    mutationFn: async (): Promise<OnlineProductUpdateResult | { updated: string[] }> => {
      if (batchAction === "price") return updateOnlineProductPrices({ storeId: activeStoreId, edits: selectedOnlineItems.map((item) => { const edit = priceEdits[item.productId]!; return { productId: item.productId, price: edit.price, ...(edit.oldPrice ? { oldPrice: edit.oldPrice } : {}), ...(edit.minimumPrice ? { minimumPrice: edit.minimumPrice } : {}) }; }) });
      if (batchAction === "stock") return updateOnlineProductStocks({ storeId: activeStoreId, warehouseId, items: selectedOnlineItems.map((item) => ({ productId: item.productId, stock: Number(stockEdits[item.productId] ?? 0) })) });
      if (batchAction === "source") return updateOnlineProductSourceLinks({ storeId: activeStoreId, edits: selectedOnlineItems.map((item) => ({ productId: item.productId, sourceUrl: sourceEdits[item.productId]!.trim() })) });
      return archiveOnlineProducts({ storeId: activeStoreId, productIds: selectedOnlineItems.map((item) => item.productId) });
    },
    onSuccess: (result) => {
      if ("skipped" in result) setOnlineBatchResult(result);
      else setSyncMessage(`已保存 ${result.updated.length} 条 GMV 原商品链接`);
      setBatchAction(null);
      void queryClient.invalidateQueries({ queryKey: ["online-products", activeStoreId] });
    },
  });
  const onlineQuery = useQuery({
    queryKey: ["online-products", activeStoreId, visibility],
    queryFn: () => fetchOnlineProducts(activeStoreId, visibility),
    enabled: props.mode === "online" && Boolean(activeStoreId),
  });
  const taskQuery = useQuery({
    queryKey: ["publish-tasks", props.mode, activeStoreId, status, from, to],
    queryFn: () => fetchResellTasks({ page: 1, pageSize: 100, ...(activeStoreId ? { storeId: activeStoreId } : {}), ...(status ? { status } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) }),
    enabled: props.mode !== "online",
  });
  const onlineItems = useMemo(() => (onlineQuery.data?.items ?? []).filter((item) => {
    const matchesName = (item.productName ?? "").toLowerCase().includes(search.trim().toLowerCase());
    const matchesOffer = `${item.offerId} ${item.sku ?? ""} ${item.productId}`.toLowerCase().includes(offerSearch.trim().toLowerCase());
    const matchesPrice = !minimumPrice || (item.price !== null && Number(item.price) >= Number(minimumPrice));
    const matchesMaximumPrice = !maximumPrice || (item.price !== null && Number(item.price) <= Number(maximumPrice));
    const matchesMinimumWeight = !minimumWeight || (item.volumeWeight !== null && item.volumeWeight >= Number(minimumWeight));
    const matchesWeight = !maximumWeight || (item.volumeWeight !== null && item.volumeWeight <= Number(maximumWeight));
    const date = item.createdAt?.slice(0, 10) ?? "";
    const matchesDate = (!createdFrom || (date && date >= createdFrom)) && (!createdTo || (date && date <= createdTo));
    const matchesStatus = onlineStatus === "all" || onlineStatus === "offline" || onlineStatusBucket(item) === onlineStatus;
    return matchesName && matchesOffer && matchesPrice && matchesMaximumPrice && matchesMinimumWeight && matchesWeight && matchesDate && matchesStatus;
  }), [onlineQuery.data, search, offerSearch, minimumPrice, maximumPrice, minimumWeight, maximumWeight, createdFrom, createdTo, onlineStatus]);
  const onlinePageCount = Math.max(1, Math.ceil(onlineItems.length / onlinePageSize));
  const visibleOnlineItems = onlineItems.slice(Math.min(onlinePage - 1, onlinePageCount - 1) * onlinePageSize, Math.min(onlinePage, onlinePageCount) * onlinePageSize);
  const selectedOnlineItems = (onlineQuery.data?.items ?? []).filter((item) => selectedProductIds.includes(item.productId));
  const taskItems = useMemo(() => (taskQuery.data?.items ?? []).filter((item) => {
    const matchesSearch = `${item.targetOfferId} ${item.sourceSku} ${item.productTitle ?? ""}`.toLowerCase().includes(search.trim().toLowerCase());
    return matchesSearch && (props.mode !== "distribution" || ["created", "moderating", "sellable"].includes(item.status));
  }), [taskQuery.data, search, props.mode]);
  const taskGroups = useMemo(() => {
    const groups = new Map<string, typeof taskItems>();
    for (const item of taskItems) {
      const groupId = item.publishDraftId || item.id;
      groups.set(groupId, [...(groups.get(groupId) ?? []), item]);
    }
    return Array.from(groups, ([id, items]) => ({ id, items, lead: items[0]! }));
  }, [taskItems]);
  const title = props.mode === "online" ? "在线商品" : props.mode === "uploaded" ? "上架记录" : "分发中心";
  const loading = props.mode === "online" ? onlineQuery.isLoading : taskQuery.isLoading;
  const error = props.mode === "online" ? onlineQuery.error : taskQuery.error;
  const refresh = props.mode === "online" ? onlineQuery.refetch : taskQuery.refetch;

  async function syncAllOnlineProducts(): Promise<void> {
    const result = await onlineQuery.refetch();
    if (result.data) {
      window.localStorage.setItem(`online-products-last-sync:${activeStoreId}`, result.data.readAt);
      setSyncMessage(`已同步所有商品，共 ${result.data.count} 件`);
    }
  }

  async function syncNewOnlineProducts(): Promise<void> {
    const lastSyncAt = window.localStorage.getItem(`online-products-last-sync:${activeStoreId}`);
    const result = await onlineQuery.refetch();
    if (!result.data) return;
    const newCount = lastSyncAt
      ? result.data.items.filter((item) => item.createdAt && item.createdAt > lastSyncAt).length
      : result.data.count;
    window.localStorage.setItem(`online-products-last-sync:${activeStoreId}`, result.data.readAt);
    setSyncMessage(lastSyncAt ? `本次发现 ${newCount} 件新增商品` : `首次同步已读取 ${newCount} 件商品，并建立同步时间基准`);
  }

  /** Opens a Goldminer-matched batch editor with the currently selected card values. */
  function openOnlineBatchAction(action: OnlineBatchAction): void {
    setOnlineBatchResult(null);
    setPriceEdits(Object.fromEntries(selectedOnlineItems.map((item) => [item.productId, { price: item.price ?? "", oldPrice: item.oldPrice ?? "", minimumPrice: item.minimumPrice ?? "" }])));
    setStockEdits(Object.fromEntries(selectedOnlineItems.map((item) => [item.productId, "0"])));
    setSourceEdits(Object.fromEntries(selectedOnlineItems.map((item) => [item.productId, item.sourceUrl ?? ""])));
    setWarehouseId("");
    setBatchAction(action);
  }

  return <main className="publish-records-page">
    <header className="publish-records-heading"><div><p className="eyebrow">PRODUCT OPERATIONS</p><h1>{title}</h1><p>{props.mode === "online" ? "读取目标 Ozon 店铺当前商品卡列表。" : props.mode === "uploaded" ? "按发布任务查看商品组与各变体的提交结果。" : "展示已创建商品的分发候选记录；目标店铺写入需在确认后执行。"}</p></div>{props.mode !== "online" && <button className="secondary-button" type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? "is-spinning" : undefined} />刷新</button>}</header>
    <section className="publish-records-panel">
      {props.mode === "online" ? <>
        <div className="publish-records-filters publish-online-filters">
          <label><span>目标店铺</span><select value={activeStoreId} onChange={(event) => { setStoreId(event.target.value); setSelectedProductIds([]); }}><option value="">请选择店铺</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>
          <label><span>商品名称</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名称" /></label>
          <label><span>货号 / SKU</span><input value={offerSearch} onChange={(event) => setOfferSearch(event.target.value)} placeholder="货号 / SKU" /></label>
          <label><span>最低售价 ₽</span><input inputMode="decimal" value={minimumPrice} onChange={(event) => setMinimumPrice(event.target.value)} placeholder="最低售价" /></label>
          <label><span>最高售价 ₽</span><input inputMode="decimal" value={maximumPrice} onChange={(event) => setMaximumPrice(event.target.value)} placeholder="最高售价" /></label>
          <label><span>最低重量 g</span><input inputMode="decimal" value={minimumWeight} onChange={(event) => setMinimumWeight(event.target.value)} placeholder="最低重量" /></label>
          <label><span>最高重量 g</span><input inputMode="decimal" value={maximumWeight} onChange={(event) => setMaximumWeight(event.target.value)} placeholder="最高重量" /></label>
          <label><span>创建日期起</span><input type="date" value={createdFrom} onChange={(event) => setCreatedFrom(event.target.value)} /></label>
          <label><span>创建日期止</span><input type="date" value={createdTo} onChange={(event) => setCreatedTo(event.target.value)} /></label>
          <span className="publish-records-count">{onlineItems.length} 件商品</span>
        </div>
        <div className="publish-online-toolbar">
          <nav className="publish-online-tabs" aria-label="商品状态">{onlineStatusTabs.map((tab) => {
            const count = tab.id === "all" ? (onlineQuery.data?.count ?? 0) : (onlineQuery.data?.items ?? []).filter((item) => onlineStatusBucket(item) === tab.id).length;
            return <button className={onlineStatus === tab.id ? "is-active" : ""} key={tab.id} type="button" aria-pressed={onlineStatus === tab.id} onClick={() => setOnlineStatus(tab.id)}><span>{tab.label}</span><strong>{count}</strong></button>;
          })}</nav>
          <div className="publish-online-sync-actions"><span>已选 {selectedProductIds.length} 条</span><details className="publish-online-batch-menu"><summary className="secondary-button" aria-disabled={!selectedProductIds.length}>批量操作</summary><div role="menu"><button type="button" role="menuitem" disabled={!selectedProductIds.length} onClick={() => openOnlineBatchAction("price")}>批量改价</button><button type="button" role="menuitem" disabled={!selectedProductIds.length} onClick={() => openOnlineBatchAction("stock")}>批量改库存</button><button type="button" role="menuitem" disabled={!selectedProductIds.length} onClick={() => openOnlineBatchAction("source")}>批量改原产品链接</button><button type="button" role="menuitem" disabled={!selectedProductIds.length} onClick={() => openOnlineBatchAction("archive")}>批量归档</button></div></details><button className="secondary-button" type="button" disabled={!selectedProductIds.length || selectedSyncMutation.isPending} title="只对选中的商品进行同步" onClick={() => selectedSyncMutation.mutate()}>{selectedSyncMutation.isPending ? "同步中…" : "同步所选商品"}</button><button className="secondary-button" type="button" disabled={loading} title="对当前店铺所有商品进行信息同步" onClick={() => void syncAllOnlineProducts()}>同步所有商品</button><button className="secondary-button" type="button" disabled={loading} title="只统计上次同步后新建的商品" onClick={() => void syncNewOnlineProducts()}>同步新增商品</button><button className="icon-button" type="button" aria-label="刷新在线商品" onClick={() => void onlineQuery.refetch()} disabled={loading}><RefreshCw size={16} className={loading ? "is-spinning" : undefined} /></button></div>
        </div>
        {syncMessage && <p className="publish-records-sync-message" role="status">{syncMessage}</p>}
      </> : <div className="publish-records-filters">
        <label><span>目标店铺</span><select value={activeStoreId} onChange={(event) => setStoreId(event.target.value)}><option value="">所有店铺</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>
        {props.mode === "distribution" && <label><span>分发目标店铺</span><select multiple value={targetStoreIds} onChange={(event) => setTargetStoreIds(Array.from(event.target.selectedOptions, (option) => option.value))}>{stores.filter((store) => store.id !== activeStoreId).map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>}
        {props.mode === "uploaded" ? <label><span>上架状态</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="queued">排队中</option><option value="reviewing">审核中</option><option value="partial_failed">部分 SKU 失败</option><option value="needs_attention">状态待确认</option><option value="succeeded">上架成功</option><option value="failed">上架失败</option><option value="superseded">已被后续上架替代</option></select></label> : <label><span>任务状态</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部状态</option><option value="created">已创建</option><option value="moderating">审核中</option><option value="sellable">可售</option><option value="failed">失败</option><option value="needs_input">待补充</option><option value="pending">处理中</option></select></label>}
        {props.mode === "distribution" && <><label><span>开始日期</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label><span>结束日期</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></>}
        <label className="publish-records-search"><span>搜索商品</span><span className="publish-records-search__control"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="商品名称 / Offer ID / SKU" /></span></label>
        <span className="publish-records-count">{taskItems.length} 件商品</span>
      </div>}
      {(error || selectedSyncMutation.error) && <p className="field-error" role="alert">{(error || selectedSyncMutation.error)?.message}</p>}
      {props.mode === "distribution" && selectedTaskIds.length > 0 && <div className="publish-records-selected"><span>已选 {selectedTaskIds.length} 个商品</span><button className="primary-button" type="button" disabled={!targetStoreIds.length} onClick={() => setConfirmDistribution(true)}>批量分发</button></div>}
      {loading ? <div className="publish-records-empty"><RefreshCw className="is-spinning" />正在读取商品…</div> : props.mode === "online" ? onlineItems.length ? <><div className="publish-records-table-wrap"><table className="publish-records-table publish-records-table--online"><thead><tr><th><input type="checkbox" aria-label="选择当前页全部商品" checked={visibleOnlineItems.length > 0 && visibleOnlineItems.every((item) => selectedProductIds.includes(item.productId))} onChange={(event) => setSelectedProductIds((ids) => event.target.checked ? [...new Set([...ids, ...visibleOnlineItems.map((item) => item.productId)])] : ids.filter((id) => !visibleOnlineItems.some((item) => item.productId === id)))} /></th><th>商品信息</th><th>类目佣金</th><th>店铺</th><th>状态</th><th>价格</th><th>库存</th><th>重量</th><th>原产品链接</th><th>创建日期</th><th>操作</th></tr></thead><tbody>{visibleOnlineItems.map((item) => <tr key={`${item.productId}-${item.offerId}`}><td><input type="checkbox" aria-label={`选择 ${item.productName || item.offerId}`} checked={selectedProductIds.includes(item.productId)} onChange={(event) => setSelectedProductIds((ids) => event.target.checked ? [...ids, item.productId] : ids.filter((id) => id !== item.productId))} /></td><td><div className="publish-online-product-cell"><span className="publish-online-thumb">{item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : <Package size={18} />}</span><span><strong>{item.productName || "标题暂不可读"}</strong><small>Offer: {item.offerId} · SKU: {item.sku || "—"} · ID: {item.productId}</small></span></div></td><td>—</td><td>{stores.find((store) => store.id === activeStoreId)?.name || "—"}</td><td>{item.status || (item.archived === true ? "已归档" : "状态未知")}</td><td><div className="publish-online-price-cell"><strong>{item.price || "—"} {item.currencyCode || ""}</strong><small>划线价 {item.oldPrice || "—"} · 最低价 {item.minimumPrice || "—"}</small></div></td><td><div className="publish-online-price-cell"><span>{item.hasFboStocks === true ? "FBO 有货" : item.hasFboStocks === false ? "FBO 无货" : "FBO —"}</span><small>{item.hasFbsStocks === true ? "FBS 有货" : item.hasFbsStocks === false ? "FBS 无货" : "FBS —"}</small></div></td><td>{item.volumeWeight === null ? "—" : `${item.volumeWeight} g`}</td><td>{item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">打开来源</a> : "—"}</td><td>{item.createdAt ? new Date(item.createdAt).toLocaleDateString("zh-CN") : "—"}</td><td><button className="secondary-button publish-online-row-action" type="button" title="编辑本商品在 GMV 内保存的原产品跳转链接" onClick={() => { setSelectedProductIds([item.productId]); setSourceEdits({ [item.productId]: item.sourceUrl ?? "" }); setBatchAction("source"); }}>编辑链接</button></td></tr>)}</tbody></table></div><div className="publish-records-pagination"><span>共 {onlineItems.length} 条记录</span><select aria-label="每页条数" value={onlinePageSize} onChange={(event) => { setOnlinePageSize(Number(event.target.value)); setOnlinePage(1); }}><option value={10}>10 条/页</option><option value={20}>20 条/页</option><option value={30}>30 条/页</option><option value={50}>50 条/页</option></select><button type="button" aria-label="上一页" disabled={onlinePage <= 1} onClick={() => setOnlinePage((page) => Math.max(1, page - 1))}>‹</button><span>{Math.min(onlinePage, onlinePageCount)} / {onlinePageCount}</span><button type="button" aria-label="下一页" disabled={onlinePage >= onlinePageCount} onClick={() => setOnlinePage((page) => Math.min(onlinePageCount, page + 1))}>›</button></div></> : <div className="publish-records-empty"><Package /><strong>没有匹配的在线商品</strong><span>{onlineQuery.data?.readAt ? `读取于 ${new Date(onlineQuery.data.readAt).toLocaleString("zh-CN")}` : "选择已配置的 Ozon 店铺后读取商品列表。"}</span></div> : taskGroups.length ? <div className="publish-records-table-wrap"><table className="publish-records-table"><thead><tr>{props.mode === "distribution" && <th>选择</th>}<th>图片</th><th>商品名称</th><th>Offer ID</th><th>SKU 数</th>{props.mode === "uploaded" ? <><th>来源</th><th>发布店铺</th><th>状态</th><th>错误信息</th></> : <><th>已上架店铺</th><th>最新上架时间</th><th>分发任务数</th></>}</tr></thead><tbody>{taskGroups.map(({ id, items, lead }) => { const isGroupSelected = items.every((item) => selectedTaskIds.includes(item.id)); return <tr key={id}>{props.mode === "distribution" && <td><input type="checkbox" aria-label={`选择 ${lead.productTitle || lead.targetOfferId}`} checked={isGroupSelected} onChange={(event) => setSelectedTaskIds((ids) => event.target.checked ? [...new Set([...ids, ...items.map((item) => item.id)])] : ids.filter((taskId) => !items.some((item) => item.id === taskId)))} /></td>}<td><span className="publish-online-thumb">{lead.imageUrl ? <img src={lead.imageUrl} alt="" loading="lazy" /> : <Package size={18} />}</span></td><td>{lead.productTitle || lead.sourceSku || "未命名商品"}</td><td>{items.map((item) => item.targetOfferId).join(" · ")}</td><td>{items.length}</td>{props.mode === "uploaded" ? <><td>{lead.sourceType === "public_page" ? "Ozon" : lead.sourceType === "1688_collector" ? "1688" : lead.sourceType}</td><td>{lead.storeName}</td><td><span className={`publish-records-status publish-records-status--${lead.status}`}>{items.every((item) => item.status === lead.status) ? lead.status : "部分完成"}</span></td><td>{items.flatMap((item) => item.lastError ? [item.lastError] : []).join("；") || "—"}</td></> : <><td>{lead.storeName}</td><td>{items.map((item) => item.updatedAt).sort().at(-1) ? new Date(items.map((item) => item.updatedAt).sort().at(-1)!).toLocaleString("zh-CN") : "—"}</td><td>{items.length}</td></>}</tr>; })}</tbody></table></div> : <div className="publish-records-empty"><ClipboardList /><strong>暂无{title}</strong><span>{props.mode === "distribution" ? "选择已成功创建的商品组，再选择目标店铺进行分发。" : "商品提交后会按变体记录任务结果。"}</span></div>}
      {onlineBatchResult && <section className="publish-batch-result" aria-live="polite"><strong>在线商品批量操作结果</strong>{(onlineBatchResult.updated ?? onlineBatchResult.archived ?? []).map((id) => <p key={id}>成功 · {selectedOnlineItems.find((item) => item.productId === id)?.productName || id}</p>)}{onlineBatchResult.skipped.map((item) => <p className="field-error" key={item.productId}>失败 · {selectedOnlineItems.find((product) => product.productId === item.productId)?.productName || item.productId} · {item.reason}</p>)}</section>}
      {distributionResult && <section className="publish-batch-result" aria-live="polite"><strong>分发任务结果</strong>{distributionResult.submitted.map((item) => <p key={`${item.sourceTaskId}-${item.targetStoreId}`}>已提交到 {stores.find((store) => store.id === item.targetStoreId)?.name || item.targetStoreId} · 任务 {item.taskId}</p>)}{distributionResult.skipped.map((item) => <p className="field-error" key={`${item.sourceTaskId}-${item.targetStoreId}`}>已跳过 · {item.reason}</p>)}</section>}
    </section>
    {confirmDistribution && <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="publish-distribution-confirm-title"><div className="dialog-heading"><div><p className="eyebrow">DISTRIBUTION</p><h2 id="publish-distribution-confirm-title">确认批量分发</h2></div><button className="icon-button" type="button" onClick={() => setConfirmDistribution(false)} aria-label="取消">×</button></div><p>将使用下列来源商品，在目标店铺创建新的上架任务。确认后会调用目标店铺 Seller API 写入商品、价格和库存。</p><ul>{taskItems.filter((item) => selectedTaskIds.includes(item.id)).map((item) => <li key={item.id}>{item.productTitle || item.targetOfferId} · 来源店铺 {item.storeName}</li>)}</ul><ul>{targetStoreIds.map((id) => <li key={id}>目标店铺：{stores.find((store) => store.id === id)?.name || id}</li>)}</ul>{distributionMutation.error && <p className="field-error" role="alert">{distributionMutation.error.message}</p>}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setConfirmDistribution(false)}>取消</button><button className="primary-button" type="button" disabled={distributionMutation.isPending} onClick={() => distributionMutation.mutate()}>{distributionMutation.isPending ? "提交分发任务…" : "确认分发"}</button></div></section></div>}
    {batchAction && <div className="dialog-backdrop" role="presentation"><section className="dialog publish-online-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="publish-online-batch-title"><div className="dialog-heading"><div><p className="eyebrow">ONLINE PRODUCTS</p><h2 id="publish-online-batch-title">{onlineBatchLabels[batchAction]}</h2></div><button className="icon-button" type="button" onClick={() => setBatchAction(null)} aria-label="关闭">×</button></div>
      {batchAction === "source" && <p>仅修改 GMV 中的原产品跳转链接，不修改 Ozon 平台商品内容。</p>}
      {batchAction === "archive" && <p>确认归档当前 Ozon 店铺选中的 {selectedOnlineItems.length} 个商品？归档会调用 Seller API。</p>}
      {batchAction === "price" && <p>店铺：{stores.find((store) => store.id === activeStoreId)?.name || activeStoreId} · 将修改 {selectedOnlineItems.length} 个商品的售价、划线价和最低价。</p>}
      {batchAction === "stock" && <><p>店铺：{stores.find((store) => store.id === activeStoreId)?.name || activeStoreId} · 将修改 {selectedOnlineItems.length} 个商品的仓库库存。</p><label className="publish-batch-warehouse"><span>仓库</span><select value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}><option value="">请选择仓库</option>{(warehousesQuery.data ?? []).map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></label>{warehousesQuery.error && <p className="field-error" role="alert">{warehousesQuery.error.message}</p>}</>}
      <div className="publish-online-batch-rows">{selectedOnlineItems.map((item) => <article key={item.productId}><div className="publish-online-batch-product"><span className="publish-online-thumb">{item.imageUrl ? <img src={item.imageUrl} alt="" /> : <Package size={18} />}</span><span><strong>{item.productName || item.offerId}</strong><small>{item.offerId} · {item.productId}</small></span></div>
        {batchAction === "price" && <div className="publish-online-batch-fields">{(["price", "oldPrice", "minimumPrice"] as const).map((field) => <label key={field}><span>{field === "price" ? "售价" : field === "oldPrice" ? "划线价" : "最低价"}</span><input inputMode="decimal" value={priceEdits[item.productId]?.[field] ?? ""} onChange={(event) => setPriceEdits((current) => ({ ...current, [item.productId]: { ...current[item.productId]!, [field]: event.target.value } }))} /></label>)}</div>}
        {batchAction === "stock" && <label className="publish-online-batch-stock"><span>库存数</span><input type="number" min="0" step="1" value={stockEdits[item.productId] ?? "0"} onChange={(event) => setStockEdits((current) => ({ ...current, [item.productId]: event.target.value }))} /></label>}
        {batchAction === "source" && <label className="publish-online-batch-source"><span>新跳转链接</span><input type="url" value={sourceEdits[item.productId] ?? ""} placeholder="https://…" onChange={(event) => setSourceEdits((current) => ({ ...current, [item.productId]: event.target.value }))} /></label>}
      </article>)}</div>
      {onlineBatchMutation.error && <p className="field-error" role="alert">{onlineBatchMutation.error.message}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setBatchAction(null)}>取消</button><button className="primary-button" type="button" disabled={onlineBatchMutation.isPending || (batchAction === "stock" && !warehouseId) || (batchAction === "source" && selectedOnlineItems.some((item) => { const url = sourceEdits[item.productId]?.trim() ?? ""; return Boolean(url) && !/^https?:\/\//i.test(url); })) || (batchAction === "price" && selectedOnlineItems.some((item) => !/^\d+(\.\d+)?$/.test(priceEdits[item.productId]?.price ?? "")))} onClick={() => onlineBatchMutation.mutate()}>{onlineBatchMutation.isPending ? "处理中…" : <>{batchAction === "archive" && <Archive size={15} />}{onlineBatchConfirmLabels[batchAction]}</>}</button></div></section></div>}
  </main>;
}
