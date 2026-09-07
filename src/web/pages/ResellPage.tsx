import { ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, CircleAlert, ClipboardCheck, ExternalLink, FileJson, ImagePlus, PackagePlus, RefreshCw, Rocket, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";

import type { FulfillmentMode, PublishSourceType, ResellImageView, ResellMode, ResellPackageDimensions, ResellPreflightInput, ResellPreflightView, ResellSourceView, ResellStatus } from "../../shared/contracts";
import { ApiRequestError, createPublishTask, createPublishDraft, enrichPublishSource, fetchResellSource, fetchResellTask, fetchStores, preflightPublish, previewPublishPackage, retryResellTask, setResellTaskStock, updatePublishDraft, uploadResellImage } from "../api";
import { hasPublishAttributeValue } from "../../shared/publish-attributes";
import { AppNav } from "../components/AppNav";
import { formatMoney } from "../format";
import { mergeSellerSource } from "../../shared/publish-source";

const statusLabels: Record<ResellStatus, string> = {
  draft: "草稿",
  preflight_failed: "预检失败",
  creating: "创建中",
  pending: "等待 Ozon 处理",
  created: "商品已创建",
  setting_images: "正在上传商品图片",
  setting_price: "正在设置价格",
  setting_stock: "正在设置库存",
  stock_pending: "库存待设置",
  moderating: "等待审核或打标",
  sellable: "已提交并完成库存配置",
  needs_input: "需要补充信息",
  failed: "失败",
};

const activeStatuses: ResellStatus[] = ["creating", "pending", "created", "setting_images", "setting_price", "setting_stock"];
const LAST_PUBLISH_STORE_KEY = "ozon-gmv:last-publish-store-id";

const ATTRIBUTE_TRANSLATIONS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^бренд$/i, label: "品牌" },
  { pattern: /^название модели/i, label: "型号名称" },
  { pattern: /^тип$/i, label: "类型" },
  { pattern: /материал/i, label: "材质" },
  { pattern: /цвет/i, label: "颜色" },
  { pattern: /размер/i, label: "尺寸" },
  { pattern: /страна/i, label: "国家" },
  { pattern: /комплектац/i, label: "套装内容" },
  { pattern: /штрихкод|баркод/i, label: "条形码" },
  { pattern: /вес/i, label: "重量" },
  { pattern: /длина/i, label: "长度" },
  { pattern: /ширина/i, label: "宽度" },
  { pattern: /высота/i, label: "高度" },
  { pattern: /объем/i, label: "容量" },
  { pattern: /мощность/i, label: "功率" },
  { pattern: /назначение/i, label: "用途" },
  { pattern: /модель/i, label: "型号" },
];

const ATTRIBUTE_ID_TRANSLATIONS: Record<number, string> = {
  85: "品牌",
  8229: "商品类型",
  9048: "型号名称",
};

function translatedAttributeName(name: string, id: number): string {
  const normalized = name.trim();
  const translation = ATTRIBUTE_ID_TRANSLATIONS[id] ?? ATTRIBUTE_TRANSLATIONS.find((item) => item.pattern.test(normalized))?.label;
  return translation && !normalized.includes(translation) ? `${normalized}（${translation}）` : normalized;
}

function translatedValidationMessage(message: string): string {
  return message.replace(/Бренд/gi, (match) => `${match}（品牌）`);
}

function isMissingRequiredAttributeMessage(message: string): boolean {
  return /缺少(?:必填商品属性|属性)：/u.test(message) || /missing.*attribute|attribute.*empty/i.test(message);
}

function attributeSelectionValues(value: unknown, options: Array<{ id: string; name: string }>): string[] {
  const rawValues = Array.isArray(value) ? value : [value];
  return rawValues.flatMap((rawValue) => {
    if (rawValue === undefined || rawValue === null) return [];
    if (typeof rawValue === "object") {
      const record = rawValue as Record<string, unknown>;
      const nested = record.dictionary_value_id ?? record.dictionaryValueId ?? record.value;
      return nested === undefined ? [] : [String(nested)];
    }
    return [String(rawValue)];
  }).map((rawValue) => options.find((option) => option.id === rawValue)?.id
    ?? options.find((option) => option.name.trim().toLocaleLowerCase() === rawValue.trim().toLocaleLowerCase())?.id
    ?? rawValue);
}

/** Parses the compact attribute object while keeping malformed input recoverable. */
function parseAttributeObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Identifies Ozon's brand attribute, including category-specific brand labels. */
function isBrandAttribute(attribute: { id: number; name: string }): boolean {
  return attribute.id === 31 || /бренд/i.test(attribute.name);
}

/** Finds Ozon's official no-brand dictionary value without inventing an ID. */
function noBrandOption(options: Array<{ id: string; name: string }>): { id: string; name: string } | undefined {
  return options.find((option) => /^(без\s+бренд|нет\s+бренд|no\s+brand|无品牌)/i.test(option.name.trim()));
}

/**
 * Converts a no-brand label into the target dictionary ID before retrying
 * preflight. Ozon rejects readable labels for dictionary attributes.
 */
function noBrandPreflightInput(result: ResellPreflightView, input: ResellPreflightInput): ResellPreflightInput | null {
  const attributes = { ...(input.attributes ?? result.source.attributes ?? {}) };
  let changed = false;
  for (const attribute of result.requiredAttributes) {
    if (!isBrandAttribute(attribute)) continue;
    const option = noBrandOption(attribute.dictionaryValues ?? []);
    if (!option) continue;
    const current = readAttributeValue(attributes, attribute.id);
    const selected = attributeSelectionValues(current, attribute.dictionaryValues ?? []);
    const isNoBrandLabel = typeof current === "string" && /^(без\s+бренд|нет\s+бренд|no\s+brand|无品牌)/i.test(current.trim());
    if (!hasPublishAttributeValue(current) || (isNoBrandLabel && selected[0] !== option.id)) {
      attributes[String(attribute.id)] = option.id;
      changed = true;
    }
  }
  return changed ? { ...input, attributes } : null;
}

function displayDictionaryValueName(name: string): string {
  return /^(без\s+бренд|нет\s+бренд|no\s+brand|无品牌)/i.test(name.trim()) ? `${name}（无品牌）` : name;
}

type SellerSyncPhase = "idle" | "reading" | "merging" | "resolving" | "checking" | "success" | "error";

function sellerSyncPhaseLabel(phase: SellerSyncPhase): string {
  return {
    idle: "读取 Seller 补全",
    reading: "正在读取…",
    merging: "正在合并…",
    resolving: "正在解析…",
    checking: "正在检查…",
    success: "Seller 补全完成",
    error: "重新读取 Seller 补全",
  }[phase];
}

function readLastPublishStoreId(): string {
  try {
    return window.localStorage.getItem(LAST_PUBLISH_STORE_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberPublishStoreId(storeId: string): void {
  if (!storeId) return;
  try {
    window.localStorage.setItem(LAST_PUBLISH_STORE_KEY, storeId);
  } catch {
    // Private browsing can deny storage; the current selection still works.
  }
}

function markEditedField(editedFields: Set<string>, field: string): void {
  editedFields.add(field);
}

function parsePositiveId(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function numberPrice(value: string): number {
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

function defaultPrice(amount: string, monthlySales: string, monthlyUnits: number): string {
  if (numberPrice(amount) > 0) return amount;
  if (monthlyUnits > 0 && numberPrice(monthlySales) > 0) return (numberPrice(monthlySales) / monthlyUnits).toFixed(2);
  return "";
}

/** Reads an editor attribute in either compact or Seller/Ozon-shaped form. */
function readAttributeValue(attributes: Record<string, unknown>, id: number): unknown {
  return attributes[String(id)] ?? attributes[`attribute_${id}`];
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

interface PublishCompleteness {
  completed: number;
  total: number;
  missing: string[];
}

/** Summarizes the user-facing fields without exposing transport-only IDs. */
function getPublishCompleteness(input: {
  title: string;
  images: ResellImageView[];
  price: string;
  currency: string;
  typeId: string;
  storeId: string;
  warehouseId: string;
  packageDimensions: ResellPackageDimensions;
  requiredAttributes: Array<{ id: number }>;
  attributes: Record<string, unknown>;
}): PublishCompleteness {
  const missing: string[] = [];
  const checks = [
    [Boolean(input.title.trim()), "商品标题"],
    [input.images.length > 0, "商品图片"],
    [Boolean(input.price.trim()), "销售价"],
    [Boolean(input.currency.trim()), "币种"],
    [Boolean(parsePositiveId(input.typeId)), "商品类型 ID"],
    [Boolean(input.storeId), "目标店铺"],
    [Boolean(input.warehouseId), "仓库"],
    [[
      input.packageDimensions.depth,
      input.packageDimensions.width,
      input.packageDimensions.height,
      input.packageDimensions.weight,
    ].every((value) => Number.isFinite(Number(value)) && Number(value) > 0), "包装尺寸与重量"],
  ] as const;
  for (const [complete, label] of checks) {
    if (!complete) missing.push(label);
  }
  const attributes = input.requiredAttributes;
  let completedAttributes = 0;
  for (const attribute of attributes) {
    const value = readAttributeValue(input.attributes, attribute.id);
    const hasValue = hasPublishAttributeValue(value);
    if (hasValue) completedAttributes += 1;
    else missing.push(`属性 ${attribute.id}`);
  }
  return {
    completed: checks.filter(([complete]) => complete).length + completedAttributes,
    total: checks.length + attributes.length,
    missing,
  };
}

function emptySource(sourceType: PublishSourceType, sku = ""): ResellSourceView {
  return {
    sku,
    productName: "",
    sourceType,
    typeId: null,
    descriptionCategoryId: null,
    currentPrice: { amount: "0", currency: "RUB" },
    productUrl: "",
    imageUrl: null,
    images: [],
    monthlyUnits: 0,
    monthlySales: { amount: "0", currency: "RUB" },
    captureDay: "",
  };
}

function sourceLabel(sourceType: PublishSourceType): string {
  return {
    follow_sell: "MY 跟卖",
    normal_publish: "普通发布",
    json_import: "JSON 导入",
    seller_bridge: "Seller 补全",
    public_page: "公开商品页",
  }[sourceType];
}

function inputFromState(state: {
  sku: string;
  sourceType: PublishSourceType;
  sourceSnapshot?: ResellSourceView;
  idempotencyKey: string;
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
  brand: string;
  category: string;
  description: string;
  attributesText: string;
  typeId: string;
  descriptionCategoryId: string;
  packageDimensions: ResellPackageDimensions;
  barcode: string;
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
      attributes = undefined;
    }
  }
  const sourceSnapshot = state.sourceSnapshot
    ? {
      ...state.sourceSnapshot,
      productName: state.title.trim(),
      ...(state.brand.trim() ? { brand: state.brand.trim() } : { brand: "" }),
      ...(state.category.trim() ? { category: state.category.trim() } : { category: "" }),
      ...(state.description.trim() ? { description: state.description.trim() } : { description: "" }),
      // Visible inputs are the source of truth, so clearing an automatically
      // populated ID also clears it from the request payload.
      typeId: parsePositiveId(state.typeId),
      descriptionCategoryId: parsePositiveId(state.descriptionCategoryId),
      packageDimensions: state.packageDimensions,
      ...(state.barcode.trim() ? { barcode: state.barcode.trim() } : {}),
    }
    : undefined;
  return {
    sourceSku: state.sku,
    sourceType: state.sourceType,
    ...(sourceSnapshot ? { sourceSnapshot } : {}),
    ...(state.idempotencyKey ? { idempotencyKey: state.idempotencyKey } : {}),
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
    packageDimensions: state.packageDimensions,
    images: state.images.map((image, position) => image.source === "uploaded"
      ? { assetId: image.id, position }
      : { sourceUrl: image.url, position }),
  };
}

function taskStatusTone(status: ResellStatus): string {
  if (status === "sellable") return "resell-status--success";
  if (["failed", "preflight_failed", "needs_input"].includes(status)) return "resell-status--error";
  if (["moderating", "stock_pending"].includes(status)) return "resell-status--warning";
  return "resell-status--active";
}

/** Provides a guarded single-product publishing workflow for follow-sale and normal listings. */
export default function ResellPage(): React.JSX.Element {
  const { sku = "" } = useParams<{ sku: string }>();
  const navigate = useNavigate();
  const sourceQuery = useQuery({ queryKey: ["resell-source", sku], queryFn: () => fetchResellSource(sku), enabled: Boolean(sku) });
  const storesQuery = useQuery({ queryKey: ["stores"], queryFn: fetchStores });
  const [sourceType, setSourceType] = useState<PublishSourceType>(sku ? "follow_sell" : "normal_publish");
  const [sourceOverride, setSourceOverride] = useState<ResellSourceView | null>(null);
  const [storeId, setStoreId] = useState(() => readLastPublishStoreId());
  const [lastUsedStoreId, setLastUsedStoreId] = useState(() => readLastPublishStoreId());
  const [mode, setMode] = useState<ResellMode>(sku ? "quick" : "edit");
  const [offerId, setOfferId] = useState("");
  const [price, setPrice] = useState("");
  const [oldPrice, setOldPrice] = useState("");
  const [currency, setCurrency] = useState("RUB");
  const [vat, setVat] = useState("0");
  const [stock, setStock] = useState("2");
  const [fulfillmentMode, setFulfillmentMode] = useState<FulfillmentMode>("FBS");
  const [warehouseId, setWarehouseId] = useState("");
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [attributesText, setAttributesText] = useState("{}\n");
  const [typeId, setTypeId] = useState("");
  const [descriptionCategoryId, setDescriptionCategoryId] = useState("");
  const [packageDimensions, setPackageDimensions] = useState<ResellPackageDimensions>({
    depth: "",
    width: "",
    height: "",
    dimensionUnit: "mm",
    weight: "",
    weightUnit: "g",
  });
  const [barcode, setBarcode] = useState("");
  const [preflight, setPreflight] = useState<ResellPreflightView | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [images, setImages] = useState<ResellImageView[]>([]);
  const [sellerSyncPhase, setSellerSyncPhase] = useState<SellerSyncPhase>("idle");
  const [sellerSyncMessage, setSellerSyncMessage] = useState("");
  const [manualImageEdits, setManualImageEdits] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const editedFieldsRef = useRef<Set<string>>(new Set());
  const autoEnrichmentKeyRef = useRef("");
  const sellerSyncInFlightRef = useRef(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const replaceIndexRef = useRef<number | null>(null);
  const packageInputRef = useRef<HTMLInputElement>(null);

  const selectedStore = storesQuery.data?.find((store) => store.id === storeId);
  const enabledStores = useMemo(() => (storesQuery.data ?? []).filter((store) => store.enabled), [storesQuery.data]);
  const lastUsedStore = enabledStores.find((store) => store.id === lastUsedStoreId);
  const source = useMemo(() => sourceOverride ?? sourceQuery.data ?? emptySource(sourceType, sku), [sourceOverride, sourceQuery.data, sourceType, sku]);
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
    if (!source) return;
    setTitle((current) => current || source.productName);
    setBrand((current) => current || source.brand || "");
    setCategory((current) => current || source.category || "");
    setDescription((current) => current || source.description || "");
    setTypeId((current) => current || (source.typeId ? String(source.typeId) : ""));
    setDescriptionCategoryId((current) => current || (source.descriptionCategoryId ? String(source.descriptionCategoryId) : ""));
    if (source.packageDimensions) {
      setPackageDimensions((current) => ({
        depth: current.depth || source.packageDimensions?.depth || "",
        width: current.width || source.packageDimensions?.width || "",
        height: current.height || source.packageDimensions?.height || "",
        dimensionUnit: current.dimensionUnit || source.packageDimensions?.dimensionUnit || "mm",
        weight: current.weight || source.packageDimensions?.weight || "",
        weightUnit: current.weightUnit || source.packageDimensions?.weightUnit || "g",
      }));
    }
    setBarcode((current) => current || source.barcode || "");
    setPrice((current) => current || defaultPrice(source.currentPrice.amount, source.monthlySales.amount, source.monthlyUnits));
    setOfferId((current) => current || `${sourceType === "follow_sell" ? "MY" : "OZON"}-${source.sku || "NEW"}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80));
    setImages((current) => current.length > 0 ? current : source.images);
    if (source.attributes && Object.keys(source.attributes).length > 0) {
      setAttributesText((current) => current.trim() === "{}" ? `${JSON.stringify(source.attributes, null, 2)}\n` : current);
    }
  }, [source, sourceType]);

  useEffect(() => {
    if (enabledStores.length === 0) return;
    const preferredStore = enabledStores.find((store) => store.id === storeId)
      ?? enabledStores.find((store) => store.id === lastUsedStoreId)
      ?? enabledStores[0];
    if (!preferredStore) return;
    if (preferredStore.id !== storeId) {
      setStoreId(preferredStore.id);
      setFulfillmentMode(preferredStore.fulfillmentModes[0] ?? "FBS");
    }
    if (preferredStore.id !== lastUsedStoreId) {
      setLastUsedStoreId(preferredStore.id);
      rememberPublishStoreId(preferredStore.id);
    }
  }, [enabledStores, lastUsedStoreId, storeId]);

  useEffect(() => {
    if (selectedStore && !selectedStore.fulfillmentModes.includes(fulfillmentMode)) {
      setFulfillmentMode(selectedStore.fulfillmentModes[0] ?? "FBS");
    }
  }, [fulfillmentMode, selectedStore]);

  const formState = useMemo(() => ({ sku: source.sku || sku, sourceType, sourceSnapshot: source, idempotencyKey, storeId, mode, offerId, price, oldPrice, currency, vat, stock, fulfillmentMode, warehouseId, title, brand, category, description, attributesText, typeId, descriptionCategoryId, packageDimensions, barcode, images }), [sku, source, sourceType, idempotencyKey, storeId, mode, offerId, price, oldPrice, currency, vat, stock, fulfillmentMode, warehouseId, title, brand, category, description, attributesText, typeId, descriptionCategoryId, packageDimensions, barcode, images]);
  const parsedAttributeValues = useMemo<Record<string, unknown>>(() => {
    try {
      const parsed: unknown = JSON.parse(attributesText);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }, [attributesText]);
  const completeness = useMemo(() => getPublishCompleteness({
    title,
    images,
    price,
    currency,
    typeId,
    storeId,
    warehouseId,
    packageDimensions,
    requiredAttributes: preflight?.requiredAttributes ?? [],
    attributes: parsedAttributeValues,
  }), [title, images, price, currency, typeId, storeId, warehouseId, packageDimensions, preflight?.requiredAttributes, parsedAttributeValues]);

  useEffect(() => {
    // Reconcile server validation with the values currently visible in the
    // editor. A preflight can finish before React applies an attribute edit,
    // leaving a stale error from a previous category or attribute set.
    if (!preflight) return;
    const missingRequiredFields = preflight.requiredAttributes
      .filter((attribute) => !hasPublishAttributeValue(readAttributeValue(parsedAttributeValues, attribute.id)))
      .map((attribute) => `${attribute.name}（属性 ID ${attribute.id}）`);
    const retainedErrors = preflight.errors.filter((error) => !isMissingRequiredAttributeMessage(error));
    const errors = missingRequiredFields.length > 0
      ? [...retainedErrors, `缺少必填商品属性：${missingRequiredFields.join("、")}`]
      : retainedErrors;
    const sameMissing = JSON.stringify(preflight.missingRequiredFields) === JSON.stringify(missingRequiredFields);
    const sameErrors = JSON.stringify(preflight.errors) === JSON.stringify(errors);
    if (sameMissing && sameErrors) return;
    setPreflight((current) => current
      ? { ...current, errors, missingRequiredFields, valid: errors.length === 0 }
      : current);
    setFormError((current) => {
      if (!current || !isMissingRequiredAttributeMessage(current)) return current;
      return missingRequiredFields.length > 0 ? `缺少必填商品属性：${missingRequiredFields.join("、")}` : null;
    });
  }, [parsedAttributeValues, preflight]);

  /** Applies an official no-brand value when the target category requires one. */
  function applyNoBrandDefaults(result: ResellPreflightView, forceAttribute = false): void {
    const brandAttribute = result.requiredAttributes.find(isBrandAttribute);
    const currentAttributes = parseAttributeObject(attributesText);
    const currentBrandAttributeValue = brandAttribute
      ? readAttributeValue(currentAttributes, brandAttribute.id)
      : undefined;
    const brandAlreadyKnown = Boolean(
      result.source.brand?.trim()
      || hasPublishAttributeValue(currentBrandAttributeValue)
      || hasPublishAttributeValue(brandAttribute?.value),
    );
    const option = brandAttribute ? noBrandOption(brandAttribute.dictionaryValues ?? []) : undefined;
    const resolvedNoBrandValue = option && String(brandAttribute?.value ?? "") === option.id;
    if (!editedFieldsRef.current.has("brand")) {
      setBrand((current) => current.trim() || result.source.brand?.trim() || (resolvedNoBrandValue || !brandAlreadyKnown ? option?.name ?? "Без бренда" : current));
    }
    if (!brandAttribute || editedFieldsRef.current.has("attributes") && !forceAttribute || !option) return;
    if (forceAttribute) markEditedField(editedFieldsRef.current, "attributes");
    setAttributesText((current) => {
      const attributes = parseAttributeObject(current);
      const currentValue = readAttributeValue(attributes, brandAttribute.id);
      if (!forceAttribute && hasPublishAttributeValue(currentValue)) return current;
      const value = hasPublishAttributeValue(brandAttribute.value) ? brandAttribute.value : option.id;
      return `${JSON.stringify({ ...attributes, [brandAttribute.id]: value }, null, 2)}\n`;
    });
  }

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
    mutationFn: (input: ResellPreflightInput) => preflightPublish(input),
    onSuccess: (result) => {
      setPreflight(result);
      // Target-store product info can resolve a missing type ID. Mirror the
      // resolved values into the form instead of leaving the user with a blank
      // field that would be sent again on the next action.
      // Preflight may only return target-store metadata. Keep the complete
      // source snapshot (including MY price/sales and Seller images) when it
      // is absent from that response.
      setSourceOverride((current) => current ? mergeSellerSource(current, result.source) : result.source);
      if (result.packageDimensions) setPackageDimensions(result.packageDimensions);
      setTypeId(result.source.typeId ? String(result.source.typeId) : "");
      setDescriptionCategoryId(result.source.descriptionCategoryId ? String(result.source.descriptionCategoryId) : "");
      applyNoBrandDefaults(result);
      if (result.contractCurrency && result.contractCurrency !== currency) {
        setCurrency(result.contractCurrency);
      }
      setFormError(result.errors.length > 0 ? result.errors.join("；") : null);
      setWarehouseId((current) => current || result.warehouses[0]?.id || "");
      if (result.mustUseEdit) {
        setMode("edit");
        setFormError("快速创建缺少目标类目必填属性或包装信息，已切换到编辑后发布；请补齐页面中的缺失字段。");
      }
    },
    onError: (error) => setFormError(error.message),
  });

  /** Re-runs preflight once with the target store's contract currency. */
  async function runPreflightWithContractCurrency(input: ResellPreflightInput): Promise<{ result: ResellPreflightView; input: ResellPreflightInput }> {
    let result = await preflightMutation.mutateAsync(input);
    if (!editedFieldsRef.current.has("attributes")) {
      const correctedNoBrandInput = noBrandPreflightInput(result, input);
      if (correctedNoBrandInput) {
        const correctedText = `${JSON.stringify(correctedNoBrandInput.attributes ?? {}, null, 2)}\n`;
        setAttributesText(correctedText);
        result = await preflightMutation.mutateAsync(correctedNoBrandInput);
        input = correctedNoBrandInput;
      }
    }
    if (result.contractCurrency && result.contractCurrency !== input.currency) {
      const correctedInput = { ...input, currency: result.contractCurrency };
      setCurrency(result.contractCurrency);
      result = await preflightMutation.mutateAsync(correctedInput);
      return { result, input: correctedInput };
    }
    return { result, input };
  }

  /** Re-runs validation in edit mode when quick creation is not safe. */
  async function runPreflightWithAutoMode(input: ResellPreflightInput): Promise<{ result: ResellPreflightView; input: ResellPreflightInput }> {
    const firstRun = await runPreflightWithContractCurrency(input);
    if (!firstRun.result.mustUseEdit || firstRun.input.mode !== "quick") {
      return firstRun;
    }
    setMode("edit");
    const editInput = { ...firstRun.input, mode: "edit" as const };
    return runPreflightWithContractCurrency(editInput);
  }

  const createMutation = useMutation({
    mutationFn: () => createPublishTask(inputFromState(formState)),
    onSuccess: (task) => {
      setConfirmOpen(false);
      setTaskId(task.id);
      setLastUsedStoreId(storeId);
      rememberPublishStoreId(storeId);
      setFormError(null);
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409 && typeof error.payload?.existingTaskId === "string") {
        setConfirmOpen(false);
        setTaskId(error.payload.existingTaskId);
        setFormError("该商品已有发布任务，已打开原任务；如果原任务失败，请在下方点击“重新提交任务”。");
        return;
      }
      setFormError(error.message);
    },
  });
  const saveDraftMutation = useMutation({
    mutationFn: async () => {
      const snapshot: ResellSourceView = {
        ...source,
        sourceType,
        sku: source.sku || sku,
        productName: title.trim(),
        description: description.trim(),
        brand: brand.trim(),
        category: category.trim(),
        typeId: parsePositiveId(typeId),
        descriptionCategoryId: parsePositiveId(descriptionCategoryId),
        packageDimensions,
        barcode: barcode.trim(),
        images,
      };
      const input = {
        sourceType,
        sourceSku: source.sku || sku,
        title: title.trim() || null,
        sourceSnapshot: snapshot,
        fieldOverrides: { offerId, price, oldPrice, currency, vat, stock, fulfillmentMode, warehouseId },
      };
      return draftId ? updatePublishDraft(draftId, input) : createPublishDraft(input);
    },
    onSuccess: (draft) => {
      setDraftId(draft.id);
      setDraftMessage("草稿已保存");
      setFormError(null);
    },
    onError: (error) => setDraftMessage(error.message),
  });
  const retryMutation = useMutation({
    mutationFn: () => retryResellTask(taskId!),
    onSuccess: (task) => setTaskId(task.id),
    onError: (error) => setFormError(error.message),
  });
  const stockMutation = useMutation({
    mutationFn: () => setResellTaskStock(taskId!),
    onSuccess: (task) => setTaskId(task.id),
    onError: (error) => setFormError(error.message),
  });

  async function openConfirmation(): Promise<void> {
    try {
      setFormError(null);
      let input = inputFromState(formState);
      if (!input.storeId || !input.offerId || !input.price) throw new Error("请先完成店铺、Offer ID 和价格配置");
      const vatError = validateVat(input.vat);
      if (vatError) throw new Error(vatError);
      if (images.length === 0) throw new Error("请至少添加一张商品图片，第一张将作为主图");
      let preflightRun = await runPreflightWithAutoMode(input);
      let result = preflightRun.result;
      input = preflightRun.input;
      const resolvedWarehouseId = input.warehouseId || result.warehouses[0]?.id || "";
      if (!input.warehouseId && resolvedWarehouseId) {
        setWarehouseId(resolvedWarehouseId);
        input = { ...input, warehouseId: resolvedWarehouseId };
        preflightRun = await runPreflightWithAutoMode(input);
        result = preflightRun.result;
        input = preflightRun.input;
      }
      if (!result.valid) throw new Error(result.errors.join("；") || "配置需要修正");
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
      markEditedField(editedFieldsRef.current, "images");
      setManualImageEdits(true);
      imageUploadMutation.mutate({ file, index: replaceIndexRef.current });
    }
    replaceIndexRef.current = null;
  }

  function updateRequiredAttribute(attributeId: number, value: string | string[]): void {
    markEditedField(editedFieldsRef.current, "attributes");
    setAttributesText((current) => `${JSON.stringify({ ...parseAttributeObject(current), [attributeId]: value }, null, 2)}\n`);
  }

  /** Explicitly selects the official no-brand value in both brand fields. */
  function applyNoBrandSelection(): void {
    markEditedField(editedFieldsRef.current, "brand");
    setBrand("Без бренда");
    if (preflight) applyNoBrandDefaults(preflight, true);
  }

  function updatePackageDimension(field: keyof ResellPackageDimensions, value: string): void {
    markEditedField(editedFieldsRef.current, "packageDimensions");
    setPackageDimensions((current) => ({ ...current, [field]: value }));
  }

  /** Opens the relevant section before moving focus to a missing publish field. */
  function focusMissingField(label: string): void {
    const fieldTargets: Record<string, string> = {
      商品标题: "publish-title-field",
      商品图片: "resell-images-heading",
      包装尺寸与重量: "package-fields-heading",
      目标店铺: "publish-store-label",
      销售价: "publish-price-field",
      币种: "publish-price-field",
      仓库: "publish-warehouse-field",
    };
    const targetId = fieldTargets[label] ?? "publish-advanced-section";
    const needsAdvanced = targetId === "publish-advanced-section";
    if (needsAdvanced) setAdvancedOpen(true);
    window.requestAnimationFrame(() => document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  /** Imports one product draft from a standard manifest.json folder package. */
  async function handlePackageFiles(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    try {
      setFormError(null);
      const preview = await previewPublishPackage(files);
      if (preview.errors.length > 0) throw new Error(preview.errors.join("；"));
      const manifestFile = files.find((file) => (file.webkitRelativePath || file.name).split("/").at(-1)?.toLowerCase() === "manifest.json");
      if (!manifestFile) throw new Error("文件夹中缺少 manifest.json");
      const manifest = JSON.parse(await manifestFile.text()) as { schemaVersion?: number; products?: Array<{ sku?: string; title?: string; description?: string; brand?: string; category?: string; attributes?: Record<string, unknown>; images?: Array<{ path?: string }> }> };
      const product = manifest.products?.[0];
      if (!product?.sku) throw new Error("manifest.json 没有可发布的商品 SKU");
      const fileMap = new Map(files.map((file) => [file.webkitRelativePath || file.name, file]));
      const importedImages: ResellImageView[] = [];
      for (const image of product.images ?? []) {
        if (!image.path) continue;
        const file = fileMap.get(image.path) ?? files.find((item) => (item.webkitRelativePath || item.name).endsWith(image.path!));
        if (!file) throw new Error(`图片文件不存在：${image.path}`);
        const uploaded = await uploadResellImage(file);
        importedImages.push({ ...uploaded, source: "uploaded" });
      }
      const nextSource: ResellSourceView = {
        ...emptySource("json_import", product.sku),
        productName: product.title ?? "",
        description: product.description ?? "",
        brand: product.brand ?? "",
        category: product.category ?? "",
        attributes: product.attributes ?? {},
        fieldSources: Object.fromEntries(["productName", "description", "brand", "category", "attributes"].map((field) => [field, "json_import"])),
        missingFields: [
          ...(product.title ? [] : ["商品标题"]),
          ...(importedImages.length > 0 ? [] : ["商品图片"]),
          ...(product.category ? [] : ["类目"]),
        ],
        images: importedImages,
      };
      await createPublishDraft({ sourceType: "json_import", sourceSku: product.sku, title: product.title ?? null, sourceSnapshot: nextSource });
      setSourceType("json_import");
      setSourceOverride(nextSource);
      setMode("edit");
      setManualImageEdits(true);
      setImages(importedImages);
      setTitle(product.title ?? "");
      setBrand(product.brand ?? "");
      setCategory(product.category ?? "");
      setDescription(product.description ?? "");
      setAttributesText(`${JSON.stringify(product.attributes ?? {}, null, 2)}\n`);
      setOfferId(`OZON-${product.sku}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80));
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "商品包导入失败");
    }
  }

  /** Requests an exact SKU snapshot from the installed Seller browser bridge. */
  async function requestSellerEnrichment(): Promise<void> {
    if (sellerSyncInFlightRef.current) return;
    if (!source.sku) {
      setFormError("请先选择 MY SKU 或导入 JSON 商品包");
      return;
    }
    if (!storeId) {
      setFormError("请先选择目标店铺");
      return;
    }
    sellerSyncInFlightRef.current = true;
    const requestId = crypto.randomUUID();
    let timeoutId: number | undefined;
    setSellerSyncPhase("reading");
    setSellerSyncMessage("正在连接 Seller，读取商品详情…");
    setFormError(null);
    const handleMessage = async (event: MessageEvent): Promise<void> => {
      const data = event.data as { type?: string; requestId?: string; snapshot?: ResellSourceView; error?: string };
      if (event.source !== window || data.type !== "OZON_GMV_SOURCE_SNAPSHOT" || data.requestId !== requestId) return;
      window.removeEventListener("message", handleMessage);
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      if (!data.snapshot) {
        sellerSyncInFlightRef.current = false;
        setSellerSyncPhase("error");
        setSellerSyncMessage(data.error ?? "Seller 未返回商品快照，请确认 Seller 已登录");
        setFormError(data.error ?? "Seller 补全没有返回商品快照，请确认 Seller 已登录");
        return;
      }
      setSellerSyncPhase("merging");
      setSellerSyncMessage("正在合并图片、标题和商品属性…");
      try {
        setSellerSyncPhase("resolving");
        setSellerSyncMessage("正在解析目标店铺商品类型…");
        // Always anchor the merge to the original MY response. A previous
        // Seller bridge response may contain zero analytics by design.
        const baseSource = sourceQuery.data ?? source;
        // The Seller bridge does not provide MY analytics or a reliable sale
        // price and represents those fields as zero. Keep the MY snapshot for
        // any non-positive bridge values instead of erasing usable data.
        const sellerCurrentPrice = numberPrice(data.snapshot.currentPrice.amount) > 0
          ? data.snapshot.currentPrice
          : baseSource.currentPrice;
        const sellerMonthlyUnits = data.snapshot.monthlyUnits > 0
          ? data.snapshot.monthlyUnits
          : baseSource.monthlyUnits;
        const sellerMonthlySales = numberPrice(data.snapshot.monthlySales.amount) > 0
          ? data.snapshot.monthlySales
          : baseSource.monthlySales;
        const sellerSnapshot: ResellSourceView = mergeSellerSource(baseSource, {
          ...data.snapshot,
          sourceType: "seller_bridge",
          sku: data.snapshot.sku || baseSource.sku,
          currentPrice: sellerCurrentPrice,
          monthlyUnits: sellerMonthlyUnits,
          monthlySales: sellerMonthlySales,
        } as ResellSourceView);
        const sellerSnapshotWithMissingFields: ResellSourceView = {
          ...sellerSnapshot,
          missingFields: [
            ...(sellerSnapshot.productName ? [] : ["商品标题"]),
            ...(sellerSnapshot.images.length > 0 ? [] : ["商品图片"]),
            ...(sellerSnapshot.category ? [] : ["类目"]),
            ...(sellerSnapshot.typeId ? [] : ["商品类型 ID"]),
          ],
        };
        const enrichedSource = await enrichPublishSource({
          storeId,
          sourceType: "seller_bridge",
          sourceSku: sellerSnapshotWithMissingFields.sku,
          sourceSnapshot: sellerSnapshotWithMissingFields,
        });
        // The enrichment endpoint is allowed to return only target-store
        // resolution fields. Merge it back onto the complete Seller/MY
        // snapshot so it cannot erase the price or analytics fallback.
        const nextSource = mergeSellerSource(sellerSnapshotWithMissingFields, enrichedSource);
        const isEdited = (field: string): boolean => editedFieldsRef.current.has(field);
        const nextTitle = isEdited("title") ? title : title || nextSource.productName;
        const nextDescription = isEdited("description") ? description : description || nextSource.description || "";
        const nextBrand = isEdited("brand") ? brand : brand || nextSource.brand || "";
        const nextCategory = isEdited("category") ? category : category || nextSource.category || "";
        const nextTypeId = isEdited("typeId") ? typeId : typeId || (nextSource.typeId ? String(nextSource.typeId) : "");
        const nextDescriptionCategoryId = isEdited("descriptionCategoryId")
          ? descriptionCategoryId
          : descriptionCategoryId || (nextSource.descriptionCategoryId ? String(nextSource.descriptionCategoryId) : "");
        const nextPackageDimensions = editedFieldsRef.current.has("packageDimensions")
          ? packageDimensions
          : {
            depth: packageDimensions.depth || nextSource.packageDimensions?.depth || "",
            width: packageDimensions.width || nextSource.packageDimensions?.width || "",
            height: packageDimensions.height || nextSource.packageDimensions?.height || "",
            dimensionUnit: packageDimensions.dimensionUnit || nextSource.packageDimensions?.dimensionUnit || "mm",
            weight: packageDimensions.weight || nextSource.packageDimensions?.weight || "",
            weightUnit: packageDimensions.weightUnit || nextSource.packageDimensions?.weightUnit || "g",
          };
        const nextBarcode = isEdited("barcode") ? barcode : barcode || nextSource.barcode || "";
        const nextAttributesText = !isEdited("attributes") && nextSource.attributes && Object.keys(nextSource.attributes).length > 0
          ? `${JSON.stringify(nextSource.attributes, null, 2)}\n`
          : attributesText;
        const nextImages = manualImageEdits || editedFieldsRef.current.has("images") ? images : nextSource.images;
        // The Seller bridge can finish before the source initialization effect has
        // committed its Offer ID and price state. Resolve those values from the
        // same snapshot before the preflight request to avoid sending empty strings.
        const resolvedSourceSku = nextSource.sku || sellerSnapshotWithMissingFields.sku || sku;
        const nextOfferId = editedFieldsRef.current.has("offerId")
          ? offerId
          : offerId || `${sourceType === "follow_sell" ? "MY" : "OZON"}-${resolvedSourceSku || "NEW"}`
            .replace(/[^A-Za-z0-9._-]/g, "-")
            .slice(0, 80);
        const nextPrice = editedFieldsRef.current.has("price")
          ? price
          : price || defaultPrice(nextSource.currentPrice.amount, nextSource.monthlySales.amount, nextSource.monthlyUnits);
        setSourceType("seller_bridge");
        setSourceOverride(nextSource);
        setOfferId(nextOfferId);
        setPrice(nextPrice);
        setImages(nextImages);
        setTitle(nextTitle);
        setDescription(nextDescription);
        setBrand(nextBrand);
        setCategory(nextCategory);
        setTypeId(nextTypeId);
        setDescriptionCategoryId(nextDescriptionCategoryId);
        setPackageDimensions(nextPackageDimensions);
        setBarcode(nextBarcode);
        setAttributesText(nextAttributesText);
        if (!nextOfferId.trim() || !nextPrice.trim()) {
          sellerSyncInFlightRef.current = false;
          setSellerSyncPhase("error");
          setSellerSyncMessage("Seller 补全完成，但 Offer ID 或销售价缺失");
          setFormError("Offer ID 和销售价不能为空，请先补填写后再提交");
          return;
        }
        setSellerSyncPhase("checking");
        setSellerSyncMessage("正在解析目标店铺商品类型并读取仓库…");
        const preflightRun = await runPreflightWithAutoMode(inputFromState({
          ...formState,
          sourceType: "seller_bridge",
          sourceSnapshot: nextSource,
          offerId: nextOfferId,
          price: nextPrice,
          title: nextTitle,
          brand: nextBrand,
          category: nextCategory,
          description: nextDescription,
          attributesText: nextAttributesText,
          typeId: nextTypeId,
          descriptionCategoryId: nextDescriptionCategoryId,
          packageDimensions: nextPackageDimensions,
          barcode: nextBarcode,
          images: nextImages,
        }));
        const result = preflightRun.result;
        if (!result.valid) {
          sellerSyncInFlightRef.current = false;
          setSellerSyncPhase("error");
          setSellerSyncMessage(result.errors.join("；") || "Seller 补全完成，但配置仍需修正");
          return;
        }
        const syncedImageCount = nextImages.length;
        sellerSyncInFlightRef.current = false;
        setSellerSyncPhase("success");
        setSellerSyncMessage(`Seller 补全完成 · 已同步 ${syncedImageCount} 张图片 · ${result.source.typeId ? "已获取商品类型 ID" : "商品类型 ID 待补充"}`);
        setFormError(null);
      } catch (error) {
        sellerSyncInFlightRef.current = false;
        const message = error instanceof Error ? error.message : "Seller 补全失败";
        setSellerSyncPhase("error");
        setSellerSyncMessage(message);
        setFormError(message);
      }
    };
    window.addEventListener("message", handleMessage);
    window.postMessage({ type: "OZON_GMV_REQUEST_SOURCE", requestId, sku: source.sku || sku }, "*");
    timeoutId = window.setTimeout(() => {
      window.removeEventListener("message", handleMessage);
      sellerSyncInFlightRef.current = false;
      setSellerSyncPhase("error");
      setSellerSyncMessage("Seller 请求超时，请刷新 Seller 页面后重试");
      setFormError("Seller 请求超时，请刷新 Seller 页面后重试");
    }, 60_000);
  }

  useEffect(() => {
    // Wait for the MY query to finish. The placeholder source contains only
    // the route SKU and zero metrics; starting enrichment against it would
    // erase the real MY price and sales before Seller returns.
    if (sourceType !== "follow_sell" || !sourceQuery.data || !sourceQuery.data.sku || !storeId || enabledStores.length === 0) return;
    const enrichmentKey = `${sourceQuery.data.sku}:${storeId}`;
    if (autoEnrichmentKeyRef.current === enrichmentKey || source.sourceType === "seller_bridge") return;
    autoEnrichmentKeyRef.current = enrichmentKey;
    void requestSellerEnrichment();
  }, [enabledStores.length, sourceQuery.data, source.sourceType, sourceType, storeId]);

  function moveImage(index: number, offset: number): void {
    const target = index + offset;
    if (target < 0 || target >= images.length) return;
    markEditedField(editedFieldsRef.current, "images");
    setManualImageEdits(true);
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

  function selectStore(nextStoreId: string): void {
    const nextStore = enabledStores.find((store) => store.id === nextStoreId);
    if (!nextStore) return;
    setStoreId(nextStore.id);
    setLastUsedStoreId(nextStore.id);
    setFulfillmentMode(nextStore.fulfillmentModes[0] ?? "FBS");
    rememberPublishStoreId(nextStore.id);
    setPreflight(null);
    setSellerSyncPhase("idle");
    setSellerSyncMessage("");
  }

  function handleStoreKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (enabledStores.length < 2) return;
    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % enabledStores.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + enabledStores.length) % enabledStores.length;
    if (nextIndex === index) return;
    event.preventDefault();
    const nextStore = enabledStores[nextIndex];
    if (!nextStore) return;
    selectStore(nextStore.id);
    window.requestAnimationFrame(() => document.getElementById(`publish-store-${nextStore.id}`)?.focus());
  }

  if (sourceQuery.isLoading || storesQuery.isLoading) return <div className="app-loading"><div className="brand-mark">O</div><div className="loading-line" /></div>;
  if (sku && (sourceQuery.error || !sourceQuery.data)) return <main className="admin-page"><AppNav /><section className="page-error resell-error"><h1>无法读取跟卖来源</h1><p>{sourceQuery.error?.message ?? "MY 数据中不存在该 SKU"}</p><Link className="secondary-button" to="/selection?tab=my-data">返回 MY 数据</Link></section></main>;

  const task = taskQuery.data;
  const productUrl = safeProductUrl(source.productUrl);
  const sourceDisplayPrice = numberPrice(source.currentPrice.amount) > 0
    ? source.currentPrice
    : { amount: defaultPrice(source.currentPrice.amount, source.monthlySales.amount, source.monthlyUnits), currency: source.monthlySales.currency };
  return (
    <div className="admin-page resell-page">
      <AppNav />
      <main className="resell-content">
        <div className="resell-breadcrumb"><button className="icon-button" type="button" onClick={() => navigate("/selection?tab=my-data")} aria-label="返回选品分析"><ArrowLeft size={19} /></button><span>选品分析</span><span>/</span><strong>商品发布</strong></div>
        <header className="resell-heading"><div><p className="eyebrow">OZON PRODUCT WORKBENCH</p><h1>商品发布工作台</h1><p>从 MY、JSON 文件夹或 Seller 补全创建商品草稿，统一编辑、预检并发布到目标店铺。</p><div className="publish-source-chips"><span className="publish-source-chip publish-source-chip--active">{sourceLabel(sourceType)}</span><span className="publish-completeness">已完成 {completeness.completed}/{completeness.total} 项</span>{completeness.missing.length > 0 && <span className="publish-completeness publish-completeness--warning">待补充 {completeness.missing.length} 项</span>}</div></div><ShieldCheck size={34} aria-hidden="true" /></header>
        <section className="publish-source-toolbar" aria-label="商品来源"><div><strong>选择来源</strong><span>跟卖入口会自动带入 MY SKU；普通商品可从标准商品包开始。</span></div><input ref={packageInputRef} className="visually-hidden" type="file" multiple accept="application/json,image/jpeg,image/png,image/webp" onChange={(event) => void handlePackageFiles(event)} {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)} /><button className="secondary-button" type="button" onClick={() => packageInputRef.current?.click()}><FileJson size={16} />从文件夹导入</button><button className="secondary-button" type="button" onClick={() => void requestSellerEnrichment()} disabled={!source.sku || ["reading", "merging", "resolving", "checking"].includes(sellerSyncPhase)}><RefreshCw size={16} className={sellerSyncPhase === "reading" || sellerSyncPhase === "merging" || sellerSyncPhase === "resolving" || sellerSyncPhase === "checking" ? "is-spinning" : undefined} />{sellerSyncPhaseLabel(sellerSyncPhase)}</button>{sellerSyncPhase !== "idle" && <div className={`seller-sync-status seller-sync-status--${sellerSyncPhase === "success" ? "success" : sellerSyncPhase === "error" ? "error" : "active"}`} role="status" aria-live="polite">{sellerSyncPhase === "success" ? <CheckCircle2 size={15} /> : sellerSyncPhase === "error" ? <CircleAlert size={15} /> : <RefreshCw size={15} className="is-spinning" />}{sellerSyncMessage}</div>}</section>
        <section className="resell-source-card resell-source-card--top" aria-label="来源商品摘要">
            <p className="eyebrow">SOURCE SUMMARY</p>
            <div className="resell-source-product"><span className="resell-source-image">{source.images[0] ? <img src={source.images[0].url} alt={`${source.productName || "商品"} 主图`} /> : <PackagePlus size={24} aria-label="无商品主图" />}</span><div><h2 title={source.productName}>{source.productName || "待填写商品标题"}</h2><p>Ozon SKU：<strong>{source.sku || "待填写"}</strong></p>{productUrl && <a href={productUrl} target="_blank" rel="noreferrer">打开原商品 <ExternalLink size={14} /></a>}</div></div>
            <dl className="resell-source-metrics"><div><dt>来源类型</dt><dd>{sourceLabel(sourceType)}</dd></div><div><dt>图片数量</dt><dd>{source.images.length} 张</dd></div><div><dt>来源日期</dt><dd>{source.captureDay || "—"}</dd></div></dl>
            <div className="publish-source-facts"><span>类目：{source.category || "待补充"}</span><span>品牌：{source.brand || "待补充"}</span><span>商品类型：{source.typeId ? "已自动匹配" : "待补充"}</span><span>属性：{preflight ? `${preflight.requiredAttributes.filter((attribute) => hasPublishAttributeValue(readAttributeValue(parsedAttributeValues, attribute.id))).length}/${preflight.requiredAttributes.length} 项已完成` : "等待预检"}</span><span>价格：{sourceDisplayPrice.amount ? formatMoney(sourceDisplayPrice) : "待补充"}</span><span>月销量：{source.monthlyUnits.toLocaleString("zh-CN")}</span></div>
            {(source.missingFields?.length ?? 0) > 0 && <div className="publish-missing-fields"><CircleAlert size={15} />缺失：{source.missingFields?.join("、")}</div>}
        </section>
        <div className="resell-layout">
          <section className="resell-form-card">
            <div className="resell-mode-switch" role="tablist" aria-label="发布模式"><button className={mode === "quick" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "quick"} onClick={() => setMode("quick")} disabled={sourceType !== "follow_sell"}>快速创建<span>按 SKU 复用商品卡</span></button><button className={mode === "edit" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "edit"} onClick={() => setMode("edit")}>编辑后发布<span>补充类目和商品属性</span></button></div>
            <details className="publish-collapsible-section" open>
              <summary><span><span className="eyebrow">PRODUCT MEDIA</span><strong>商品图片</strong><small>{images.length} 张 · 第一张为主图</small></span><span className="publish-summary-action">管理图片</span></summary>
              <section className="resell-image-editor" aria-labelledby="resell-images-heading"><div className="resell-image-editor__heading"><div><h3 id="resell-images-heading">商品图片</h3><p>第一张为主图，后续为副图；Ozon 会按此顺序替换整组图片。</p></div><button className="secondary-button compact-button" type="button" onClick={() => openImagePicker(null)} disabled={imageUploadMutation.isPending}><ImagePlus size={16} />{imageUploadMutation.isPending ? "上传中…" : "添加图片"}</button></div><input ref={imageInputRef} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleImageFile} />{images.length === 0 ? <div className="resell-image-empty"><PackagePlus size={24} /><span>暂无图片，请上传一张主图后再提交。</span></div> : <ol className="resell-image-list">{images.map((image, index) => <li className="resell-image-item" key={`${image.id}-${index}`}><img src={image.url} alt={`${index === 0 ? "主图" : `副图 ${index}`} ${image.fileName}`} loading="lazy" /><div className="resell-image-item__meta"><strong>{index === 0 ? "主图" : `副图 ${index}`}</strong><span title={image.fileName}>{image.fileName}</span><small>{image.source === "uploaded" ? "已上传至 OSS" : "来源商品图片"}</small></div><div className="resell-image-item__actions"><button className="icon-button" type="button" onClick={() => openImagePicker(index)} aria-label={`替换第 ${index + 1} 张图片`} disabled={imageUploadMutation.isPending}><RefreshCw size={15} /></button><button className="icon-button" type="button" onClick={() => moveImage(index, -1)} aria-label={`第 ${index + 1} 张图片上移`} disabled={index === 0}><ArrowUp size={15} /></button><button className="icon-button" type="button" onClick={() => moveImage(index, 1)} aria-label={`第 ${index + 1} 张图片下移`} disabled={index === images.length - 1}><ArrowDown size={15} /></button><button className="icon-button icon-button--danger" type="button" onClick={() => { markEditedField(editedFieldsRef.current, "images"); setManualImageEdits(true); setImages((current) => current.filter((_, itemIndex) => itemIndex !== index)); }} aria-label={`删除第 ${index + 1} 张图片`}><Trash2 size={15} /></button></div></li>)}</ol>}</section>
            </details>
            <div className="publish-section-heading"><p className="eyebrow">BASIC INFORMATION</p><h3>基础信息</h3><span>用户修改的字段会优先于来源补全。</span></div>
            <div className="resell-form-grid">
              <section className="field field--wide publish-store-field" aria-labelledby="publish-store-label"><span id="publish-store-label">目标店铺 * <small>已选 {storeId ? 1 : 0} / {enabledStores.length}</small></span><div className="publish-store-picker" role="radiogroup" aria-labelledby="publish-store-label">{enabledStores.map((store, index) => { const selected = store.id === storeId; return <button key={store.id} id={`publish-store-${store.id}`} className={`publish-store-option${selected ? " is-selected" : ""}`} type="button" role="radio" aria-checked={selected} onClick={() => selectStore(store.id)} onKeyDown={(event) => handleStoreKeyDown(event, index)}><span className="publish-store-option__name"><span className="publish-store-option__dot" style={{ backgroundColor: store.color }} aria-hidden="true" />{store.name}</span><span className="publish-store-option__modes">{store.fulfillmentModes.join(" · ")}</span>{selected && <CheckCircle2 size={16} aria-hidden="true" />}</button>; })}</div>{lastUsedStore && <small>上次发布店铺：{lastUsedStore.name}</small>}</section>
              <label className="field"><span>履约模式 *</span><select value={fulfillmentMode} onChange={(event) => setFulfillmentMode(event.target.value as FulfillmentMode)}>{(selectedStore?.fulfillmentModes ?? []).map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
              <label className="field" id="publish-price-field"><span>销售价 *</span><input inputMode="decimal" value={price} onChange={(event) => { markEditedField(editedFieldsRef.current, "price"); setPrice(event.target.value); }} placeholder="例如 1299" /></label>
              <label className="field"><span>币种 * {preflight?.contractCurrency && <small>目标店铺合同：{preflight.contractCurrency}</small>}</span><input value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} maxLength={3} /></label>
              <label className="field"><span>VAT *</span><input value={vat} onChange={(event) => setVat(event.target.value)} placeholder="例如 0 或 0.2" /><small>当前默认按中国店铺规则填写 0；其他国家请以目标店铺 Ozon 规则为准。</small>{vat.trim() && validateVat(vat) === null && Number(vat.replace(",", ".")) !== 0 && <small className="resell-vat-warning">当前 VAT 非 0，请确认与目标店铺国家税率一致。</small>}</label>
              <label className="field"><span>库存数量 *</span><input type="number" min="0" step="1" value={stock} onChange={(event) => setStock(event.target.value)} /><small>默认库存为 2，可按目标店铺实际库存修改。</small></label>
              <label className="field" id="publish-warehouse-field"><span>仓库 <small>库存可稍后设置</small></span><select value={warehouseId} onChange={(event) => setWarehouseId(event.target.value)}><option value="">未选择仓库（可稍后设置库存）</option>{(preflight?.warehouses ?? []).map((warehouse) => <option value={warehouse.id} key={warehouse.id}>{warehouse.name} · {warehouse.status}</option>)}</select></label>
              <section className="field field--wide publish-package-fields" aria-labelledby="package-fields-heading"><span id="package-fields-heading">包装尺寸与重量 * <small>必须填写真实包装数据</small></span><div className="publish-package-grid">{([['depth', '长度'], ['width', '宽度'], ['height', '高度'], ['weight', '重量']] as const).map(([key, label]) => <label className="field" key={key}><span>{label}</span><input inputMode="decimal" value={packageDimensions[key]} onChange={(event) => updatePackageDimension(key, event.target.value)} placeholder="必须大于 0" /></label>)}<label className="field"><span>尺寸单位</span><select value={packageDimensions.dimensionUnit} onChange={(event) => updatePackageDimension("dimensionUnit", event.target.value)}><option value="mm">mm</option><option value="cm">cm</option></select></label><label className="field"><span>重量单位</span><select value={packageDimensions.weightUnit} onChange={(event) => updatePackageDimension("weightUnit", event.target.value)}><option value="g">g</option><option value="kg">kg</option></select></label></div><small>Ozon 会按包装后的长度、宽度、高度和重量校验，不能填 0。</small></section>
              <label className="field field--wide" id="publish-title-field"><span>商品标题</span><input value={title} onChange={(event) => { markEditedField(editedFieldsRef.current, "title"); setTitle(event.target.value); }} maxLength={500} placeholder="请输入可售商品标题" /></label>
              <details id="publish-advanced-section" className="publish-advanced-section" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
                <summary>更多商品信息 <small>品牌、类目、条码和 Ozon 技术字段</small><span>{advancedOpen ? "收起" : "展开"}</span></summary>
                <div className="publish-advanced-grid">
                  <label className="field"><span>品牌 <small>按目标类目要求</small></span><div className="field-control-row"><input list="publish-brand-presets" value={brand} onChange={(event) => { markEditedField(editedFieldsRef.current, "brand"); setBrand(event.target.value); }} maxLength={300} placeholder="可选" /><button className="field-inline-action" type="button" onClick={applyNoBrandSelection}>无品牌</button></div><datalist id="publish-brand-presets"><option value="Без бренда" /></datalist></label>
                  <label className="field"><span>类目</span><input value={category} onChange={(event) => { markEditedField(editedFieldsRef.current, "category"); setCategory(event.target.value); }} maxLength={500} placeholder="可选" /></label>
                  <label className="field"><span>条码 <small>类目要求时必填</small></span><input value={barcode} onChange={(event) => { markEditedField(editedFieldsRef.current, "barcode"); setBarcode(event.target.value); }} maxLength={100} placeholder="可选" /></label>
                  <label className="field"><span>Offer ID <small>默认根据 SKU 生成</small></span><input value={offerId} onChange={(event) => { markEditedField(editedFieldsRef.current, "offerId"); setOfferId(event.target.value); }} maxLength={80} /></label>
                  <label className="field"><span>商品类型 ID * <small>{typeId ? (source.fieldSources?.typeId === "seller_bridge" ? "Seller 补全" : source.fieldSources?.typeId === "ozon_category_tree" ? "目标店铺类目树" : source.fieldSources?.typeId === "manual" ? "手动填写" : "Ozon 查询") : "缺失"}</small></span><input inputMode="numeric" value={typeId} onChange={(event) => { markEditedField(editedFieldsRef.current, "typeId"); setTypeId(event.target.value.replace(/\D/g, "")); setSourceOverride((current) => current ? { ...current, fieldSources: { ...(current.fieldSources ?? {}), typeId: "manual" } } : current); }} placeholder="Seller 补全后自动填入" aria-describedby="publish-type-id-help" /><small id="publish-type-id-help">已自动匹配时无需修改；必须是大于 0 的整数。</small></label>
                  <label className="field"><span>类目描述 ID <small>{descriptionCategoryId ? (source.fieldSources?.descriptionCategoryId === "ozon_category_tree" ? "目标店铺类目树" : source.fieldSources?.descriptionCategoryId === "manual" ? "手动填写" : "Ozon 查询") : "可选"}</small></span><input inputMode="numeric" value={descriptionCategoryId} onChange={(event) => { markEditedField(editedFieldsRef.current, "descriptionCategoryId"); setDescriptionCategoryId(event.target.value); setSourceOverride((current) => current ? { ...current, fieldSources: { ...(current.fieldSources ?? {}), descriptionCategoryId: "manual" } } : current); }} placeholder="可选" aria-describedby="publish-description-category-help" /><small id="publish-description-category-help">有官方返回值时自动填入，不能替代商品类型 ID。</small></label>
                  {mode === "edit" && <label className="field field--wide"><span>商品描述</span><textarea value={description} onChange={(event) => { markEditedField(editedFieldsRef.current, "description"); setDescription(event.target.value); }} rows={4} placeholder="可选；不要填写未验证的功效或合规声明" /></label>}
                  {mode === "edit" && <label className="field field--wide"><span>商品属性 JSON <small>高级</small></span><textarea value={attributesText} onChange={(event) => { markEditedField(editedFieldsRef.current, "attributes"); setAttributesText(event.target.value); }} rows={7} spellCheck={false} /><small>可粘贴 Seller 补全或 Ozon 类目属性 JSON；提交前会校验格式。</small></label>}
                </div>
              </details>
              {mode === "edit" && preflight && preflight.requiredAttributes.length > 0 && <section className="field field--wide publish-required-attributes" aria-labelledby="required-attributes-heading"><span id="required-attributes-heading">目标类目必填属性</span>{preflight.requiredAttributes.map((attribute) => { const values = attribute.dictionaryValues ?? []; const currentValue = readAttributeValue(parsedAttributeValues, attribute.id) ?? attribute.value; const selectedValues = attributeSelectionValues(currentValue, values); return <label className="field" key={attribute.id}><span>{translatedAttributeName(attribute.name, attribute.id)} * <small>ID {attribute.id}{attribute.dictionaryId ? ` · 字典 ${attribute.dictionaryId}` : ""}</small></span>{values.length > 0 ? <select multiple={attribute.isCollection} value={attribute.isCollection ? selectedValues : selectedValues[0] ?? ""} onChange={(event) => updateRequiredAttribute(attribute.id, attribute.isCollection ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value)}>{!attribute.isCollection && <option value="">请选择</option>}{values.map((option) => <option key={option.id} value={option.id}>{displayDictionaryValueName(option.name)}</option>)}</select> : <input value={typeof currentValue === "string" ? currentValue : ""} onChange={(event) => updateRequiredAttribute(attribute.id, event.target.value)} placeholder="请填写属性值" />}</label>; })}</section>}
            </div>
            <section className="publish-health-card" aria-labelledby="publish-health-heading"><div><p className="eyebrow">CONTENT CHECK</p><h3 id="publish-health-heading"><ClipboardCheck size={17} />内容体检 <span>{completeness.completed}/{completeness.total} 项</span></h3></div>{completeness.missing.length > 0 ? <div className="publish-health-list" role="status">{completeness.missing.slice(0, 4).map((item) => <button type="button" key={item} onClick={() => focusMissingField(item)}>{item}待补充</button>)}{completeness.missing.length > 4 && <span>另有 {completeness.missing.length - 4} 项待补充</span>}</div> : <p className="publish-health-success"><CheckCircle2 size={15} />核心字段已完成，提交时会再次自动检查</p>}</section>
            <div className="resell-actions"><button className="secondary-button" type="button" onClick={() => saveDraftMutation.mutate()} disabled={saveDraftMutation.isPending}>{saveDraftMutation.isPending ? "保存中…" : "保存草稿"}</button><button className="primary-button" type="button" onClick={() => void openConfirmation()} disabled={createMutation.isPending || preflightMutation.isPending || Boolean(taskId)}><Rocket size={17} />{preflightMutation.isPending ? "正在自动检查…" : "提交发布"}</button></div>
            {draftMessage && <p className="publish-draft-message" role="status">{draftMessage}</p>}
            {formError && <div className="field-error" role="alert"><CircleAlert size={17} />{formError}</div>}
            {preflight && <PreflightSummary result={preflight} completeness={completeness} />}
          </section>
          <aside className="publish-summary-card" aria-label="发布摘要">
            <p className="eyebrow">PUBLISH SUMMARY</p>
            <h2>发布摘要</h2>
            <dl className="publish-summary-list">
              <div><dt>目标店铺</dt><dd>{selectedStore?.name || "待选择"}</dd></div>
              <div><dt>来源</dt><dd>{sourceLabel(sourceType)}</dd></div>
              <div><dt>SKU / Offer ID</dt><dd>{source.sku || "普通商品"}<br />{offerId || "待填写"}</dd></div>
              <div><dt>价格 / VAT</dt><dd>{price || "—"} {currency} / {vat || "—"}</dd></div>
              <div><dt>库存</dt><dd>{stock || "—"} 件</dd></div>
              <div><dt>履约 / 仓库</dt><dd>{fulfillmentMode} / {(preflight?.warehouses.find((item) => item.id === warehouseId)?.name ?? warehouseId) || "自动读取中"}</dd></div>
              <div><dt>商品图片</dt><dd>{images.length} 张 · {images.length > 0 ? "主图已就绪" : "缺少主图"}</dd></div>
              <div><dt>内容体检</dt><dd>{completeness.completed}/{completeness.total} 项{completeness.missing.length > 0 ? ` · 待补充 ${completeness.missing.length} 项` : " · 已完成"}</dd></div>
            </dl>
            {completeness.missing.length > 0 && <p className="publish-summary-missing">待补充：{completeness.missing.slice(0, 3).join("、")}{completeness.missing.length > 3 ? ` 等 ${completeness.missing.length} 项` : ""}</p>}
            <p className="publish-summary-note"><CircleAlert size={15} />提交发布时会自动检查目标店铺、VAT、仓库和必填属性。</p>
          </aside>
        </div>
        {task && <TaskStatus task={task} onRetry={() => retryMutation.mutate()} retrying={retryMutation.isPending} onSetStock={() => stockMutation.mutate()} settingStock={stockMutation.isPending} />}
      </main>
      {confirmOpen && <div className="dialog-backdrop" role="presentation"><section className="dialog resell-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="resell-confirm-title"><div className="dialog-heading"><div><p className="eyebrow">ACTION CONFIRMATION</p><h2 id="resell-confirm-title">确认提交发布？</h2></div><button className="icon-button" type="button" onClick={() => setConfirmOpen(false)} aria-label="取消"><CircleAlert size={19} /></button></div><p>服务将使用目标店铺的 Seller API 创建商品、上传图片、设置价格并写入库存。Ozon 仍可能要求审核或补充资料。</p><dl className="resell-confirm-list"><div><dt>来源类型</dt><dd>{sourceLabel(sourceType)}</dd></div><div><dt>目标店铺</dt><dd>{selectedStore?.name ?? "—"}</dd></div><div><dt>SKU / Offer ID</dt><dd>{source.sku || "普通商品"} / {offerId}</dd></div><div><dt>图片</dt><dd>{images.length} 张（已上传 {images.filter((image) => image.source === "uploaded").length} 张）</dd></div><div><dt>价格 / 库存</dt><dd>{price} {currency} / {stock} 件</dd></div><div><dt>VAT</dt><dd>{vat}（请确认与目标店铺国家税率一致）</dd></div><div><dt>履约 / 仓库</dt><dd>{fulfillmentMode} / {preflight?.warehouses.find((item) => item.id === warehouseId)?.name ?? warehouseId}</dd></div></dl><div className="resell-confirm-thumbs">{images.slice(0, 6).map((image, index) => <img key={`${image.id}-${index}`} src={image.url} alt={`${index === 0 ? "主图" : "副图"}预览`} />)}</div>{preflight?.warnings.map((warning) => <p className="resell-warning" key={warning}><CircleAlert size={16} />{warning}</p>)}<div className="dialog-actions"><button className="secondary-button" type="button" onClick={() => setConfirmOpen(false)}>返回修改</button><button className="primary-button" type="button" onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>{createMutation.isPending ? "提交中…" : "确认发布"}</button></div></section></div>}
    </div>
  );
}

function PreflightSummary(props: { result: ResellPreflightView; completeness: PublishCompleteness }): React.JSX.Element {
  return <div className={props.result.valid ? "resell-preflight resell-preflight--valid" : "resell-preflight resell-preflight--invalid"} role={props.result.valid ? "status" : "alert"}><div><strong>{props.result.valid ? <><CheckCircle2 size={16} />内容体检通过 · {props.completeness.completed}/{props.completeness.total} 项</> : <><CircleAlert size={16} />内容体检需要修正 · {props.completeness.completed}/{props.completeness.total} 项</>}</strong>{props.result.errors.map((error) => <span key={error}>{translatedValidationMessage(error)}</span>)}{props.result.missingRequiredFields.length > 0 && <span>缺少属性：{props.result.missingRequiredFields.map(translatedValidationMessage).join("、")}</span>}{props.result.warnings.map((warning) => <span key={warning}>{translatedValidationMessage(warning)}</span>)}</div>{props.result.limits.dailyCreateRemaining !== null && <small>今日剩余创建额度：{props.result.limits.dailyCreateRemaining}</small>}</div>;
}

function TaskStatus(props: { task: Awaited<ReturnType<typeof fetchResellTask>>; onRetry: () => void; retrying: boolean; onSetStock: () => void; settingStock: boolean }): React.JSX.Element {
  const task = props.task;
  const hasError = ["failed", "needs_input"].includes(task.status);
  const canRetry = hasError && !task.productId;
  const canSetStock = task.status === "stock_pending" && Boolean(task.productId) && task.fulfillmentMode !== "FBO";
  const statusMessageIsError = hasError || task.status === "failed";
  return <section className="resell-task-card" aria-live="polite"><div className="resell-task-heading"><div><p className="eyebrow">PUBLISH TASK</p><h2>跟卖任务状态</h2></div><span className={`resell-status ${taskStatusTone(task.status)}`}>{statusMessageIsError ? <CircleAlert size={15} /> : task.status === "sellable" ? <CheckCircle2 size={15} /> : <RefreshCw size={15} />}{statusLabels[task.status]}</span></div><dl className="resell-task-meta"><div><dt>目标店铺</dt><dd>{task.storeName}</dd></div><div><dt>Ozon Task ID</dt><dd>{task.ozonTaskId ?? "等待返回"}</dd></div><div><dt>Product ID</dt><dd>{task.productId ?? "等待导入完成"}</dd></div><div><dt>{task.fulfillmentMode === "FBO" ? "库存说明" : "库存校验"}</dt><dd>{task.fulfillmentMode === "FBO" ? "FBO 库存需入 Ozon 仓库后产生" : task.actualStock !== undefined ? `请求 ${task.stock} 件 / 实际 ${task.actualStock ?? "未读到"} 件` : `${task.stock} 件`}</dd></div></dl>{task.stockCheckedAt && <p className="resell-task-stock-check">最后校验：{new Date(task.stockCheckedAt).toLocaleString("zh-CN")}</p>}{task.lastError && <div className={statusMessageIsError ? "field-error" : "resell-task-info"} role={statusMessageIsError ? "alert" : "status"}><CircleAlert size={17} />{task.lastError}</div>}{canSetStock && <button className="secondary-button compact-button" type="button" onClick={props.onSetStock} disabled={props.settingStock}>{props.settingStock ? "库存设置中…" : "稍后设置库存"}</button>}{task.productId && hasError && <p className="resell-warning"><CircleAlert size={16} />商品已在 Ozon 创建，请先修正已有商品，不要重复创建。</p>}{canRetry && <button className="secondary-button compact-button" type="button" onClick={props.onRetry} disabled={props.retrying}>{props.retrying ? "重新提交中…" : "重新提交任务"}</button>}</section>;
}
