import { AlertTriangle, Check, Link2, PackageCheck, RefreshCw, ShoppingCart } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { beginStockPrepFeishuAuthorization, createStockPrepBatch, fetchStockPrepBatch, fetchStockPrepConnection, fetchStockPrepState, fetchStores, resetStockPrepOrders, resolveUncertainStockPrepOrders, saveStockPrepFeishuApp, saveStockPrepSource, scanStockPrep, type StockPrepOrderKey, type StockPrepScan } from "../api";
import { AppNav } from "../components/AppNav";

const statusNames: Record<string, string> = { pending: "待采购", adding: "加购中", added: "已加购", failed: "加购失败", uncertain: "待核实", unmatched: "未匹配", queued: "排队中", running: "执行中", completed: "已完成", completed_with_errors: "部分异常" };

/** Lets operators review FBS/realFBS awaiting-packaging orders before adding them to 1688. */
export default function StockPrepPage(): React.JSX.Element {
  const client = useQueryClient();
  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores });
  const stores = (storesQuery.data ?? []).filter((store) => store.platform === "ozon" && store.enabled);
  const [storeId, setStoreId] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [authorizationLink, setAuthorizationLink] = useState<{ url: string; qrCode: string } | null>(null);
  const [scan, setScan] = useState<StockPrepScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchId, setBatchId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const stateQuery = useQuery({ queryKey: ["stock-prep-state", storeId], queryFn: () => fetchStockPrepState(storeId), enabled: Boolean(storeId) });
  const connectionQuery = useQuery({ queryKey: ["stock-prep-connection"], queryFn: fetchStockPrepConnection, refetchInterval: (query) => query.state.data?.feishu.authorization?.state === "pending" ? 2000 : 15000 });
  const batchQuery = useQuery({ queryKey: ["stock-prep-batch", batchId], queryFn: () => fetchStockPrepBatch(batchId!), enabled: Boolean(batchId), refetchInterval: (query) => ["queued", "running"].includes(query.state.data?.status ?? "") ? 1000 : false });
  const saveMutation = useMutation({ mutationFn: () => saveStockPrepSource(storeId, sourceUrl.trim()), onSuccess: async () => { setMessage("飞书 SKU 表已验证并保存"); await client.invalidateQueries({ queryKey: ["stock-prep-state", storeId] }); } });
  const scanMutation = useMutation({ mutationFn: () => scanStockPrep(storeId), onSuccess: (value) => { setScan(value); setSelected(new Set(value.groups.flatMap((group) => group.orders.filter((order) => order.selectedByDefault).map((order) => keyOf({ postingNumber: order.postingNumber, offerId: order.offerId }))))); setMessage(null); }, onError: (error) => setMessage(error.message) });
  const batchMutation = useMutation({ mutationFn: (keys: StockPrepOrderKey[]) => createStockPrepBatch(storeId, keys), onSuccess: async (value) => { setBatchId(value.id); setMessage("加购批次已启动"); await client.invalidateQueries({ queryKey: ["stock-prep-state", storeId] }); }, onError: (error) => setMessage(error.message) });
  const resetMutation = useMutation({ mutationFn: (keys: StockPrepOrderKey[]) => resetStockPrepOrders(storeId, keys), onSuccess: (result) => { setMessage(`已撤回 ${result.resetCount} 笔订单的后台状态；1688 购物车数量未变`); void scanMutation.mutateAsync(); } });
  const resolveMutation = useMutation({ mutationFn: (keys: StockPrepOrderKey[]) => resolveUncertainStockPrepOrders(storeId, keys), onSuccess: (result) => { setMessage(`已将 ${result.resolvedCount} 笔订单标为加购失败，可在核对购物车后重试`); void scanMutation.mutateAsync(); }, onError: (error) => setMessage(error.message) });
  const feishuAppMutation = useMutation({ mutationFn: () => saveStockPrepFeishuApp(appId, appSecret), onSuccess: async () => { setAppSecret(""); setMessage("飞书应用凭证已加密保存"); await client.invalidateQueries({ queryKey: ["stock-prep-connection"] }); }, onError: (error) => setMessage(error.message) });
  const feishuAuthMutation = useMutation({ mutationFn: beginStockPrepFeishuAuthorization, onSuccess: (value) => { setAuthorizationLink({ url: value.verificationUrl, qrCode: value.qrCode }); setMessage("已发起飞书设备授权，请用当前飞书账号扫码或打开链接确认"); void client.invalidateQueries({ queryKey: ["stock-prep-connection"] }); }, onError: (error) => setMessage(error.message) });
  const source = stateQuery.data?.source;
  const latestBatch = stateQuery.data?.latestBatch;
  const displayBatch = batchQuery.data ?? latestBatch;
  const connection = connectionQuery.data;
  const groups = scan?.groups ?? [];
  const selectedCount = selected.size;
  const selectedQuantity = groups.flatMap((group) => group.orders.map((order) => ({ group, order }))).filter(({ order }) => selected.has(keyOf(order))).reduce((total, { order }) => total + order.quantity, 0);
  const groupedStatus = useMemo(() => groups.reduce((counts, group) => { counts[group.status] = (counts[group.status] ?? 0) + 1; return counts; }, {} as Record<string, number>), [groups]);

  useEffect(() => { if (source && !sourceUrl) setSourceUrl(source.url); }, [source, sourceUrl]);
  useEffect(() => { if (latestBatch && ["queued", "running"].includes(latestBatch.status)) setBatchId(latestBatch.id); }, [latestBatch]);
  useEffect(() => {
    if (batchQuery.data && ["completed", "completed_with_errors"].includes(batchQuery.data.status)) {
      setSelected(new Set());
      void client.invalidateQueries({ queryKey: ["stock-prep-state", storeId] });
      void scanMutation.mutateAsync();
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

  return <div className="admin-page">
    <header className="admin-header"><a className="brand-lockup" href="/dashboard"><div className="brand-mark">O</div><div><p className="eyebrow">OZON MULTI-STORE</p><h1>GMV 指挥中心</h1></div></a><AppNav /></header>
    <main className="admin-main stock-prep-main">
      <div className="page-title-row"><div><p className="eyebrow">STOCK PREPARATION</p><h2>采购备货</h2><p>扫描待打包订单，按 1688 规格汇总后人工确认加入采购车。</p></div></div>
      {message && <div className="notice notice--success" role="status">{message}</div>}
      {storesQuery.isError && <div className="field-error" role="alert">{storesQuery.error.message}</div>}
      <section className="settings-card stock-prep-connection">
        <div className="stock-prep-connection-title"><div><p className="eyebrow">CONNECTIONS</p><h3>连接状态</h3></div><button className="secondary-button" type="button" onClick={() => void connectionQuery.refetch()}>刷新状态</button></div>
        <div className="stock-prep-health"><span className={connection?.feishu.connected ? "is-ready" : ""}><i/>{connection?.feishu.connected ? `飞书已授权 · ${connection.feishu.userName ?? connection.feishu.profile}` : connection?.feishu.message ?? "正在检查飞书…"}</span><span className={connection?.browserBridge.ready ? "is-ready" : ""}><i/>{connection?.browserBridge.ready ? "Browser Bridge 已连接" : connection?.browserBridge.message ?? "正在检查 Browser Bridge…"}</span><span><i/>{`已配置 ${connection?.configuredStoreCount ?? 0} 家店铺 SKU 表`}</span></div>
        {connection?.platform === "win32" && <div className="stock-prep-feishu-config"><p>Windows 服务账户需使用飞书自建应用授权多维表格。App Secret 只写入加密存储，不会回显。</p><label className="field"><span>飞书 App ID</span><input value={appId} onChange={(event) => setAppId(event.target.value)} placeholder="cli_…" autoComplete="off"/></label><label className="field"><span>飞书 App Secret</span><input type="password" value={appSecret} onChange={(event) => setAppSecret(event.target.value)} placeholder={connection.feishu.appSecretConfigured ? "已配置；留空不修改" : "粘贴 App Secret"} autoComplete="new-password"/></label><div className="stock-prep-actions"><button className="secondary-button" type="button" disabled={!appId.trim() || !appSecret.trim() || feishuAppMutation.isPending} onClick={() => feishuAppMutation.mutate()}>加密保存应用凭证</button><button className="primary-button" type="button" disabled={!connection.feishu.appSecretConfigured || feishuAuthMutation.isPending || connection.feishu.connected} onClick={() => feishuAuthMutation.mutate()}>{feishuAuthMutation.isPending ? "正在发起…" : "使用飞书设备授权"}</button></div></div>}
        {connection?.platform !== "win32" && connection?.feishu.profile && !connection.feishu.connected && <button className="secondary-button" type="button" disabled={feishuAuthMutation.isPending} onClick={() => feishuAuthMutation.mutate()}>重新授权飞书用户身份</button>}
        {authorizationLink && <div className="stock-prep-auth"><img src={authorizationLink.qrCode} alt="飞书授权二维码"/><div><p>请使用要连接的飞书账号完成授权，授权范围为多维表格。</p><a href={authorizationLink.url} target="_blank" rel="noreferrer">打开飞书授权链接</a><p>{connection?.feishu.authorization?.message ?? "等待授权完成…"}</p></div></div>}
      </section>
      <section className="stock-prep-setup settings-card">
        <label className="field"><span>Ozon 店铺</span><select value={storeId} onChange={(event) => { setStoreId(event.target.value); setSourceUrl(""); setScan(null); setSelected(new Set()); setBatchId(null); }}><option value="">选择店铺</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>
        <label className="field stock-prep-url"><span>飞书 SKU 映射表</span><input type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder={source?.url ?? "粘贴 YOGOLD SKU 库链接"} /><small>{source ? "已验证映射表；保存新链接会重新校验字段。" : "需包含货号、1688商品链接、1688 SKU ID 三个文本字段。"}</small></label>
        <div className="stock-prep-actions"><button className="secondary-button" type="button" disabled={!storeId || !sourceUrl.trim() || saveMutation.isPending} onClick={() => saveMutation.mutate()}><Link2 size={16}/>{saveMutation.isPending ? "正在验证…" : "验证并保存表格"}</button><button className="primary-button" type="button" disabled={!storeId || !source || scanMutation.isPending} onClick={() => scanMutation.mutate()}><RefreshCw size={16} className={scanMutation.isPending ? "sync-spinner" : undefined}/>{scanMutation.isPending ? "正在扫描…" : "扫描待打包订单"}</button></div>
        <div className="stock-prep-health"><span className={connection?.feishu.connected ? "is-ready" : ""}><i/>飞书 {connection?.feishu.connected ? "已连接" : "未连接"}</span><span className={source ? "is-ready" : ""}><i/>店铺 SKU 表 {source ? "已配置" : "未配置"}</span><span className={connection?.browserBridge.ready ? "is-ready" : ""}><i/>{connection?.browserBridge.ready ? "Browser Bridge 已连接" : "Browser Bridge 未连接"}</span></div>
      </section>
      {displayBatch && <section className="settings-card stock-prep-batch"><div><strong>最近批次：{statusNames[String(displayBatch.status)] ?? displayBatch.status}</strong><span>完成 {displayBatch.completed_count}/{displayBatch.total_count}</span></div>{displayBatch.items.map((item) => <p key={item.id}>{item.offer_id} · SKU {item.sku_id} · {item.quantity} 件 · {statusNames[item.status] ?? item.status}{item.error ? ` · ${item.error}` : ""}</p>)}</section>}
      {scan && <>
        <section className="stock-prep-summary"><div><PackageCheck size={19}/><strong>{groups.length}</strong><span>个 SKU 组</span></div>{Object.entries(groupedStatus).map(([status, count]) => <div key={status}><span>{statusNames[status] ?? status}</span><strong>{count}</strong></div>)}<button className="primary-button" type="button" disabled={!selectedCount || batchMutation.isPending || ["queued","running"].includes(batchQuery.data?.status ?? "")} onClick={submitCart}><ShoppingCart size={17}/>{batchMutation.isPending ? "提交中…" : `加购所选 ${selectedCount} 笔 · ${selectedQuantity} 件`}</button></section>
        <div className="stock-prep-groups">{groups.map((group, index) => <section className="settings-card stock-prep-group" key={`${group.offerUrl}-${group.skuId}-${index}`}>
          <header><div><p className="eyebrow">{statusNames[group.status] ?? group.status}</p><h3>{group.offerId} <small>· {group.quantity} 件待备</small></h3></div><span className={`stock-prep-state stock-prep-state--${group.status}`}>{statusNames[group.status] ?? group.status}</span>{group.offerUrl && <a href={group.offerUrl} target="_blank" rel="noreferrer">1688 商品</a>}{group.orders.some((order) => ["added", "failed"].includes(order.state)) && <button className="secondary-button compact-button" type="button" onClick={() => resetOrders(group.orders.filter((order) => ["added", "failed"].includes(order.state)).map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))}>撤回本组状态</button>}{group.orders.some((order) => order.state === "uncertain") && <button className="secondary-button compact-button" type="button" onClick={() => resolveUncertain(group.orders.filter((order) => order.state === "uncertain").map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))}>核对购物车未增加</button>}</header>
          {group.skuId ? <p className="stock-prep-sku">1688 SKU ID：<code>{group.skuId}</code></p> : <p className="stock-prep-warning"><AlertTriangle size={16}/>{group.error}</p>}
          <div className="table-scroll"><table className="stock-prep-orders"><thead><tr><th>选择</th><th>Ozon 订单号</th><th>货号</th><th>商品</th><th>件数</th><th>状态</th><th>操作</th></tr></thead><tbody>{group.orders.map((order) => { const key = { postingNumber: order.postingNumber, offerId: order.offerId }; const selectable = ["pending", "failed"].includes(order.state) && Boolean(group.skuId); return <tr key={keyOf(key)}><td><input type="checkbox" checked={selected.has(keyOf(key))} disabled={!selectable} onChange={(event) => toggleOrder(key, event.target.checked)} aria-label={`选择订单 ${order.postingNumber}`}/></td><td>{order.postingNumber}</td><td>{order.offerId}</td><td>{order.productName}</td><td>{order.quantity}</td><td>{statusNames[order.state] ?? order.state}{order.error ? ` · ${order.error}` : ""}</td><td>{order.state === "uncertain" && <button className="secondary-button compact-button" type="button" onClick={() => resolveUncertain([key])}>核对未增加</button>}{["added", "failed"].includes(order.state) && <button className="secondary-button compact-button" type="button" onClick={() => resetOrders([key])}>撤回</button>}</td></tr>; })}</tbody></table></div>
        </section>)}</div>
      </>}
      {!scan && !scanMutation.isPending && <div className="empty-store-state"><ShoppingCart size={34}/><h3>准备扫描订单</h3><p>选择店铺并配置该店铺的飞书 SKU 表后开始。</p></div>}
      {batchQuery.isError && <div className="field-error" role="alert">批次状态读取失败：{batchQuery.error.message}</div>}
      {batchQuery.data?.status === "completed" && <div className="notice notice--success"><Check size={17}/>加购批次已完成</div>}
    </main>
  </div>;
}

function keyOf(key: StockPrepOrderKey): string { return `${key.postingNumber}\u0000${key.offerId}`; }
