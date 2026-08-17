import { ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, CircleAlert, ExternalLink, ImagePlus, PackagePlus, RefreshCw, Rocket, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";

import type { FulfillmentMode, ResellImageView, ResellMode, ResellPreflightInput, ResellPreflightView, ResellStatus } from "../../shared/contracts";
import { createResellTask, fetchResellSource, fetchResellTask, fetchStores, preflightResell, retryResellTask, uploadResellImage } from "../api";
import { AppNav } from "../components/AppNav";
import { formatMoney } from "../format";

const statusLabels: Record<ResellStatus, string> = {
  draft: "草稿",
  preflight_failed: "预检失败",
  creating: "创建中",
  pending: "等待 Ozon 处理",
  created: "商品已创建",
  setting_images: "正在上传商品图片",
  setting_price: "正在设置价格",
  setting_stock: "正在设置库存",
  moderating: "等待审核或打标",
  sellable: "已提交并完成库存配置",
  needs_input: "需要补充信息",
  failed: "失败",
};

const activeStatuses: ResellStatus[] = ["creating", "pending", "created", "setting_images", "setting_price", "setting_stock"];

function numberPrice(value: string): number {
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

function defaultPrice(amount: string, monthlySales: string, monthlyUnits: number): string {
  if (numberPrice(amount) > 0) return amount;
  if (monthlyUnits > 0 && numberPrice(monthlySales) > 0) return (numberPrice(monthlySales) / monthlyUnits).toFixed(2);
  return "";
}

function safeProductUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function validateVat(value: string): string | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return "VAT 不能为空";
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? null
    : "VAT 必须是 0 到 1 之间的数字，例如 0 或 0.2";
}

function inputFromState(state: {
  sku: string;
  storeId: string;
  mode: ResellMode;
  offerId: string;
  price: string;
  oldPrice: string;
  currency: string;
  vat: string;
  stock: string;
  fulfillmentMode: FulfillmentMode;
  warehouseId: string;
  title: string;
  description: string;
  attributesText: string;
  images: ResellImageView[];
}): ResellPreflightInput {
  let attributes: Record<string, unknown> | undefined;
  if (state.mode === "edit" && state.attributesText.trim()) {
    const parsed: unknown = JSON.parse(state.attributesText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("类目属性必须是 JSON 对象");
    }
    attributes = parsed as Record<string, unknown>;
    if (Object.keys(attributes).length === 0) {
      throw new Error("编辑模式至少需要填写一项类目属性");
    }
  }
  return {
    sourceSku: state.sku,
    storeId: state.storeId,
    mode: state.mode,
    offerId: state.offerId.trim(),
    price: state.price.trim(),
    ...(state.oldPrice.trim() ? { oldPrice: state.oldPrice.trim() } : {}),
    currency: state.currency.trim().toUpperCase(),
    vat: state.vat.trim(),
    stock: Number(state.stock),
    fulfillmentMode: state.fulfillmentMode,
    warehouseId: state.warehouseId,
    ...(state.title.trim() ? { title: state.title.trim() } : {}),
    ...(state.description.trim() ? { description: state.description.trim() } : {}),
    ...(attributes ? { attributes } : {}),
    images: state.images.map((image, position) => image.source === "uploaded"
      ? { assetId: image.id, position }
      : { sourceUrl: image.url, position }),
  };
}

function taskStatusTone(status: ResellStatus): string {
  if (status === "sellable") return "resell-status--success";
  if (["failed", "preflight_failed", "needs_input"].includes(status)) return "resell-status--error";
  if (status === "moderating") return "resell-status--warning";
  return "resell-status--active";
}

/** Provides a guarded single-SKU Ozon follow-sale workflow. */
export default function ResellPage(): React.JSX.Element {
  const { sku = "" } = useParams<{ sku: string }>();
  const navigate = useNavigate();
  const sourceQuery = useQuery({ queryKey: ["resell-source", sku], queryFn: () => fetchResellSource(sku), enabled: Boolean(sku) });
  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores });
  const [storeId, setStoreId] = useState("");
  const [mode, setMode] = useState<ResellMode>("quick");
  const [offerId, setOfferId] = useState("");
  const [price, setPrice] = useState("");
  const [oldPrice, setOldPrice] = useState("");
  const [currency, setCurrency] = useState("RUB");
  const [vat, setVat] = useState("0");
  const [stock, setStock] = useState("2");
  const [fulfillmentMode, setFulfillmentMode] = useState<FulfillmentMode>("FBS");
  const [warehouseId, setWarehouseId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attributesText, setAttributesText] = useState("{}\n");
  const [preflight, setPreflight] = useState<ResellPreflightView | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [images, setImages] = useState<ResellImageView[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const replaceIndexRef = useRef<number | null>(null);

  const selectedStore = storesQuery.data?.find((store) => store.id === storeId);
  const taskQuery = useQuery({
    queryKey: ["resell-task", taskId],
    queryFn: () => fetchResellTask(taskId!),
    enabled: Boolean(taskId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && activeStatuses.includes(status) ? 2_000 : false;
    },
  });

  useEffect(() => {
    const source = sourceQuery.data;
    if (!source) return;
    setTitle((current) => current || source.productName);
    setPrice((current) => current || defaultPrice(source.currentPrice.amount, source.monthlySales.amount, source.monthlyUnits));
    setOfferId((current) => current || `MY-${source.sku}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80));
    setImages((current) => current.length > 0 ? current : source.images);
  }, [sourceQuery.data]);

  useEffect(() => {
    const firstStore = storesQuery.data?.[0];
    if (!storeId && firstStore) {
      setStoreId(firstStore.id);
      setFulfillmentMode(firstStore.fulfillmentModes[0] ?? "FBS");
    }
  }, [storeId, storesQuery.data]);

  useEffect(() => {
    if (selectedStore && !selectedStore.fulfillmentModes.includes(fulfillmentMode)) {
      setFulfillmentMode(selectedStore.fulfillmentModes[0] ?? "FBS");
    }
  }, [fulfillmentMode, selectedStore]);

  const formState = useMemo(() => ({ sku, storeId, mode, offerId, price, oldPrice, currency, vat, stock, fulfillmentMode, warehouseId, title, description, attributesText, images }), [sku, storeId, mode, offerId, price, oldPrice, currency, vat, stock, fulfillmentMode, warehouseId, title, description, attributesText, images]);

  const imageUploadMutation = useMutation({
    mutationFn: async ({ file, index }: { file: File; index: number | null }) => ({ image: await uploadResellImage(file), index }),
    onSuccess: ({ image, index }) => {
      const next: ResellImageView = { ...image, source: "uploaded" };
      setImages((current) => index === null ? [...current, next] : current.map((item, itemIndex) => itemIndex === index ? next : item));
      setFormError(null);
    },
    onError: (error) => setFormError(error.message.includes("OSS") ? `${error.message} 请前往“本机设置”配置图片存储。` : error.message),
  });

  const preflightMutation = useMutation({
    mutationFn: () => preflightResell(inputFromState(formState)),
    onSuccess: (result) => {
      setPreflight(result);
      setFormError(result.errors.length > 0 ? result.errors.join("；") : null);
      if (!warehouseId && result.warehouses[0]) setWarehouseId(result.warehouses[0].id);
    },
    onError: (error) => setFormError(error.message),
  });
  const createMutation = useMutation({
    mutationFn: () => createResellTask(inputFromState(formState)),
    onSuccess: (task) => {
      setConfirmOpen(false);
      setTaskId(task.id);
      setFormError(null);
    },
    onError: (error) => setFormError(error.message),
  });
  const retryMutation = useMutation({
    mutationFn: () => retryResellTask(taskId!),
    onSuccess: (task) => setTaskId(task.id),
    onError: (error) => setFormError(error.message),
  });

  function runPreflight(): void {
    try {
      setFormError(null);
      const vatError = validateVat(vat);
      if (vatError) {
        setFormError(vatError);
        return;
      }
      preflightMutation.mutate();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "请检查表单");
    }
  }

  function openConfirmation(): void {
    try {
      const input = inputFromState(formState);
      if (!input.storeId || !input.offerId || !input.price || !input.warehouseId) throw new Error("请先完成店铺、Offer ID、价格和仓库配置");
      const vatError = validateVat(input.vat);
      if (vatError) throw new Error(vatError);
      if (images.length === 0) throw new Error("请至少添加一张商品图片，第一张将作为主图");
      setFormError(null);
      setConfirmOpen(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "请检查表单");
    }
  }

  function openImagePicker(index: number | null): void {
    replaceIndexRef.current = index;
    imageInputRef.current?.click();
  }

  function handleImageFile(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      imageUploadMutation.mutate({ file, index: replaceIndexRef.current });
    }
    replaceIndexRef.current = null;
  }

  function moveImage(index: number, offset: number): void {
    const target = index + offset;
    if (target < 0 || target >= images.length) return;
    setImages((current) => {
      const next = [...current];
      const currentImage = next[index];
      const targetImage = next[target];
      if (!currentImage || !targetImage) return current;
      next[index] = targetImage;
      next[target] = currentImage;
      return next;
    });
  }

  if (sourceQuery.isLoading || storesQuery.isLoading) return <div className="app-loading"><div className="brand-mark">O</div><div className="loading-line" /></div>;
  if (sourceQuery.error || !sourceQuery.data) return <main className="admin-page"><AppNav /><section className="page-error resell-error"><h1>无法读取跟卖来源</h1><p>{sourceQuery.error?.message ?? "MY 数据中不存在该 SKU"}</p><Link className="secondary-button" to="/selection?tab=my-data">返回 MY 数据</Link></section></main>;

  const source = sourceQuery.data;
  const task = taskQuery.data;
  const productUrl = safeProductUrl(source.productUrl);
  return (
    <div className="admin-page resell-page">
      <AppNav />
      <main className="resell-content">
        <div className="resell-breadcrumb"><button className="icon-button" type="button" onClick={() => navigate("/selection?tab=my-data")} aria-label="返回 MY 数据"><ArrowLeft size={19} /></button><span>选品分析</span><span>/</span><strong>一键跟卖</strong></div>
        <header className="resell-heading"><div><p className="eyebrow">OZON FOLLOW-SALE</p><h1>一键跟卖</h1><p>使用商品 SKU 创建目标店铺自己的商品报价。发布后仍需等待 Ozon 审核和可售状态。</p></div><ShieldCheck size={34} aria-hidden="true" /></header>
        <div className="resell-layout">
          <section className="resell-source-card">
            <p className="eyebrow">SOURCE PRODUCT</p>
            <div className="resell-source-product"><span className="resell-source-image">{source.images[0] ? <img src={source.images[0].url} alt={`${source.productName} 主图`} /> : <PackagePlus size={24} aria-label="无商品主图" />}</span><div><h2 title={source.productName}>{source.productName}</h2><p>Ozon SKU：<strong>{source.sku}</strong></p>{productUrl && <a href={productUrl} target="_blank" rel="noreferrer">打开原商品 <ExternalLink size={14} /></a>}</div></div>
            <dl className="resell-source-metrics"><div><dt>当前价格</dt><dd>{formatMoney(source.currentPrice)}</dd></div><div><dt>月销量</dt><dd>{source.monthlyUnits.toLocaleString("zh-CN")}</dd></div><div><dt>采集日</dt><dd>{source.captureDay}</dd></div></dl>
          </section>
          <section className="resell-form-card">
            <div className="resell-mode-switch" role="tablist" aria-label="跟卖模式"><button className={mode === "quick" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "quick"} onClick={() => setMode("quick")}>快速创建<span>按 SKU 复用商品卡</span></button><button className={mode === "edit" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "edit"} onClick={() => setMode("edit")}>编辑后上架<span>补充类目和商品属性</span></button></div>
            <section className="resell-image-editor" aria-labelledby="resell-images-heading"><div className="resell-image-editor__heading"><div><p className="eyebrow">PRODUCT MEDIA</p><h3 id="resell-images-heading">商品图片</h3><p>第一张为主图，后续为副图；Ozon 会按此顺序替换整组图片。</p></div><button className="secondary-button compact-button" type="button" onClick={() => openImagePicker(null)} disabled={imageUploadMutation.isPending}><ImagePlus size={16} />{imageUploadMutation.isPending ? "上传中…" : "添加图片"}</button></div><input ref={imageInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageFile} />{images.length === 0 ? <div className="resell-image-empty"><PackagePlus size={24} /><span>暂无图片，请上传一张主图后再提交。</span></div> : <ol className="resell-image-list">{images.map((image, index) => <li className="resell-image-item" key={`${image.id}-${index}`}><img src={image.url} alt={`${index === 0 ? "主图" : "副图"} ${image.fileName}`} loading="lazy" /><div className="resell-image-item__meta"><strong>{index === 0 ? "主图" : `副图 ${index}`}</strong><span title={image.fileName}>{image.fileName}</span><small>{image.source === "uploaded" ? "已上传至 OSS" : "来源商品图片"}</small></div><div className="resell-image-item__actions"><button className="icon-button" type="button" onClick={() => openImagePicker(index)} aria-label={`替换第 ${index + 1} 张图片`} disabled={imageUploadMutation.isPending}><RefreshCw size={15} /></button><button className="icon-button" type="button" onClick={() => moveImage(index, -1)} aria-label={`第 ${index + 1} 张图片上移`} disabled={index === 0}><ArrowUp size={15} /></button><button className="icon-button" type="button" onClick={() => moveImage(index, 1)} aria-label={`第 ${index + 1} 张图片下移`} disabled={index === images.length - 1}><ArrowDown size={15} /></button><button className="icon-button icon-button--danger" type="button" onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`删除第 ${index + 1} 张图片`}><Trash2 size={15} /></button></div></li>)}</ol>}</section>
            <div className="resell-form-grid">
              <label className="field"><span>目标店铺 *</span><select value={storeId} onChange={(event) => { setStoreId(event.target.value); setPreflight(null); }}><option value="">请选择店铺</option>{(storesQuery.data ?? []).filter((store) => store.enabled).map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select></label>
              <label className="field"><span>履约模式 *</span><select value={fulfillmentMode} onChange={(event) => setFulfillmentMode(event.target.value as FulfillmentMode)}>{(selectedStore?.fulfillmentModes ?? []).map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
              <label className="field"><span>Offer ID *</span><input value={offerId} onChange={(event) => setOfferId(event.target.value)} maxLength={80} /></label>
              <label className="field"><span>销售价 *</span><input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="例如 1299" /></label>
              <label className="field"><span>币种 *</span><input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} maxLength={3} /></label>
              <label className="field"><span>VAT *</span><input value={vat} onChange={(event) => setVat(event.target.value)} placeholder="例如 0 或 0.2" /><small>当前默认按中国店铺规则填写 0；其他国家请以目标店铺 Ozon 规则为准。</small>{vat.trim() && validateVat(vat) === null && Number(vat.replace(",", ".")) !== 0 && <small className="resell-vat-warning">当前 VAT 非 0，请确认与目标店铺国家税率一致。</small>}</label>
              <label className="field"><span>库存数量 *</span><input type="number" min="0" step="1" value={stock} onChange={(event) => setStock(event.target.value)} /><small>默认库存为 2，可按目标店铺实际库存修改。</small></label>
              <label className="field"><span>仓库 *</span><select value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}><option value="">先点击“检查配置”读取仓库</option>{(preflight?.warehouses ?? []).map((warehouse) => <option value={warehouse.id} key={warehouse.id}>{warehouse.name} · {warehouse.status}</option>)}</select></label>
              <label className="field field--wide"><span>商品标题</span><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} /></label>
              {mode === "edit" && <label className="field field--wide"><span>商品描述</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="可选；不要填写未验证的功效或合规声明" /></label>}
              {mode === "edit" && <label className="field field--wide"><span>类目属性 JSON</span><textarea value={attributesText} onChange={(event) => setAttributesText(event.target.value)} rows={6} spellCheck={false} /><small>编辑模式需要按 Ozon 当前类目接口补充必填属性。</small></label>}
            </div>
            <div className="resell-actions"><button className="secondary-button" type="button" onClick={runPreflight} disabled={preflightMutation.isPending}>{preflightMutation.isPending ? "正在检查…" : "检查配置"}</button><button className="primary-button" type="button" onClick={openConfirmation} disabled={createMutation.isPending || Boolean(taskId)}><Rocket size={17} />提交跟卖</button></div>
            {formError && <div className="field-error" role="alert"><CircleAlert size={17} />{formError}</div>}
            {preflight && <PreflightSummary result={preflight} />}
          </section>
        </div>
        {task && <TaskStatus task={task} onRetry={() => retryMutation.mutate()} retrying={retryMutation.isPending} />}
      </main>
      {confirmOpen && <div className="dialog-backdrop" role="presentation"><section className="dialog resell-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="resell-confirm-title"><div className="dialog-heading"><div><p className="eyebrow">ACTION CONFIRMATION</p><h2 id="resell-confirm-title">确认提交跟卖？</h2></div><button className="icon-button" type="button" onClick={() => setConfirmOpen(false)} aria-label="取消"><CircleAlert size={19} /></button></div><p>服务将使用目标店铺的 Seller API 创建商品、上传图片、设置价格并写入库存。Ozon 仍可能要求审核或补充资料。</p><dl className="resell-confirm-list"><div><dt>目标店铺</dt><dd>{selectedStore?.name ?? "—"}</dd></div><div><dt>SKU / Offer ID</dt><dd>{source.sku} / {offerId}</dd></div><div><dt>图片</dt><dd>{images.length} 张（已上传 {images.filter((image) => image.source === "uploaded").length} 张）</dd></div><div><dt>价格 / 库存</dt><dd>{price} {currency} / {stock} 件</dd></div><div><dt>VAT</dt><dd>{vat}（请确认与目标店铺国家税率一致）</dd></div><div><dt>履约 / 仓库</dt><dd>{fulfillmentMode} / {preflight?.warehouses.find((item) => item.id === warehouseId)?.name ?? warehouseId}</dd></div></dl><div className="resell-confirm-thumbs">{images.slice(0, 6).map((image, index) => <img key={`${image.id}-${index}`} src={image.url} alt={`${index === 0 ? "主图" : "副图"}预览`} />)}</div>{preflight?.warnings.map((warning) => <p className="resell-warning" key={warning}><CircleAlert size={16} />{warning}</p>)}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setConfirmOpen(false)}>返回修改</button><button className="primary-button" type="button" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>{createMutation.isPending ? "提交中…" : "确认提交"}</button></div></section></div>}
    </div>
  );
}

function PreflightSummary(props: { result: ResellPreflightView }): React.JSX.Element {
  return <div className={props.result.valid ? "resell-preflight resell-preflight--valid" : "resell-preflight resell-preflight--invalid"} role={props.result.valid ? "status" : "alert"}><div><strong>{props.result.valid ? <><CheckCircle2 size={16} />配置可以提交</> : <><CircleAlert size={16} />配置需要修正</>}</strong>{props.result.errors.map((error) => <span key={error}>{error}</span>)}{props.result.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>{props.result.limits.dailyCreateRemaining !== null && <small>今日剩余创建额度：{props.result.limits.dailyCreateRemaining}</small>}</div>;
}

function TaskStatus(props: { task: Awaited<ReturnType<typeof fetchResellTask>>; onRetry: () => void; retrying: boolean }): React.JSX.Element {
  const task = props.task;
  const hasError = ["failed", "needs_input"].includes(task.status);
  const canRetry = hasError && !task.productId;
  return <section className="resell-task-card" aria-live="polite"><div className="resell-task-heading"><div><p className="eyebrow">PUBLISH TASK</p><h2>跟卖任务状态</h2></div><span className={`resell-status ${taskStatusTone(task.status)}`}>{hasError ? <CircleAlert size={15} /> : task.status === "sellable" ? <CheckCircle2 size={15} /> : <RefreshCw size={15} />}{statusLabels[task.status]}</span></div><dl className="resell-task-meta"><div><dt>目标店铺</dt><dd>{task.storeName}</dd></div><div><dt>Ozon Task ID</dt><dd>{task.ozonTaskId ?? "等待返回"}</dd></div><div><dt>Product ID</dt><dd>{task.productId ?? "等待导入完成"}</dd></div><div><dt>最终库存</dt><dd>{task.stock} 件</dd></div></dl>{task.lastError && <div className="field-error" role="alert"><CircleAlert size={17} />{task.lastError}</div>}{task.productId && hasError && <p className="resell-warning"><CircleAlert size={16} />商品已在 Ozon 创建，请先修正已有商品，不要重复创建。</p>}{canRetry && <button className="secondary-button compact-button" type="button" onClick={props.onRetry} disabled={props.retrying}>{props.retrying ? "重新提交中…" : "重新提交任务"}</button>}</section>;
}
