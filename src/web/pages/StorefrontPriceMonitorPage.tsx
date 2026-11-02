import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, ChevronLeft, ChevronRight, Clock3, ExternalLink, ListFilter, Pause, Play, RefreshCw, Search, Square, Tags, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  createStorefrontPriceJob,
  createStorefrontPriceJobForStore,
  deleteStorefrontPriceItem,
  fetchLatestStorefrontPrices,
  fetchExchangeRate,
  fetchOnlineProducts,
  fetchStores,
  fetchStorefrontPriceHistory,
  fetchStorefrontPriceJob,
  fetchStorefrontPriceJobs,
  retryStorefrontPriceItem,
  updateStorefrontPriceJob,
  type StorefrontPriceItemStatus,
  type StorefrontPriceJobStatus,
  type StorefrontPriceSnapshot,
} from "../api";
import { OrderImagePreview } from "../components/OrderImagePreview";

const PAGE_SIZE = 20;
// 在线商品列表在 24 小时内复用页面缓存；手动刷新始终强制重新读取。
const ONLINE_PRODUCTS_CACHE_MS = 24 * 60 * 60 * 1000;
type ProductSort = "newest" | "sales30d" | "priceDesc" | "priceAsc";
type MonitorSection = "products" | "jobs" | "latest";
type LatestSort = "latest" | "differenceDesc" | "differenceAsc" | "greenDesc" | "greenAsc" | "backendDesc" | "backendAsc";
const productSortLabels: Record<ProductSort, string> = { newest: "最新上架优先", sales30d: "近30天已同步销量", priceDesc: "后台售价从高到低", priceAsc: "后台售价从低到高" };
const statusLabels: Record<StorefrontPriceJobStatus, string> = { queued: "排队中", running: "采集中", paused: "已暂停", completed: "已完成", cancelled: "已取消" };
const itemStatusLabels: Record<StorefrontPriceItemStatus, string> = { queued: "等待中", running: "采集中", success: "已采集", failed: "失败", no_data: "无前台价格", cancelled: "已取消" };
const latestSortLabels: Record<LatestSort, string> = { latest: "最新采集优先", differenceDesc: "差异金额从高到低", differenceAsc: "差异金额从低到高", greenDesc: "绿标价从高到低", greenAsc: "绿标价从低到高", backendDesc: "后台售价从高到低", backendAsc: "后台售价从低到高" };

function amountInCny(value: string | null, currency: string | null, rubPerCny: string | null): number | null {
  if (value === null || !currency) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (currency === "CNY") return amount;
  if (currency === "RUB" && rubPerCny && Number(rubPerCny) > 0) return amount / Number(rubPerCny);
  return null;
}

function money(value: string | null, currency: string | null, rubPerCny: string | null): string {
  const amount = amountInCny(value, currency, rubPerCny);
  return amount === null ? "—" : new Intl.NumberFormat("zh-CN", {
    style: "currency", currency: "CNY", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amount);
}

function priceDifference(front: string | null, frontCurrency: string | null, backend: string | null, currency: string | null, rubPerCny: string | null): string {
  const frontCny = amountInCny(front, frontCurrency, rubPerCny);
  const backendCny = amountInCny(backend, currency, rubPerCny);
  if (frontCny === null || backendCny === null) return "—";
  return money(Math.abs(frontCny - backendCny).toFixed(2), "CNY", rubPerCny);
}

interface PriceDifferenceProps {
  front: string | null;
  frontCurrency: string | null;
  backend: string | null;
  currency: string | null;
  rubPerCny: string | null;
}

/** Highlights comparable prices while keeping unavailable comparisons muted. */
function PriceDifference(props: PriceDifferenceProps): React.JSX.Element {
  const value = priceDifference(props.front, props.frontCurrency, props.backend, props.currency, props.rubPerCny);
  const tone = value === "—" ? "is-muted" : "is-difference";
  return <span className={`storefront-price-value ${tone}`}>{value}</span>;
}

function time(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

/** Builds the public Ozon product URL from the seller SKU, never from a source-link URL. */
function publicProductUrl(sku: string): string {
  return `https://www.ozon.ru/product/${encodeURIComponent(sku)}/`;
}

/** Provides batch collection, latest-price comparison, and per-product history. */
export default function StorefrontPriceMonitorPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [storeId, setStoreId] = useState("");
  const [section, setSection] = useState<MonitorSection>("products");
  const [search, setSearch] = useState("");
  const [latestSearch, setLatestSearch] = useState("");
  const [frontPriceFilter, setFrontPriceFilter] = useState<"all" | "available" | "missing">("all");
  const [differenceFilter, setDifferenceFilter] = useState<"all" | "higher" | "lower" | "equal" | "unavailable">("all");
  const [latestSort, setLatestSort] = useState<LatestSort>("latest");
  const [productSort, setProductSort] = useState<ProductSort>("newest");
  const [productPage, setProductPage] = useState(1);
  const [latestPage, setLatestPage] = useState(1);
  const [jobPage, setJobPage] = useState(1);
  const [selectedProducts, setSelectedProducts] = useState<string[]>([]);
  const [jobId, setJobId] = useState("");
  const [historyProductId, setHistoryProductId] = useState("");

  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores, staleTime: 30_000 });
  const stores = (storesQuery.data ?? []).filter((store) => store.enabled && store.platform === "ozon");
  useEffect(() => {
    if (!stores.some((store) => store.id === storeId)) setStoreId(stores[0]?.id ?? "");
  }, [storeId, stores]);

  const productsQuery = useQuery({ queryKey: ["storefront-prices", "products", storeId], queryFn: () => fetchOnlineProducts(storeId, "VISIBLE"), enabled: Boolean(storeId), staleTime: ONLINE_PRODUCTS_CACHE_MS, gcTime: ONLINE_PRODUCTS_CACHE_MS, refetchInterval: ONLINE_PRODUCTS_CACHE_MS });
  const refreshProductsMutation = useMutation({
    mutationFn: () => fetchOnlineProducts(storeId, "VISIBLE", undefined, true),
    onSuccess: (result) => queryClient.setQueryData(["storefront-prices", "products", storeId], result),
  });
  const products = productsQuery.data?.items ?? [];
  const filteredProducts = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const filtered = products.filter((product) => !term || [product.sku, product.offerId, product.productName].some((value) => value?.toLocaleLowerCase().includes(term)));
    return [...filtered].sort((left, right) => {
      if (productSort === "sales30d") return right.sales30d - left.sales30d;
      if (productSort === "priceDesc" || productSort === "priceAsc") {
        const direction = productSort === "priceDesc" ? -1 : 1;
        const leftPrice = left.price === null ? null : Number(left.price);
        const rightPrice = right.price === null ? null : Number(right.price);
        if (leftPrice === null || !Number.isFinite(leftPrice)) return rightPrice === null || !Number.isFinite(rightPrice) ? 0 : 1;
        if (rightPrice === null || !Number.isFinite(rightPrice)) return -1;
        return direction * (leftPrice - rightPrice);
      }
      const leftCreatedAt = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
      const rightCreatedAt = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
      if (!Number.isFinite(leftCreatedAt)) return Number.isFinite(rightCreatedAt) ? 1 : 0;
      if (!Number.isFinite(rightCreatedAt)) return -1;
      return rightCreatedAt - leftCreatedAt;
    });
  }, [products, productSort, search]);
  const productPages = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));
  const visibleProducts = filteredProducts.slice((productPage - 1) * PAGE_SIZE, productPage * PAGE_SIZE);

  const jobsQuery = useQuery({ queryKey: ["storefront-prices", "jobs"], queryFn: fetchStorefrontPriceJobs, refetchInterval: 5_000 });
  const exchangeRateQuery = useQuery({ queryKey: ["exchange-rate"], queryFn: fetchExchangeRate, staleTime: 60_000 });
  const rubPerCny = exchangeRateQuery.data?.available ? exchangeRateQuery.data.rate : null;
  const selectedJob = (jobsQuery.data ?? []).find((job) => job.id === jobId);
  useEffect(() => {
    if (selectedJob && selectedJob.storeId !== storeId && selectedJob.status !== "running" && selectedJob.status !== "queued") return;
    if (!jobId && jobsQuery.data?.[0]) setJobId(jobsQuery.data[0].id);
  }, [jobId, jobsQuery.data, selectedJob, storeId]);

  const jobQuery = useQuery({
    queryKey: ["storefront-prices", "job", jobId, jobPage],
    queryFn: () => fetchStorefrontPriceJob(jobId, jobPage, PAGE_SIZE),
    enabled: Boolean(jobId),
    refetchInterval: (query) => ["queued", "running"].includes(query.state.data?.status ?? "") ? 1_800 : false,
  });
  const latestQuery = useQuery({
    queryKey: ["storefront-prices", "latest", storeId, latestSearch, frontPriceFilter, differenceFilter, latestSort, latestPage],
    queryFn: () => fetchLatestStorefrontPrices({ storeId, search: latestSearch, frontPrice: frontPriceFilter, difference: differenceFilter, sort: latestSort, page: latestPage, pageSize: PAGE_SIZE }),
    enabled: Boolean(storeId),
    refetchInterval: 15_000,
  });
  const historyQuery = useQuery({ queryKey: ["storefront-prices", "history", storeId, historyProductId], queryFn: () => fetchStorefrontPriceHistory({ storeId, productId: historyProductId }), enabled: Boolean(storeId && historyProductId) });

  const createMutation = useMutation({
    mutationFn: async (scope: "all" | "selected") => {
      if (scope === "all") return { job: await createStorefrontPriceJobForStore(storeId) };
      const chosen = products.filter((product) => selectedProducts.includes(product.productId));
      const job = await createStorefrontPriceJob({ storeId, products: chosen.map((product) => ({ productId: product.productId, sku: product.sku, offerId: product.offerId, productName: product.productName, imageUrl: product.imageUrl, backendPrice: product.price, currencyCode: product.currencyCode })) });
      return { job };
    },
    onSuccess: async ({ job }) => {
      setJobId(job.id);
      setJobPage(1);
      setSelectedProducts([]);
      setSection("jobs");
      await queryClient.invalidateQueries({ queryKey: ["storefront-prices"] });
    },
  });
  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "pause" | "resume" | "cancel" }) => updateStorefrontPriceJob(id, action),
    onSuccess: async (job, variables) => {
      setJobId(job.id);
      setJobPage(1);
      await queryClient.invalidateQueries({ queryKey: ["storefront-prices"] });
    },
  });
  const retryMutation = useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) => retryStorefrontPriceItem(id, itemId),
    onSuccess: async ({ job }) => {
      setJobId(job.id);
      await queryClient.invalidateQueries({ queryKey: ["storefront-prices"] });
    },
  });
  const deleteItemMutation = useMutation({
    mutationFn: ({ id, itemId }: { id: string; itemId: string }) => deleteStorefrontPriceItem(id, itemId),
    onSuccess: async (updatedJob) => {
      setJobId(updatedJob.id);
      await queryClient.invalidateQueries({ queryKey: ["storefront-prices"] });
    },
  });

  function toggleProduct(productId: string): void {
    setSelectedProducts((current) => current.includes(productId) ? current.filter((id) => id !== productId) : [...current, productId]);
  }

  function toggleFilteredProducts(): void {
    const ids = filteredProducts.map((product) => product.productId);
    const allSelected = ids.length > 0 && ids.every((id) => selectedProducts.includes(id));
    setSelectedProducts((current) => allSelected ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])]);
  }

  const job = jobQuery.data;
  const history = historyQuery.data ?? [];
  const latest = latestQuery.data;

  return (
    <main className="admin-main storefront-price-page">
      <header className="finance-page-header storefront-price-header">
        <div><p className="eyebrow">STOREFRONT PRICE MONITOR</p><h1>前台价格监控</h1><p>批量查看自有在线商品的绿标价、黑标价，并与 Seller 后台售价对比。系统会识别前台实际币种：卢布按当前汇率换算成人民币，人民币不换算{rubPerCny ? `（¥1 = ₽${rubPerCny}${exchangeRateQuery.data?.effectiveDate ? `，${exchangeRateQuery.data.effectiveDate}` : ""}）` : "（当前汇率不可用时不转换卢布价格）"}；差额以人民币计算。</p></div>
        <div className="storefront-price-store-select"><label htmlFor="storefront-price-store">目标店铺</label><select id="storefront-price-store" value={storeId} onChange={(event) => { setStoreId(event.target.value); setSelectedProducts([]); setLatestPage(1); }} disabled={stores.length === 0}><option value="">请选择 Ozon 店铺</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</select></div>
      </header>

      {storesQuery.isError && <div className="storefront-price-alert is-error" role="alert"><AlertCircle size={17} />店铺列表读取失败，请刷新后重试。</div>}
      {stores.length === 0 && !storesQuery.isLoading && <div className="storefront-price-empty">没有已启用的 Ozon 店铺，请先到店铺管理中配置。</div>}

      <div className="storefront-price-tabs" role="tablist" aria-label="前台价格监控内容">
        <button type="button" role="tab" aria-selected={section === "products"} className={section === "products" ? "is-active" : ""} onClick={() => setSection("products")}>在线商品{productsQuery.data ? <span>{productsQuery.data.count}</span> : null}</button>
        <button type="button" role="tab" aria-selected={section === "jobs"} className={section === "jobs" ? "is-active" : ""} onClick={() => setSection("jobs")}>采集任务{jobsQuery.data ? <span>{jobsQuery.data.length}</span> : null}</button>
        <button type="button" role="tab" aria-selected={section === "latest"} className={section === "latest" ? "is-active" : ""} onClick={() => setSection("latest")}>最新前台价格{latest ? <span>{latest.total}</span> : null}</button>
      </div>

      {section === "products" && <section className="storefront-price-panel" role="tabpanel" aria-labelledby="storefront-products-title">
        <div className="finance-panel-heading"><div><p className="eyebrow">ONLINE PRODUCTS</p><h2 id="storefront-products-title">选择采集商品</h2><p className="storefront-price-list-note">只列在线商品，归档商品已排除。销量按本机近 30 天已同步、未取消订单统计，订单同步不完整时会偏低。商品列表每 24 小时自动更新一次，也可手动刷新。</p></div><span>{productsQuery.data ? `${productsQuery.data.count} 件在线商品 · 读取于 ${time(productsQuery.data.readAt)}` : ""}</span></div>
        <div className="storefront-price-toolbar">
          <label className="storefront-price-search"><Search size={16} /><input aria-label="搜索商品" placeholder="搜索商品名、SKU 或货号" value={search} onChange={(event) => { setSearch(event.target.value); setProductPage(1); }} /></label>
          <label className="storefront-price-sort">排序<select aria-label="商品排序方式" value={productSort} onChange={(event) => { setProductSort(event.target.value as ProductSort); setProductPage(1); }}>{Object.entries(productSortLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <span className="storefront-price-selected">已选 {selectedProducts.length} 件</span>
          <button className="secondary-button" type="button" onClick={toggleFilteredProducts} disabled={filteredProducts.length === 0}>{filteredProducts.length > 0 && filteredProducts.every((product) => selectedProducts.includes(product.productId)) ? `取消筛选结果（${filteredProducts.length}）` : `选择筛选结果（${filteredProducts.length}）`}</button>
          <button className="secondary-button" type="button" onClick={() => refreshProductsMutation.mutate()} disabled={!storeId || refreshProductsMutation.isPending} title="忽略 24 小时缓存，立即重新读取在线商品"><RefreshCw size={15} className={refreshProductsMutation.isPending ? "is-spinning" : undefined} />{refreshProductsMutation.isPending ? "正在刷新…" : "刷新在线商品"}</button>
          <button className="secondary-button" type="button" onClick={() => createMutation.mutate("selected")} disabled={!storeId || selectedProducts.length === 0 || createMutation.isPending}><Tags size={15} />采集所选</button>
          <button className="primary-button" type="button" onClick={() => createMutation.mutate("all")} disabled={!storeId || productsQuery.isLoading || productsQuery.isError || !products.length || createMutation.isPending}><Play size={15} />采集整店在线商品（{productsQuery.data?.count ?? "—"} 件）</button>
        </div>
        {createMutation.isError && <p className="storefront-price-error" role="alert">{createMutation.error instanceof Error ? createMutation.error.message : "无法创建采集任务"}</p>}
        {refreshProductsMutation.isError && <p className="storefront-price-error" role="alert">商品列表刷新失败：{refreshProductsMutation.error instanceof Error ? refreshProductsMutation.error.message : "请稍后重试"}</p>}
        {productsQuery.isLoading ? <div className="storefront-price-empty" aria-busy="true">正在读取店铺在线商品…</div> : productsQuery.isError ? <div className="storefront-price-empty is-error">在线商品读取失败：{productsQuery.error instanceof Error ? productsQuery.error.message : "请稍后重试"}</div> : filteredProducts.length === 0 ? <div className="storefront-price-empty">没有匹配的在线商品。</div> : (
          <div className="storefront-price-table-wrap"><table className="storefront-price-table"><thead><tr><th>选择</th><th>商品</th><th>Ozon SKU</th><th>上架时间</th><th>Seller 货号</th><th>近30天已同步销量</th><th>后台售价（¥）</th></tr></thead><tbody>{visibleProducts.map((product) => <tr key={product.productId}>
            <td><input aria-label={`选择 ${product.productName ?? product.offerId}`} type="checkbox" checked={selectedProducts.includes(product.productId)} onChange={() => toggleProduct(product.productId)} /></td>
            <td><div className="storefront-price-product"><OrderImagePreview src={product.imageUrl} alt={`${product.productName || product.offerId} 商品图`} fallbackLabel="商品暂无主图" width={44} height={44} className="storefront-price-product-image" placeholderClassName="storefront-price-product-placeholder" objectFit="contain" />{product.sku ? <a className="storefront-price-public-link" href={publicProductUrl(product.sku)} target="_blank" rel="noreferrer" title={product.productName ?? "打开 Ozon 前台商品页"}>{product.productName || "（无商品名称）"}<ExternalLink size={12} /></a> : <span title={product.productName ?? "商品名称缺失"}>{product.productName || "（无商品名称）"}</span>}</div></td>
            <td>{product.sku ? <a className="storefront-price-sku-link" href={publicProductUrl(product.sku)} target="_blank" rel="noreferrer">{product.sku}<ExternalLink size={12} /></a> : <span className="storefront-price-muted">无有效 SKU</span>}</td><td>{time(product.createdAt)}</td><td>{product.offerId}</td><td>{product.sales30d.toLocaleString("zh-CN")}</td><td>{money(product.price, product.currencyCode, rubPerCny)}</td>
          </tr>)}</tbody></table></div>
        )}
        {filteredProducts.length > PAGE_SIZE && <div className="storefront-price-pagination"><button className="secondary-button" type="button" onClick={() => setProductPage((page) => Math.max(1, page - 1))} disabled={productPage <= 1}><ChevronLeft size={16} />上一页</button><span>{productPage} / {productPages}</span><button className="secondary-button" type="button" onClick={() => setProductPage((page) => Math.min(productPages, page + 1))} disabled={productPage >= productPages}>下一页<ChevronRight size={16} /></button></div>}
      </section>}

      {section === "jobs" && <section className="storefront-price-panel" role="tabpanel" aria-labelledby="storefront-job-title">
        <div className="finance-panel-heading"><div><p className="eyebrow">COLLECTION JOBS</p><h2 id="storefront-job-title">采集任务</h2></div><span>由本机服务通过 OpenCLI 串行采集；关闭 GMV 页面不停止，Chrome 需保持运行</span></div>
        {(jobsQuery.data?.length ?? 0) > 0 && <label className="storefront-price-job-select">查看任务<select value={jobId} onChange={(event) => { setJobId(event.target.value); setJobPage(1); }}>{jobsQuery.data!.map((item) => <option key={item.id} value={item.id}>{item.storeName} · {statusLabels[item.status]} · {item.completedCount}/{item.totalCount} · {time(item.createdAt)}</option>)}</select></label>}
        {jobsQuery.isLoading ? <div className="storefront-price-empty">正在读取任务…</div> : !jobsQuery.data?.length ? <div className="storefront-price-empty">还没有价格采集任务。</div> : jobQuery.isLoading ? <div className="storefront-price-empty">正在读取任务进度…</div> : job ? <>
          <div className="storefront-price-job-summary"><span className={`storefront-price-status status-${job.status}`}>{job.status === "completed" ? <Check size={14} /> : job.status === "running" ? <RefreshCw size={14} /> : <Clock3 size={14} />}{statusLabels[job.status]}</span><strong>{job.storeName}</strong><span>{job.completedCount} / {job.totalCount} 完成</span><span>成功 {job.successCount} · 失败 {job.failedCount} · 无前台价格 {job.noDataCount}</span>{job.status === "running" && <button className="secondary-button" type="button" onClick={() => actionMutation.mutate({ id: job.id, action: "pause" })}><Pause size={15} />暂停</button>}{job.status === "paused" && <button className="secondary-button" type="button" onClick={() => actionMutation.mutate({ id: job.id, action: "resume" })}><Play size={15} />继续</button>}{["queued", "running", "paused"].includes(job.status) && <button className="secondary-button is-danger" type="button" onClick={() => actionMutation.mutate({ id: job.id, action: "cancel" })}><Square size={14} />取消</button>}</div>
          <div className="storefront-price-progress" role="progressbar" aria-valuenow={job.completedCount} aria-valuemin={0} aria-valuemax={job.totalCount}><span style={{ width: `${job.totalCount ? Math.round(100 * job.completedCount / job.totalCount) : 0}%` }} /></div>
          <div className="storefront-price-table-wrap"><table className="storefront-price-table"><thead><tr><th>商品 / SKU</th><th>采集状态</th><th>绿标价（¥）</th><th>黑标价（¥）</th><th>后台售价（¥）</th><th>价格差异</th><th>结果说明</th><th>操作</th></tr></thead><tbody>{job.items.map((item) => <tr key={item.id}><td><span className="storefront-price-name">{item.productName || item.offerId}</span><small>{item.sku || "SKU 无法确认"} · {item.offerId}</small></td><td><span className={`storefront-price-item-status item-${item.status}`}>{itemStatusLabels[item.status]}</span></td><td><span className="storefront-price-value is-green">{money(item.greenPrice, item.frontCurrencyCode, rubPerCny)}</span></td><td><span className="storefront-price-value is-black-label">{money(item.blackPrice, item.frontCurrencyCode, rubPerCny)}</span></td><td><span className="storefront-price-value is-backend">{money(item.backendPrice, item.currencyCode, rubPerCny)}</span></td><td><PriceDifference front={item.greenPrice} frontCurrency={item.frontCurrencyCode} backend={item.backendPrice} currency={item.currencyCode} rubPerCny={rubPerCny} /></td><td className="storefront-price-error-cell">{item.error || "—"}</td><td>{["failed", "no_data"].includes(item.status) && <div className="storefront-price-row-actions"><button className="secondary-button" type="button" onClick={() => retryMutation.mutate({ id: job.id, itemId: item.id })} disabled={retryMutation.isPending} aria-label={`重试 ${item.productName || item.sku}`}><RefreshCw size={14} />重试</button><button className="secondary-button is-danger" type="button" onClick={() => deleteItemMutation.mutate({ id: job.id, itemId: item.id })} disabled={deleteItemMutation.isPending} aria-label={`删除 ${item.productName || item.sku}`}><Trash2 size={14} />删除</button></div>}</td></tr>)}</tbody></table></div>
          {job.itemTotal > PAGE_SIZE && <div className="storefront-price-pagination"><button className="secondary-button" type="button" onClick={() => setJobPage((page) => Math.max(1, page - 1))} disabled={jobPage <= 1}><ChevronLeft size={16} />上一页</button><span>{jobPage} / {Math.ceil(job.itemTotal / PAGE_SIZE)}</span><button className="secondary-button" type="button" onClick={() => setJobPage((page) => Math.min(Math.ceil(job.itemTotal / PAGE_SIZE), page + 1))} disabled={jobPage >= Math.ceil(job.itemTotal / PAGE_SIZE)}>下一页<ChevronRight size={16} /></button></div>}
        </> : <div className="storefront-price-empty is-error">任务详情读取失败：{jobQuery.error instanceof Error ? jobQuery.error.message : "请重试"}</div>}
        {actionMutation.isError && <p className="storefront-price-error" role="alert">任务操作失败：{actionMutation.error instanceof Error ? actionMutation.error.message : "请稍后重试"}</p>}
      </section>}

      {section === "latest" && <section className="storefront-price-panel" role="tabpanel" aria-labelledby="storefront-latest-title">
        <div className="finance-panel-heading"><div><p className="eyebrow">LATEST SNAPSHOTS</p><h2 id="storefront-latest-title">最新前台价格</h2></div><span>{latest?.total ?? 0} 件有成功快照</span></div>
        <div className="storefront-price-toolbar storefront-price-latest-filters">
          <label className="storefront-price-search"><Search size={16} /><input aria-label="搜索采集结果" placeholder="搜索商品名、SKU 或货号" value={latestSearch} onChange={(event) => { setLatestSearch(event.target.value); setLatestPage(1); }} /></label>
          <label className="storefront-price-sort"><ListFilter size={15} />前台价格<select aria-label="前台价格筛选" value={frontPriceFilter} onChange={(event) => { setFrontPriceFilter(event.target.value as typeof frontPriceFilter); setLatestPage(1); }}><option value="all">全部</option><option value="available">有前台价格</option><option value="missing">无绿标价</option></select></label>
          <label className="storefront-price-sort">价格差异<select aria-label="价格差异筛选" value={differenceFilter} onChange={(event) => { setDifferenceFilter(event.target.value as typeof differenceFilter); setLatestPage(1); }}><option value="all">全部</option><option value="higher">绿标高于后台</option><option value="lower">绿标低于后台</option><option value="equal">绿标等于后台</option><option value="unavailable">无法比较</option></select></label>
          <label className="storefront-price-sort">排序<select aria-label="采集结果排序" value={latestSort} onChange={(event) => { setLatestSort(event.target.value as LatestSort); setLatestPage(1); }}>{Object.entries(latestSortLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        {latestQuery.isLoading ? <div className="storefront-price-empty">正在读取历史快照…</div> : latestQuery.isError ? <div className="storefront-price-empty is-error">历史快照读取失败。</div> : !latest?.items.length ? <div className="storefront-price-empty">采集成功后，商品最新价格会显示在这里。</div> : <div className="storefront-price-table-wrap"><table className="storefront-price-table"><thead><tr><th>商品 / SKU</th><th>绿标价（¥）</th><th>黑标价（¥）</th><th>Seller 后台售价（¥）</th><th>价格差异</th><th>采集时间</th><th>历史</th></tr></thead><tbody>{latest.items.map((item) => <tr key={item.id}><td><div className="storefront-price-product"><OrderImagePreview src={item.imageUrl} alt={`${item.productName || item.offerId} 商品图`} fallbackLabel="商品暂无主图" width={44} height={44} className="storefront-price-product-image" placeholderClassName="storefront-price-product-placeholder" objectFit="contain" /><span><b>{item.productName || item.offerId}</b><small>{item.sku ? <a className="storefront-price-sku-link" href={publicProductUrl(item.sku)} target="_blank" rel="noreferrer" title="打开 Ozon 前台商品页">{item.sku}<ExternalLink size={11} /></a> : "无有效 SKU"} · {item.offerId}</small></span></div></td><td><span className="storefront-price-value is-green">{money(item.greenPrice, item.frontCurrencyCode, rubPerCny)}</span></td><td><span className="storefront-price-value is-black-label">{money(item.blackPrice, item.frontCurrencyCode, rubPerCny)}</span></td><td><span className="storefront-price-value is-backend">{money(item.backendPrice, item.currencyCode, rubPerCny)}</span></td><td><PriceDifference front={item.greenPrice} frontCurrency={item.frontCurrencyCode} backend={item.backendPrice} currency={item.currencyCode} rubPerCny={rubPerCny} /></td><td>{time(item.capturedAt)}</td><td><button className="secondary-button" type="button" onClick={() => setHistoryProductId(item.productId)}>查看历史</button></td></tr>)}</tbody></table></div>}
        {latest && latest.total > PAGE_SIZE && <div className="storefront-price-pagination"><button className="secondary-button" type="button" onClick={() => setLatestPage((page) => Math.max(1, page - 1))} disabled={latestPage <= 1}><ChevronLeft size={16} />上一页</button><span>{latestPage} / {Math.ceil(latest.total / PAGE_SIZE)}</span><button className="secondary-button" type="button" onClick={() => setLatestPage((page) => Math.min(Math.ceil(latest.total / PAGE_SIZE), page + 1))} disabled={latestPage >= Math.ceil(latest.total / PAGE_SIZE)}>下一页<ChevronRight size={16} /></button></div>}
      </section>}

      {historyProductId && <div className="storefront-price-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setHistoryProductId(""); }}><section className="storefront-price-history" role="dialog" aria-modal="true" aria-labelledby="storefront-history-title"><header><div><p className="eyebrow">PRICE HISTORY</p><h2 id="storefront-history-title">商品价格历史</h2></div><button type="button" className="pricing-dialog-close" aria-label="关闭" onClick={() => setHistoryProductId("")}><X size={19} /></button></header>{historyQuery.isLoading ? <p>正在读取历史…</p> : !history.length ? <p>暂无历史快照。</p> : <div className="storefront-price-history-list">{history.map((item: StorefrontPriceSnapshot) => <article key={item.id}><strong>{item.productName || item.offerId}</strong><small>{item.sku} · {time(item.capturedAt)}</small><div><span>绿标价 <b className="storefront-price-value is-green">{money(item.greenPrice, item.frontCurrencyCode, rubPerCny)}</b></span><span>黑标价 <b className="storefront-price-value is-black-label">{money(item.blackPrice, item.frontCurrencyCode, rubPerCny)}</b></span><span>后台售价 <b className="storefront-price-value is-backend">{money(item.backendPrice, item.currencyCode, rubPerCny)}</b></span></div></article>)}</div>}</section></div>}
    </main>
  );
}
