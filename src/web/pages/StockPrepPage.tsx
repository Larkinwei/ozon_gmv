import { AlertTriangle, Check, Link2, PackageCheck, RefreshCw, ShoppingCart } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { OrderImagePreview } from "../components/OrderImagePreview";
import { beginStockPrepFeishuAuthorization, createStockPrepBatch, fetchStockPrepBatch, fetchStockPrepConnection, fetchStockPrepState, fetchStores, resetStockPrepOrders, resolveUncertainStockPrepOrders, saveStockPrepDropshipSuppliers, saveStockPrepFeishuApp, saveStockPrepSource, scanStockPrep, type StockPrepOrderKey, type StockPrepScan } from "../api";

const statusNames: Record<string, string> = { pending: "待采购", adding: "加购中", added: "已加购", failed: "加购失败", uncertain: "待核实", unmatched: "未匹配", queued: "排队中", running: "执行中", completed: "已完成", completed_with_errors: "部分异常" };
type StockPrepTab = "pending" | "added" | "config";
const LAST_STORE_KEY = "ozon-gmv.stock-prep.last-store";
function updateScanOrders(scan: StockPrepScan, keys: StockPrepOrderKey[], state: string, error: string | null = null): StockPrepScan {
  const changed = new Set(keys.map(keyOf));
  const groups = scan.groups.map((group) => {
    const orders = group.orders.map((order) => changed.has(keyOf(order)) ? { ...order, state, error, selectedByDefault: state === "pending" } : order);
    const states = new Set(orders.map((order) => order.state));
    const status = states.size === 1 ? orders[0]?.state ?? group.status : states.has("unmatched") ? "unmatched" : states.has("adding") ? "adding" : "pending";
    return { ...group, orders, status, quantity: orders.reduce((sum, order) => sum + order.quantity, 0) };
  });
  return { ...scan, groups };
}

/** Lets operators review FBS/realFBS awaiting-packaging orders before adding them to 1688. */
export default function StockPrepPage(): React.JSX.Element {
  const client = useQueryClient();
  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores });
  const stores = (storesQuery.data ?? []).filter((store) => store.platform === "ozon" && store.enabled);
  const [storeId, setStoreId] = useState(() => window.localStorage.getItem(LAST_STORE_KEY) ?? "");
  const [sourceUrl, setSourceUrl] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [dropshipSupplierText, setDropshipSupplierText] = useState<string | null>(null);
  const [authorizationLink, setAuthorizationLink] = useState<{ url: string; qrCode: string } | null>(null);
  const [scan, setScan] = useState<StockPrepScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedForReset, setSelectedForReset] = useState<Set<string>>(new Set());
  const [batchId, setBatchId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<StockPrepTab>("pending");
  const [scannedStoreId, setScannedStoreId] = useState<string | null>(null);
  const stateQuery = useQuery({ queryKey: ["stock-prep-state", storeId], queryFn: () => fetchStockPrepState(storeId), enabled: Boolean(storeId) });
  const connectionQuery = useQuery({ queryKey: ["stock-prep-connection"], queryFn: fetchStockPrepConnection, refetchInterval: (query) => query.state.data?.feishu.authorization?.state === "pending" ? 1500 : 15000 });
  const batchQuery = useQuery({ queryKey: ["stock-prep-batch", batchId], queryFn: () => fetchStockPrepBatch(batchId!), enabled: Boolean(batchId), refetchInterval: (query) => ["queued", "running"].includes(query.state.data?.status ?? "") ? 1000 : false });
  const saveMutation = useMutation({ mutationFn: () => saveStockPrepSource(storeId, sourceUrl.trim()), onSuccess: async () => { setScan(null); setScannedStoreId(null); setMessage("飞书 SKU 表已验证并保存"); await client.invalidateQueries({ queryKey: ["stock-prep-state", storeId] }); } });
  const scanMutation = useMutation({ mutationFn: ({ targetStoreId, forceRefresh }: { targetStoreId: string; forceRefresh: boolean }) => scanStockPrep(targetStoreId, forceRefresh), onSuccess: (value) => { setScan(value); setScannedStoreId(value.storeId); setActiveTab("pending"); setSelected(new Set(value.groups.flatMap((group) => group.orders.filter((order) => order.selectedByDefault).map((order) => keyOf({ postingNumber: order.postingNumber, offerId: order.offerId }))))); setSelectedForReset(new Set()); setMessage(null); }, onError: (error) => setMessage(error.message) });
  const batchMutation = useMutation({ mutationFn: (keys: StockPrepOrderKey[]) => createStockPrepBatch(storeId, keys), onSuccess: async (value) => { setBatchId(value.id); setMessage("加购批次已启动"); await client.invalidateQueries({ queryKey: ["stock-prep-state", storeId] }); }, onError: (error) => setMessage(error.message) });
  const resetMutation = useMutation({ mutationFn: (keys: StockPrepOrderKey[]) => resetStockPrepOrders(storeId, keys), onSuccess: (result, keys) => { setMessage(`已撤回 ${result.resetCount} 笔订单的后台状态；1688 购物车数量未变`); setScan((current) => { if (!current) return current; return updateScanOrders(current, keys, "pending"); }); setSelected((current) => new Set([...current, ...keys.map(keyOf)])); setSelectedForReset(new Set()); } });
  const resolveMutation = useMutation({ mutationFn: (keys: StockPrepOrderKey[]) => resolveUncertainStockPrepOrders(storeId, keys), onSuccess: (result, keys) => { setMessage(`已将 ${result.resolvedCount} 笔订单标为加购失败，可在核对购物车后重试`); setScan((current) => { if (!current) return current; return updateScanOrders(current, keys, "failed", "人工核对购物车后确认未增加数量"); }); }, onError: (error) => setMessage(error.message) });
  const feishuAppMutation = useMutation({ mutationFn: () => saveStockPrepFeishuApp(appId, appSecret), onSuccess: async () => { setAppSecret(""); setMessage("飞书应用凭证已加密保存"); await client.invalidateQueries({ queryKey: ["stock-prep-connection"] }); }, onError: (error) => setMessage(error.message) });
  const dropshipSuppliersMutation = useMutation({ mutationFn: () => saveStockPrepDropshipSuppliers((dropshipSupplierText ?? connection?.dropshipSuppliers.join("\n") ?? "").split(/\r?\n/u)), onSuccess: async ({ suppliers }) => { setDropshipSupplierText(suppliers.join("\n")); setMessage("代发供应商名单已保存"); await client.invalidateQueries({ queryKey: ["stock-prep-connection"] }); }, onError: (error) => setMessage(error.message) });
  const feishuAuthMutation = useMutation({ mutationFn: beginStockPrepFeishuAuthorization, onSuccess: (value) => { setAuthorizationLink({ url: value.verificationUrl, qrCode: value.qrCode }); setMessage("已发起飞书设备授权，请用当前飞书账号扫码或打开链接确认"); void client.invalidateQueries({ queryKey: ["stock-prep-connection"] }); }, onError: (error) => setMessage(error.message) });
  const source = stateQuery.data?.source;
  const latestBatch = stateQuery.data?.latestBatch;
  const lastBatch = batchQuery.data ?? latestBatch;
  const displayBatch = lastBatch && ["queued", "running"].includes(lastBatch.status) ? lastBatch : null;
  const loadingMessage = storesQuery.isLoading ? "正在读取 Ozon 店铺…" : stateQuery.isLoading ? "正在读取店铺配置…" : scanMutation.isPending ? "正在扫描待打包订单并匹配 SKU…" : null;
  const connection = connectionQuery.data;
  const groups = scan?.groups ?? [];
  const pendingGroups = useMemo(() => groups.map((group) => { const orders = group.orders.filter((order) => order.state !== "added"); return { ...group, orders, quantity: orders.reduce((sum, order) => sum + order.quantity, 0) }; }).filter((group) => group.orders.length).sort((a, b) => Number(Boolean(b.skuId)) - Number(Boolean(a.skuId))), [groups]);
  const addedGroups = useMemo(() => groups.map((group) => { const orders = group.orders.filter((order) => order.state === "added"); return { ...group, orders, quantity: orders.reduce((sum, order) => sum + order.quantity, 0) }; }).filter((group) => group.orders.length), [groups]);
  const pendingOrderCount = pendingGroups.reduce((sum, group) => sum + group.orders.length, 0);
  const pendingPieceCount = pendingGroups.reduce((sum, group) => sum + group.quantity, 0);
  const addedOrderCount = addedGroups.reduce((sum, group) => sum + group.orders.length, 0);
  const addedPieceCount = addedGroups.reduce((sum, group) => sum + group.quantity, 0);
  const addedOrders = useMemo(() => addedGroups.flatMap((group) => group.orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId }))), [addedGroups]);
  const selectedResetOrders = useMemo(() => addedOrders.filter((order) => selectedForReset.has(keyOf(order))), [addedOrders, selectedForReset]);
  const allAddedOrdersSelected = addedOrders.length > 0 && selectedResetOrders.length === addedOrders.length;
  const selectedCount = selected.size;
  const selectedQuantity = groups.flatMap((group) => group.orders.map((order) => ({ group, order }))).filter(({ order }) => selected.has(keyOf(order))).reduce((total, { order }) => total + order.quantity, 0);
  const groupedStatus = useMemo(() => groups.reduce((counts, group) => { counts[group.status] = (counts[group.status] ?? 0) + 1; return counts; }, {} as Record<string, number>), [groups]);

  useEffect(() => { if (source && !sourceUrl) setSourceUrl(source.url); }, [source, sourceUrl]);
  useEffect(() => {
    if (!stores.length) return;
    if (storeId && stores.some((store) => store.id === storeId)) return;
    const remembered = window.localStorage.getItem(LAST_STORE_KEY);
    setStoreId(remembered && stores.some((store) => store.id === remembered) ? remembered : stores[0]!.id);
  }, [stores, storeId]);
  useEffect(() => {
    if (storeId) window.localStorage.setItem(LAST_STORE_KEY, storeId);
  }, [storeId]);
  useEffect(() => {
    if (!storeId || scan || scanMutation.isPending || scannedStoreId === storeId) return;
    if (!source) return;
    scanMutation.mutate({ targetStoreId: storeId, forceRefresh: false });
  }, [storeId, source, scan, scanMutation.isPending, scannedStoreId]);
  useEffect(() => { if (latestBatch && ["queued", "running"].includes(latestBatch.status)) setBatchId(latestBatch.id); }, [latestBatch]);
  useEffect(() => {
    const auth = connection?.feishu.authorization;
    if (!authorizationLink || !auth || auth.state === "pending") return;
    setMessage(auth.state === "complete" ? "飞书授权完成" : auth.message ?? "飞书授权失败");
    void connectionQuery.refetch();
  }, [connection?.feishu.authorization?.state]);
  useEffect(() => {
    if (batchQuery.data && ["completed", "completed_with_errors"].includes(batchQuery.data.status)) {
      setSelected(new Set());
      setActiveTab("added");
      void client.invalidateQueries({ queryKey: ["stock-prep-state", storeId] });
      const itemStates = batchQuery.data.items.flatMap((item) => {
        if (!item.order_keys_json) return [];
        const state = item.status === "added" ? "added" : item.status === "uncertain" ? "uncertain" : "failed";
        return (JSON.parse(item.order_keys_json) as string[]).map((key) => ({ key, state, error: item.error }));
      });
      setScan((current) => {
        if (!current) return current;
        let updated = current;
        for (const item of itemStates) {
          const [postingNumber, offerId] = item.key.split("\u0000");
          if (postingNumber && offerId) updated = updateScanOrders(updated, [{ postingNumber, offerId }], item.state, item.error);
        }
        return updated;
      });
    }
  }, [batchQuery.data?.status]);

  function toggleOrder(key: StockPrepOrderKey, checked: boolean): void {
    setSelected((current) => { const next = new Set(current); const id = keyOf(key); if (checked) next.add(id); else next.delete(id); return next; });
  }

  function submitCart(): void {
    const keys = [...selected].map((key) => { const [postingNumber, offerId] = key.split("\u0000"); return { postingNumber: postingNumber!, offerId: offerId! }; });
    if (keys.length && window.confirm(`将所选 ${keys.length} 笔订单按 SKU 汇总后加入 1688 购物车，预计 ${selectedQuantity} 件。继续吗？`)) batchMutation.mutate(keys);
  }

  function resetOrders(keys: StockPrepOrderKey[]): void {
    if (keys.length && window.confirm(`将 ${keys.length} 笔订单改回待采购。1688 购物车不会扣减，再次加购会继续累加。继续吗？`)) resetMutation.mutate(keys);
  }

  function resolveUncertain(keys: StockPrepOrderKey[]): void {
    if (keys.length && window.confirm(`请先在 1688 购物车确认对应规格数量没有增加。确认后这些待核实订单会改为“加购失败”，之后可再次加购；如果购物车实际已增加，重试会造成重复采购。确认购物车未增加吗？`)) resolveMutation.mutate(keys);
  }

  return <main className="admin-main stock-prep-main">
      <div className="page-title-row stock-prep-title"><div><p className="eyebrow">STOCK PREPARATION</p><h2>采购备货</h2><p>扫描待打包订单，按 1688 规格汇总后人工确认加入采购车。</p><small className="stock-prep-cache-hint">Ozon 订单同步缓存 1 小时；需要最新订单时可手动刷新。</small></div><div className="stock-prep-store-picker"><label className="field"><span>Ozon 店铺</span><select aria-label="Ozon 店铺" value={storeId} onChange={(event) => { const nextStoreId = event.target.value; setStoreId(nextStoreId); setSourceUrl(""); setScan(null); setScannedStoreId(null); setSelected(new Set()); setSelectedForReset(new Set()); setBatchId(null); }}><option value="">选择店铺</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label><button className="secondary-button" type="button" disabled={!storeId || scanMutation.isPending || !source} onClick={() => scanMutation.mutate({ targetStoreId: storeId, forceRefresh: true })}><RefreshCw size={16} className={scanMutation.isPending ? "sync-spinner" : undefined}/>{scanMutation.isPending ? "正在扫描…" : "刷新订单"}</button></div></div>
      {message && <div className="notice notice--success" role="status">{message}</div>}
      {storesQuery.isError && <div className="field-error" role="alert">{storesQuery.error.message}</div>}
      <nav className="stock-prep-tabs" aria-label="采购备货页面"><button className={activeTab === "pending" ? "is-active" : ""} onClick={() => setActiveTab("pending")} type="button">待采购{scan ? ` · ${pendingOrderCount} 单 · ${pendingPieceCount} 件` : ""}</button><button className={activeTab === "added" ? "is-active" : ""} onClick={() => setActiveTab("added")} type="button">已加购{scan ? ` · ${addedOrderCount} 单 · ${addedPieceCount} 件` : ""}</button><button className={activeTab === "config" ? "is-active" : ""} onClick={() => setActiveTab("config")} type="button">配置</button></nav>
      {activeTab !== "config" && loadingMessage && <section className="stock-prep-loading" role="status" aria-live="polite" aria-busy="true"><RefreshCw size={22} className="sync-spinner"/><div><strong>{loadingMessage}</strong><small>页面加载完成后会显示订单和匹配结果，请稍候。</small></div></section>}
      {activeTab === "config" && <>
      <section className="settings-card stock-prep-connection">
        <div className="stock-prep-connection-title"><div><p className="eyebrow">CONNECTIONS</p><h3>连接状态</h3></div><button className="secondary-button" type="button" onClick={() => void connectionQuery.refetch()}>刷新状态</button></div>
        <div className="stock-prep-health"><span className={connection?.feishu.connected ? "is-ready" : ""}><i/>{connection?.feishu.connected ? `飞书已授权 · ${connection.feishu.userName ?? connection.feishu.profile}` : connection?.feishu.message ?? "正在检查飞书…"}</span><span className={connection?.browserBridge.ready ? "is-ready" : ""}><i/>{connection?.browserBridge.ready ? "Browser Bridge 已连接" : connection?.browserBridge.message ?? "正在检查 Browser Bridge…"}</span><span><i/>{`已配置 ${connection?.configuredStoreCount ?? 0} 家店铺 SKU 表`}</span></div>
        {connection?.platform === "win32" && <div className="stock-prep-feishu-config"><p>Windows 服务账户需使用飞书自建应用授权多维表格。App Secret 只写入加密存储，不会回显。</p><label className="field"><span>飞书 App ID</span><input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_…" autoComplete="off"/></label><label className="field"><span>飞书 App Secret</span><input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={connection.feishu.appSecretConfigured ? "已配置；留空不修改" : "粘贴 App Secret"} autoComplete="new-password"/></label><div className="stock-prep-actions"><button className="secondary-button" type="button" disabled={!appId.trim() || !appSecret.trim() || feishuAppMutation.isPending} onClick={() => feishuAppMutation.mutate()}>加密保存应用凭证</button><button className="primary-button" type="button" disabled={!connection.feishu.appSecretConfigured || feishuAuthMutation.isPending || connection.feishu.connected} onClick={() => feishuAuthMutation.mutate()}>{feishuAuthMutation.isPending ? "正在发起…" : "使用飞书设备授权"}</button></div></div>}
        {connection?.platform !== "win32" && connection?.feishu.profile && !connection.feishu.connected && <button className="secondary-button" type="button" disabled={feishuAuthMutation.isPending} onClick={() => feishuAuthMutation.mutate()}>重新授权飞书用户身份</button>}
        {authorizationLink && <div className="stock-prep-auth"><img src={authorizationLink.qrCode} alt="飞书授权二维码"/><div><p>请使用要连接的飞书账号完成授权，授权范围为多维表格。</p><a href={authorizationLink.url} target="_blank" rel="noreferrer">打开飞书授权链接</a><p>{connection?.feishu.authorization?.message ?? "等待授权完成…"}</p>{connection?.feishu.authorization?.state === "complete" && <strong className="stock-prep-auth-success">授权完成，连接状态已刷新</strong>}{connection?.feishu.authorization?.state === "failed" && <strong className="field-error">授权失败，请重试</strong>}</div></div>}
      </section>
      <section className="stock-prep-setup settings-card">
        <label className="field stock-prep-url"><span>飞书 SKU 映射表</span><input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder={source?.url ?? "粘贴 YOGOLD SKU 库链接"} /><small>{source ? "已验证映射表；保存新链接会重新校验字段。" : "需包含货号、1688商品链接、1688 SKU ID 三个文本字段。"}</small></label>
        <div className="stock-prep-actions"><button className="secondary-button" type="button" disabled={!storeId || !sourceUrl.trim() || saveMutation.isPending} onClick={() => saveMutation.mutate()}><Link2 size={16}/>{saveMutation.isPending ? "正在验证…" : "验证并保存表格"}</button></div>
        <div className="stock-prep-health"><span className={connection?.feishu.connected ? "is-ready" : ""}><i/>飞书 {connection?.feishu.connected ? "已连接" : "未连接"}</span><span className={source ? "is-ready" : ""}><i/>店铺 SKU 表 {source ? "已配置" : "未配置"}</span><span className={connection?.browserBridge.ready ? "is-ready" : ""}><i/>{connection?.browserBridge.ready ? "Browser Bridge 已连接" : "Browser Bridge 未连接"}</span></div>
      </section>
      <section className="stock-prep-setup settings-card">
        <label className="field stock-prep-url"><span>1688 代发供应商名单</span><textarea rows={5} value={dropshipSupplierText ?? connection?.dropshipSuppliers.join("\n") ?? ""} onChange={(event) => setDropshipSupplierText(event.target.value)} placeholder={"每行填写一家，例如：\n安丘市鑫达尔服装厂\n其他供应商名称"}/><small>每行一家，不要用逗号分隔；空行忽略，重复项自动去重。最多 100 家，每个名称不超过 120 个字符。按商品页识别到的店铺名称匹配。</small></label>
        <div className="stock-prep-actions"><button className="secondary-button" type="button" disabled={dropshipSuppliersMutation.isPending} onClick={() => dropshipSuppliersMutation.mutate()}>{dropshipSuppliersMutation.isPending ? "正在保存…" : "保存代发供应商名单"}</button></div>
      </section>
      </>}
      {batchMutation.isPending && <section className="stock-prep-loading stock-prep-loading--preflight" role="status" aria-live="polite" aria-busy="true"><RefreshCw size={22} className="sync-spinner"/><div><strong>正在校验所选订单和飞书 SKU 映射…</strong><small>确认订单仍待备货、货号映射有效后才会启动 1688 操作。</small></div></section>}
      {activeTab !== "config" && displayBatch && <section className="settings-card stock-prep-batch"><div><strong>加购进度：{statusNames[String(displayBatch.status)] ?? displayBatch.status}</strong><span>{displayBatch.completed_count}/{displayBatch.total_count} 个 SKU 组</span></div><progress max={Math.max(displayBatch.total_count, 1)} value={displayBatch.completed_count}/>{displayBatch.items.find((item) => item.status === "running") && <p>当前商品：{displayBatch.items.find((item) => item.status === "running")!.offer_id} · SKU {displayBatch.items.find((item) => item.status === "running")!.sku_id}</p>}</section>}
      {activeTab === "pending" && scan && <>
        <section className="stock-prep-summary"><div><PackageCheck size={19}/><strong>{pendingGroups.length}</strong><span>个 SKU 组</span></div>{Object.entries(groupedStatus).map(([status, count]) => <div key={status}><span>{statusNames[status] ?? status}</span><strong>{count}</strong></div>)}<button className="primary-button" type="button" disabled={!selectedCount || batchMutation.isPending || ["queued","running"].includes(batchQuery.data?.status ?? "")} onClick={submitCart}><ShoppingCart size={17}/>{batchMutation.isPending ? "正在校验…" : `加购所选 ${selectedCount} 笔 · ${selectedQuantity} 件`}</button></section>
        <div className="stock-prep-groups">{pendingGroups.map((group, index) => <section className="settings-card stock-prep-group" key={`${group.offerUrl}-${group.skuId}-${index}`}>
          <header><div><p className="eyebrow">{statusNames[group.status] ?? group.status}</p><h3>{group.offerId} <small>· {group.orders.length} 单 · {group.quantity} 件待备</small></h3></div><span className={`stock-prep-state stock-prep-state--${group.status}`}>{statusNames[group.status] ?? group.status}</span>{group.offerUrl && <a href={group.offerUrl} target="_blank" rel="noreferrer">1688 商品</a>}{group.orders.some((order) => ["added", "failed"].includes(order.state)) && <button className="secondary-button compact-button" type="button" onClick={() => resetOrders(group.orders.filter((order) => ["added", "failed"].includes(order.state)).map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))}>撤回本组状态</button>}{group.orders.some((order) => order.state === "uncertain") && <button className="secondary-button compact-button" type="button" onClick={() => resolveUncertain(group.orders.filter((order) => order.state === "uncertain").map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))}>核对购物车未增加</button>}</header>
          <div className="stock-prep-product"><OrderImagePreview src={group.imageUrl} alt={`${group.offerId} 商品主图`} fallbackLabel="暂无商品图" width={58} height={58} className="stock-prep-product-image" placeholderClassName="stock-prep-product-image stock-prep-product-image--empty"/><div>{group.skuId ? <p className="stock-prep-sku">1688 SKU ID：<code>{group.skuId}</code></p> : <p className="stock-prep-warning"><AlertTriangle size={16}/>{group.error}</p>}</div></div>
          <div className="table-scroll"><table className="stock-prep-orders"><thead><tr><th>选择</th><th>Ozon 订单号</th><th>货号</th><th>商品</th><th>件数</th><th>状态</th><th>操作</th></tr></thead><tbody>{group.orders.map((order) => { const key = { postingNumber: order.postingNumber, offerId: order.offerId }; const selectable = ["pending", "failed"].includes(order.state) && Boolean(group.skuId); return <tr key={keyOf(key)}><td><input type="checkbox" checked={selected.has(keyOf(key))} disabled={!selectable} onChange={(event) => toggleOrder(key, event.target.checked)} aria-label={`选择订单 ${order.postingNumber}`}/></td><td>{order.postingNumber}</td><td>{order.offerId}</td><td>{order.productName}</td><td>{order.quantity}</td><td>{statusNames[order.state] ?? order.state}{order.error ? ` · ${order.error}` : ""}</td><td>{order.state === "uncertain" && <button className="secondary-button compact-button" type="button" onClick={() => resolveUncertain([key])}>核对未增加</button>}{["added", "failed"].includes(order.state) && <button className="secondary-button compact-button" type="button" onClick={() => resetOrders([key])}>撤回</button>}</td></tr>; })}</tbody></table></div>
        </section>)}</div>
      </>}
      {activeTab === "added" && scan && (addedGroups.length ? <><section className="stock-prep-summary"><label className="stock-prep-select-all"><input type="checkbox" checked={allAddedOrdersSelected} onChange={(event) => setSelectedForReset(event.target.checked ? new Set(addedOrders.map(keyOf)) : new Set())}/>全选已加购订单（{addedOrderCount} 单 · {addedPieceCount} 件）</label><button className="secondary-button" type="button" disabled={!selectedResetOrders.length || resetMutation.isPending} onClick={() => resetOrders(selectedResetOrders)}>{resetMutation.isPending ? "撤回中…" : `批量撤回 ${selectedResetOrders.length} 笔`}</button></section><div className="stock-prep-groups">{addedGroups.map((group, index) => <section className="settings-card stock-prep-group" key={`${group.offerUrl}-${group.skuId}-${index}`}><header><div><p className="eyebrow">已加购</p><h3>{group.offerId} <small>· {group.orders.length} 单 · {group.quantity} 件</small></h3></div><span className="stock-prep-state stock-prep-state--added">已加购</span>{group.offerUrl && <a href={group.offerUrl} target="_blank" rel="noreferrer">1688 商品</a>}<button className="secondary-button compact-button" type="button" disabled={resetMutation.isPending} onClick={() => resetOrders(group.orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))}>撤回本组</button></header><div className="stock-prep-product"><OrderImagePreview src={group.imageUrl} alt={`${group.offerId} 商品主图`} fallbackLabel="暂无商品图" width={58} height={58} className="stock-prep-product-image" placeholderClassName="stock-prep-product-image stock-prep-product-image--empty"/><div>{group.skuId ? <p className="stock-prep-sku">1688 SKU ID：<code>{group.skuId}</code></p> : <p className="stock-prep-warning"><AlertTriangle size={16}/>{group.error}</p>}</div></div><div className="table-scroll"><table className="stock-prep-orders"><thead><tr><th>选择</th><th>Ozon 订单号</th><th>货号</th><th>商品</th><th>件数</th><th>状态</th><th>操作</th></tr></thead><tbody>{group.orders.map((order) => <tr key={keyOf(order)}><td><input type="checkbox" checked={selectedForReset.has(keyOf(order))} onChange={(event) => setSelectedForReset((current) => { const next = new Set(current); if (event.target.checked) next.add(keyOf(order)); else next.delete(keyOf(order)); return next; })} aria-label={`选择撤回订单 ${order.postingNumber}`}/></td><td>{order.postingNumber}</td><td>{order.offerId}</td><td>{order.productName}</td><td>{order.quantity}</td><td>已加购</td><td><button className="secondary-button compact-button" type="button" disabled={resetMutation.isPending} onClick={() => resetOrders([{ postingNumber: order.postingNumber, offerId: order.offerId }])}>撤回</button></td></tr>)}</tbody></table></div></section>)}</div></> : <div className="empty-store-state"><ShoppingCart size={34}/><h3>暂无已加购订单</h3><p>当前扫描结果中的已加购订单会显示在这里。</p></div>)}
      {!scan && activeTab === "pending" && !scanMutation.isPending && <div className="empty-store-state"><ShoppingCart size={34}/><h3>准备扫描订单</h3><p>请在“配置”标签选择店铺、配置 SKU 表并扫描。</p></div>}
      {batchQuery.isError && <div className="field-error" role="alert">批次状态读取失败：{batchQuery.error.message}</div>}
      {batchQuery.data?.status === "completed" && <div className="notice notice--success"><Check size={17}/>加购批次已完成</div>}
    </main>;
}

function keyOf(key: StockPrepOrderKey): string { return `${key.postingNumber}\u0000${key.offerId}`; }
