import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CheckCircle2, Clock3, Link2, PackageCheck, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ProductImage } from "../components/ProductImage";
import type { PublishVariantDraft, ResellSourceView } from "../../shared/contracts";
import { createPublishDraft, deletePublishDraft, fetchPublishDrafts, submitPublishDraftsBatch, updatePublishDraft, type PublishBatchSubmitResult } from "../api";
import "./PublishCollectionPage.css";

const stageLabels = { collected: "待处理", processing: "加工中", ready: "待上架", submitted: "已提交" } as const;

/** Returns whether a pasted address targets a supported product detail page. */
function isSupportedProductUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (["ozon.ru", "www.ozon.ru"].includes(url.hostname)) return url.pathname.includes("/product/");
    return url.hostname === "detail.1688.com" && /^\/offer\/\d+/.test(url.pathname);
  } catch { return false; }
}

/** Converts a browser extension snapshot into the GMV draft contract. */
function collectedSource(rawValue: unknown): { sourceSku: string; title: string; sourceSnapshot: ResellSourceView; fieldOverrides: Record<string, unknown>; variants: PublishVariantDraft[] } {
  const raw = rawValue && typeof rawValue === "object" ? rawValue as Record<string, unknown> : {};
  const sourceType = raw.sourceType === "public_page" ? "public_page" : "1688_collector";
  const sourceSku = String(raw.offerId ?? raw.sku ?? "").trim();
  const title = String(raw.title ?? "").trim();
  const imageUrls = Array.isArray(raw.mainImages) ? raw.mainImages.map(String).filter((url) => /^https:\/\//i.test(url)) : [];
  const images = [...new Set(imageUrls)].slice(0, 20).map((url, index) => ({
    id: crypto.randomUUID(), url, fileName: `${sourceType === "public_page" ? "ozon" : "1688"}-${sourceSku}-${index + 1}.jpg`, mimeType: "image/jpeg", byteSize: 0, width: 1, height: 1, source: "source" as const,
  }));
  const supplier = raw.seller && typeof raw.seller === "object" ? raw.seller as Record<string, unknown> : {};
  const sourceVariants = Array.isArray(raw.skuVariants) && raw.skuVariants.length ? raw.skuVariants : sourceType === "public_page" ? [{ label: title, price: "", stock: null }] : [];
  const variants = sourceVariants.slice(0, 100).map((item, index) => {
    const variant = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      id: crypto.randomUUID(), sourceSkuId: String(variant.sourceSkuId ?? `dom-${index + 1}`), label: String(variant.label ?? ""),
      imageUrl: String(variant.imageUrl ?? ""), richContent: "", videoUrl: "", offerId: `${sourceSku}-${index + 1}`.slice(0, 80),
      purchasePrice: sourceType === "1688_collector" ? String(variant.price ?? "") : "", price: "", oldPrice: "", currency: "RUB", stock: Number.isInteger(variant.stock) ? Number(variant.stock) : null,
      packageDimensions: { depth: "", width: "", height: "", dimensionUnit: "mm", weight: "", weightUnit: "g" },
      attributes: variant.variantProps && typeof variant.variantProps === "object" ? variant.variantProps as Record<string, unknown> : {},
    };
  });
  const sourceSnapshot: ResellSourceView = {
    sku: sourceSku,
    productName: title,
    description: String(raw.description ?? ""),
    sourceType,
    typeId: null,
    descriptionCategoryId: null,
    currentPrice: { amount: sourceType === "public_page" ? String(raw.price ?? "") : "", currency: String(raw.currency ?? "RUB") },
    productUrl: String(raw.url ?? ""),
    imageUrl: images[0]?.url ?? null,
    images,
    monthlyUnits: 0,
    monthlySales: { amount: "0", currency: "RUB" },
    captureDay: new Date().toISOString().slice(0, 10),
    attributes: raw.attributes && typeof raw.attributes === "object" ? raw.attributes as Record<string, unknown> : {},
    fieldSources: { productName: sourceType, images: sourceType },
    missingFields: [
      ...(title ? [] : ["商品标题"]),
      ...(images.length ? [] : ["商品图片"]),
      ...(sourceType === "1688_collector" ? ["包装尺寸与重量"] : []), "Ozon 类目", "目标类目属性",
    ],
  };
  return {
    sourceSku,
    title,
    sourceSnapshot,
    fieldOverrides: {
      supplierPlatform: sourceType === "1688_collector" ? "1688" : "",
      supplierPrice: sourceType === "1688_collector" ? raw.price ?? null : null,
      supplierPriceRange: sourceType === "1688_collector" ? raw.priceRange ?? null : null,
      wholesalePrice: Array.isArray(raw.wholesalePrice) ? raw.wholesalePrice : [],
      supplierAttributes: Array.isArray(raw.productAttributes) ? raw.productAttributes : [],
      supplierVariants: Array.isArray(raw.skuVariants) ? raw.skuVariants : [],
      supplierName: String(supplier.name ?? ""),
      supplierUrl: String(supplier.shopUrl ?? ""),
      soldCount: raw.soldCount ?? null,
    },
    variants,
  };
}

/** Shows collected product drafts and moves them through the listing workflow. */
export default function PublishCollectionPage(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [importMessage, setImportMessage] = useState("");
  const [collectModal, setCollectModal] = useState(false);
  const [collectUrls, setCollectUrls] = useState("");
  const [collectMessage, setCollectMessage] = useState("");
  const [collecting, setCollecting] = useState(false);
  const collectionAccepted = useRef(false);
  const [searchText, setSearchText] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [batchResult, setBatchResult] = useState<PublishBatchSubmitResult | null>(null);
  const activeStage = location.pathname.endsWith("/processing") ? "processing" : location.pathname.endsWith("/ready") ? "ready" : "collected";
  const draftsQuery = useQuery({ queryKey: ["publish-drafts"], queryFn: () => fetchPublishDrafts() });
  const moveMutation = useMutation({
    mutationFn: ({ id, workflowStage }: { id: string; workflowStage: "processing" | "collected" }) => updatePublishDraft(id, { workflowStage }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["publish-drafts"] }),
  });
  const deleteMutation = useMutation({
    mutationFn: deletePublishDraft,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["publish-drafts"] }),
  });
  const bulkMoveMutation = useMutation({
    mutationFn: async ({ ids, workflowStage }: { ids: string[]; workflowStage: "processing" | "collected" }) => Promise.all(ids.map((id) => updatePublishDraft(id, { workflowStage }))),
    onSuccess: () => { setSelectedIds([]); void queryClient.invalidateQueries({ queryKey: ["publish-drafts"] }); },
  });
  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => Promise.all(ids.map(deletePublishDraft)),
    onSuccess: () => { setSelectedIds([]); void queryClient.invalidateQueries({ queryKey: ["publish-drafts"] }); },
  });
  const batchSubmitMutation = useMutation({
    mutationFn: () => submitPublishDraftsBatch(selectedIds),
    onSuccess: (result) => { setBatchResult(result); setConfirmBatch(false); setSelectedIds([]); void queryClient.invalidateQueries({ queryKey: ["publish-drafts"] }); },
  });
  const drafts = draftsQuery.data ?? [];
  const visibleDrafts = drafts.filter((draft) => draft.workflowStage === activeStage)
    .filter((draft) => `${draft.title || draft.sourceSnapshot.productName} ${draft.sourceSku}`.toLowerCase().includes(searchText.trim().toLowerCase()));
  const counts = {
    collected: drafts.filter((draft) => draft.workflowStage === "collected").length,
    processing: drafts.filter((draft) => draft.workflowStage === "processing").length,
    ready: drafts.filter((draft) => draft.workflowStage === "ready").length,
  };
  const bulkReturnStage = activeStage === "collected" ? "processing" : activeStage === "ready" ? "processing" : "collected";

  useEffect(() => {
    const onCollected = async (event: MessageEvent): Promise<void> => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const message = event.data as { type?: string; requestId?: string; raw?: unknown; batchId?: string; index?: number; total?: number; accepted?: number; result?: { ok: boolean; error?: string }; summary?: { success: number; failed: number }; error?: string };
      if (message.type === "OZON_GMV_BATCH_ACCEPTED" && message.batchId) {
        collectionAccepted.current = true;
        setCollectMessage(`插件已接收 ${message.accepted ?? 0} 个链接，开始逐条采集…`);
        return;
      }
      if (message.type === "OZON_GMV_BATCH_PROGRESS" && message.batchId) {
        setCollectMessage(`正在采集第 ${message.index ?? 0}/${message.total ?? 0} 个链接${message.result?.ok ? "，已加入采集箱" : `，失败：${message.result?.error || "读取商品信息失败"}`}`);
        return;
      }
      if (message.type === "OZON_GMV_BATCH_COMPLETE" && message.batchId) {
        setCollecting(false);
        setCollectMessage(message.error || `采集完成：成功 ${message.summary?.success ?? 0} 个，失败 ${message.summary?.failed ?? 0} 个`);
        void queryClient.invalidateQueries({ queryKey: ["publish-drafts"] });
        return;
      }
      if (message.type !== "OZON_GMV_IMPORT_SOURCE" || !message.requestId) return;
      try {
        const product = collectedSource(message.raw);
        if (!product.sourceSku) throw new Error("采集数据缺少商品编号");
        const existing = await fetchPublishDrafts();
        const sourceType = product.sourceSnapshot.sourceType || "1688_collector";
        const duplicate = existing.find((draft) => draft.sourceType === sourceType && draft.sourceSku === product.sourceSku);
        if (duplicate) {
          await updatePublishDraft(duplicate.id, { ...product, workflowStage: duplicate.workflowStage });
          setImportMessage(`已更新采集商品 ${product.sourceSku}`);
        } else {
          await createPublishDraft({ sourceType, ...product });
          setImportMessage(`已加入采集箱：${product.title || product.sourceSku}`);
        }
        await queryClient.invalidateQueries({ queryKey: ["publish-drafts"] });
        window.postMessage({ type: "OZON_GMV_SOURCE_COLLECT_RESULT", requestId: message.requestId, ok: true }, window.location.origin);
      } catch (error) {
        setImportMessage(error instanceof Error ? `采集导入失败：${error.message}` : "采集导入失败");
        window.postMessage({ type: "OZON_GMV_SOURCE_COLLECT_RESULT", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : "采集导入失败" }, window.location.origin);
      }
    };
    window.addEventListener("message", onCollected);
    window.postMessage({ type: "OZON_GMV_IMPORT_READY" }, window.location.origin);
    return () => {
      window.removeEventListener("message", onCollected);
    };
  }, [queryClient]);

  /** Validates pasted Ozon links and asks the installed browser extension to collect them. */
  function submitCollection(): void {
    const candidates = [...new Set(collectUrls.split(/[\n\r\t ,]+/).map((value) => value.trim()).filter(Boolean))];
    const urls = candidates.filter(isSupportedProductUrl);
    if (!urls.length) { setCollectMessage("没有识别到支持的商品链接，请粘贴 Ozon 或 1688 商品详情页链接"); return; }
    if (urls.length > 50) { setCollectMessage("一次最多提交 50 个链接"); return; }
    const batchId = crypto.randomUUID();
    setCollecting(true);
    collectionAccepted.current = false;
    setCollectMessage(`已提交 ${urls.length} 条有效链接${candidates.length > urls.length ? `，跳过 ${candidates.length - urls.length} 条无效链接` : ""}，等待浏览器插件采集…`);
    window.postMessage({ type: "OZON_GMV_START_BATCH_COLLECTION", batchId, urls }, window.location.origin);
    window.setTimeout(() => {
      if (collectionAccepted.current) return;
      setCollecting(false);
      setCollectMessage("未收到浏览器插件响应。若刚更新过插件，请刷新 GMV 页面后重试");
    }, 2500);
  }

  return (
    <main className="publish-collection-page">
      <header className="publish-collection-heading">
        <div><p className="eyebrow">PRODUCT PIPELINE</p><h1>商品采集与加工</h1><p>把来源商品收进采集箱，完善上架信息后进入发布任务。</p></div>
        <div className="publish-collection-heading__actions"><button className="secondary-button" type="button" onClick={() => { setCollectModal(true); setCollectMessage(""); }}><Link2 size={16} />一键采集</button><Link className="primary-button" to="/operations/publish/workbench"><Plus size={17} />新建商品</Link></div>
      </header>
      {importMessage && <p className="publish-import-message" role="status">{importMessage}</p>}
      <section className="publish-pipeline-stats" aria-label="商品流程统计">
        <Link className={activeStage === "collected" ? "publish-pipeline-stat is-active" : "publish-pipeline-stat"} to="/operations/publish/collection"><span><PackageCheck size={17} />采集箱</span><strong>{counts.collected}</strong><small>等待进入商品加工</small></Link>
        <Link className={activeStage === "processing" ? "publish-pipeline-stat is-active" : "publish-pipeline-stat"} to="/operations/publish/processing"><span><Clock3 size={17} />加工箱</span><strong>{counts.processing}</strong><small>编辑、预检并准备上架</small></Link>
        <Link className={activeStage === "ready" ? "publish-pipeline-stat is-active" : "publish-pipeline-stat"} to="/operations/publish/ready"><span><CheckCircle2 size={17} />待上架</span><strong>{counts.ready}</strong><small>预检完成，等待提交上架</small></Link>
        <Link className="publish-pipeline-stat" to="/operations/publish/tasks"><span><CheckCircle2 size={17} />发布任务</span><strong>查看</strong><small>跟踪 Ozon 接收与审核状态</small></Link>
      </section>
      <section className="publish-draft-panel">
        <div className="publish-draft-panel__heading"><div><p className="eyebrow">{activeStage === "collected" ? "COLLECTION INBOX" : activeStage === "processing" ? "PROCESSING BOX" : "READY TO LIST"}</p><h2>{activeStage === "collected" ? "采集箱" : activeStage === "processing" ? "加工箱" : "待上架"}</h2></div><span>{visibleDrafts.length} 件商品</span></div>
        <div className="publish-draft-toolbar"><label><span className="visually-hidden">搜索商品</span><input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索商品名称 / SKU" /></label><label className="publish-select-all"><input type="checkbox" checked={visibleDrafts.length > 0 && visibleDrafts.every((draft) => selectedIds.includes(draft.id))} onChange={(event) => setSelectedIds(event.target.checked ? visibleDrafts.map((draft) => draft.id) : [])} />全选</label>{selectedIds.length > 0 && <div className="publish-bulk-actions"><span>已选 {selectedIds.length} 件商品组</span>{activeStage === "ready" && <button className="primary-button" type="button" onClick={() => setConfirmBatch(true)}>批量确认发布</button>}<button className="secondary-button" type="button" disabled={bulkMoveMutation.isPending} onClick={() => bulkMoveMutation.mutate({ ids: selectedIds, workflowStage: bulkReturnStage })}>{activeStage === "collected" ? "批量加入加工箱" : activeStage === "ready" ? "退回加工箱" : "移回采集箱"}</button><button className="secondary-button" type="button" disabled={bulkDeleteMutation.isPending} onClick={() => bulkDeleteMutation.mutate(selectedIds)}>批量删除</button></div>}</div>
        {draftsQuery.isLoading ? <div className="publish-draft-empty"><RefreshCw className="is-spinning" size={20} />正在读取商品草稿…</div> : visibleDrafts.length === 0 ? <div className="publish-draft-empty"><PackageCheck size={24} /><strong>{activeStage === "collected" ? "采集箱还是空的" : activeStage === "processing" ? "暂时没有待加工商品" : "当前没有待上架商品"}</strong><span>{activeStage === "ready" ? "商品完成预检并保存后会出现在这里。" : "粘贴 Ozon 或 1688 商品链接即可批量采集并创建商品草稿。"}</span>{activeStage !== "ready" && <><button className="link-button" type="button" onClick={() => { setCollectModal(true); setCollectMessage(""); }}><Link2 size={15} />粘贴商品链接并采集</button><Link to="/operations/publish/extension">查看浏览器插件状态 <ArrowRight size={15} /></Link></>}</div> : (
          <div className="publish-draft-list">
            {visibleDrafts.map((draft) => {
              const source = draft.sourceSnapshot;
              const image = source.images[0]?.url || source.imageUrl;
              return <article className="publish-draft-row" key={draft.id}>
                <label className="publish-row-select"><input type="checkbox" aria-label={`选择 ${draft.title || source.productName || draft.sourceSku}`} checked={selectedIds.includes(draft.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, draft.id] : current.filter((id) => id !== draft.id))} /></label>
                <div className="publish-draft-row__image">{image ? <ProductImage key={image} src={image} alt={`${draft.title || source.productName} 商品图`} fallbackLabel="暂无图片" /> : <PackageCheck size={22} aria-hidden="true" />}</div>
                <div className="publish-draft-row__content"><div className="publish-draft-row__title"><strong>{draft.title || source.productName || "未命名商品"}</strong><span>{stageLabels[draft.workflowStage]}</span></div><p>{draft.sourceType === "1688_collector" ? "1688 采集" : draft.sourceType === "public_page" ? "Ozon 链接采集" : draft.sourceType === "json_import" ? "商品包导入" : draft.sourceType} · SKU {draft.sourceSku || "待填写"} · {draft.variants.length} 个变体</p><small>{source.images.length} 张图片 · {draft.sourceType === "public_page" ? "来源售价" : "供货价"} {String(draft.sourceType === "public_page" ? source.currentPrice.amount || "未识别" : draft.fieldOverrides.supplierPriceRange || draft.fieldOverrides.supplierPrice || "待补充")} {draft.fieldOverrides.supplierPlatform === "1688" ? "CNY" : source.currentPrice.currency} · 更新于 {new Date(draft.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</small></div>
                <div className="publish-draft-row__actions">{activeStage === "collected" ? <button className="secondary-button" type="button" disabled={moveMutation.isPending} onClick={() => moveMutation.mutate({ id: draft.id, workflowStage: "processing" })}>加入加工箱 <ArrowRight size={15} /></button> : <button className="primary-button" type="button" onClick={() => navigate(`/operations/publish/drafts/${encodeURIComponent(draft.id)}`)}>{activeStage === "ready" ? "去上架" : "编辑商品"} <ArrowRight size={15} /></button>}<button className="icon-button" type="button" aria-label="删除草稿" title="删除草稿" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate(draft.id)}><Trash2 size={16} /></button></div>
              </article>;
            })}
          </div>
        )}
      </section>
      {collectModal && <div className="dialog-backdrop" role="presentation"><section className="dialog collect-links-dialog" role="dialog" aria-modal="true" aria-labelledby="collect-links-title"><div className="dialog-heading"><div><p className="eyebrow">COLLECT PRODUCTS</p><h2 id="collect-links-title">一键采集</h2></div><button className="icon-button" type="button" onClick={() => setCollectModal(false)} aria-label="关闭">×</button></div><p>粘贴 Ozon 或 1688 商品详情页链接，每行一个，最多提交 50 条。浏览器插件会逐条读取商品信息并加入采集箱。</p><label className="collect-links-label" htmlFor="collect-links-input">采集链接 <small>已识别 {new Set(collectUrls.split(/[\n\r\t ,]+/).map((value) => value.trim()).filter(isSupportedProductUrl)).size} 条有效链接</small></label><textarea id="collect-links-input" value={collectUrls} onChange={(event) => setCollectUrls(event.target.value)} placeholder={"https://www.ozon.ru/product/...\nhttps://detail.1688.com/offer/..."} rows={8} disabled={collecting} />{collectMessage && <p className="collect-links-status" role="status">{collectMessage}</p>}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setCollectModal(false)}>取消</button><button className="primary-button" type="button" disabled={collecting || !collectUrls.trim()} onClick={submitCollection}>{collecting ? "正在采集…" : "提交采集"}</button></div></section></div>}
      {batchResult && <section className="publish-batch-result" aria-live="polite"><strong>批量发布结果</strong>{batchResult.submitted.map((group) => <p key={group.draftId}>已提交：{group.title || group.draftId} · {group.tasks.length} 个变体</p>)}{batchResult.skipped.map((group) => <p className="field-error" key={group.draftId}>已跳过：{group.title || group.draftId} · {group.reason}</p>)}</section>}
      {confirmBatch && <div className="dialog-backdrop" role="presentation"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="publish-batch-confirm-title"><div className="dialog-heading"><div><p className="eyebrow">BATCH LISTING</p><h2 id="publish-batch-confirm-title">确认批量发布</h2></div><button className="icon-button" type="button" onClick={() => setConfirmBatch(false)} aria-label="取消">×</button></div><p>即将向目标 Ozon 店铺提交以下商品组。每组会按变体分别创建任务；关闭此窗口不会发起 Ozon 写入。</p><ul>{drafts.filter((draft) => selectedIds.includes(draft.id)).map((draft) => <li key={draft.id}>{draft.title || draft.sourceSku} · {draft.variants.length} 个变体</li>)}</ul>{batchSubmitMutation.error && <p className="field-error" role="alert">{batchSubmitMutation.error.message}</p>}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setConfirmBatch(false)}>取消</button><button className="primary-button" type="button" disabled={batchSubmitMutation.isPending} onClick={() => batchSubmitMutation.mutate()}>{batchSubmitMutation.isPending ? "正在预检并提交…" : "确认提交所选商品组"}</button></div></section></div>}
      {(draftsQuery.error || moveMutation.error || deleteMutation.error) && <p className="field-error" role="alert">{(draftsQuery.error || moveMutation.error || deleteMutation.error)?.message}</p>}
    </main>
  );
}
