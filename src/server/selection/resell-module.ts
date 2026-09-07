import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

import type {
  FulfillmentMode,
  PublishSourceType,
  ResellPreflightInput,
  ResellPreflightView,
  ResellPackageDimensions,
  ResellRequiredAttribute,
  ResellStockVerification,
  ResellSourceView,
  ResellStatus,
  ResellTaskDetailView,
  ResellTaskListItem,
  ResellTaskListPage,
  ResellTaskView,
  ResellWarehouseView,
} from "../../shared/contracts";
import type { AppConfig } from "../config";
import type { AppDatabase } from "../db/database";
import { StoresRepository, type StoreRecord } from "../db/stores-repository";
import { decryptSecret } from "../security/encryption";
import { OzonClient, type OzonCategoryAttribute, type OzonProductImportItemResult } from "../ozon/client";
import type { OzonDescriptionCategoryNode } from "../ozon/schemas";
import type { MyDataModule } from "./my-data-module";
import { ResellImageService } from "./resell-image-service";
import { hasPublishAttributeValue } from "../../shared/publish-attributes";

const DEFAULT_STOCK = 2;
const PENDING_IMPORT_POLL_INTERVAL_MS = 30_000;
const MAX_STOCK_POLLS = 6;
const STOCK_POLL_INTERVAL_MS = 2_000;

interface ResellTaskRow {
  id: string;
  store_id: string;
  source_sku: string;
  target_offer_id: string;
  mode: "quick" | "edit";
  price: string;
  old_price: string | null;
  currency: string;
  vat: string;
  stock: number;
  fulfillment_mode: FulfillmentMode;
  warehouse_id: string;
  title: string | null;
  description: string | null;
  attributes_json: string | null;
  ozon_task_id: string | null;
  product_id: string | null;
  status: ResellStatus;
  last_error: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  completed_at_ms: number | null;
  image_count: number;
  source_type: PublishSourceType;
  source_snapshot_json: string | null;
  idempotency_key: string | null;
}

interface ResellTaskInput extends ResellPreflightInput {
  title?: string | undefined;
  description?: string | undefined;
  attributes?: Record<string, unknown> | undefined;
}

interface ResellModuleOptions {
  fetchImplementation?: typeof fetch;
}

interface CategoryTreeCacheEntry {
  expiresAt: number;
  nodes: OzonDescriptionCategoryNode[];
}

const DEFAULT_CATEGORY_TREE_LANGUAGE = "DEFAULT";
const SIMPLIFIED_CHINESE_CATEGORY_TREE_LANGUAGE = "ZH_HANS";

// Seller bridge stores primary/secondary image URLs in these attributes. They
// are sent through the dedicated pictures endpoint, never as product fields.
const IMAGE_ATTRIBUTE_IDS = new Set([4194, 4195]);
const BARCODE_ATTRIBUTE_ID = 7822;

export interface ResellTaskListQuery {
  page: number;
  pageSize: number;
  storeId?: string | undefined;
  status?: ResellStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sourceSku?: string | undefined;
  sourceType?: PublishSourceType | undefined;
}

interface ResellTaskEventRow {
  status: ResellStatus;
  message: string | null;
  created_at_ms: number;
}

export class ResellValidationError extends Error {
  /** Optional task that caused a duplicate business-key conflict. */
  public constructor(public readonly errors: string[], public readonly existingTaskId?: string) {
    super(errors.join("；") || "跟卖参数不正确");
    this.name = "ResellValidationError";
  }
}

function isProcessedImportStatus(status: string): boolean {
  return status.toLowerCase() === "processed";
}

function isFailedImportStatus(status: string): boolean {
  return ["failed", "error", "rejected"].includes(status.toLowerCase());
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Ozon 请求失败";
  if (message.includes("error_attribute_values_empty")) {
    return `商品必填属性未填写：${message}`;
  }
  if (message.includes("missing_dimension")) {
    return `包装尺寸或重量缺失：${message}`;
  }
  if (message.includes("levels_category_not_found")) {
    return `目标店铺类目已变化，请重新读取类目树后再试：${message}`;
  }
  if (message.includes("description_category_is_empty")) {
    return `类目描述 ID 缺失，请重新读取 Seller 补全：${message}`;
  }
  if (message.includes("currency_differs_from_contract")) {
    return `币种与目标店铺合同不一致：${message}`;
  }
  return message;
}

function isPositiveMoney(value: string): boolean {
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) && number > 0;
}

function isPositiveTypeId(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Normalizes a real EAN/UPC/GTIN barcode and rejects synthetic OZN values. */
export function normalizeProductBarcode(value: string | null | undefined): string | null {
  const barcode = String(value ?? "").trim();
  if (!/^\d+$/.test(barcode) || /^OZN\d+$/i.test(barcode) || ![8, 12, 13, 14].includes(barcode.length)) {
    return null;
  }
  const digits = barcode.split("").map(Number);
  const checkDigit = digits.pop();
  if (checkDigit === undefined) return null;
  const checksum = digits.reduce((sum, digit, index) => {
    const fromRight = digits.length - index;
    return sum + digit * (fromRight % 2 === 1 ? 3 : 1);
  }, 0);
  return (10 - (checksum % 10)) % 10 === checkDigit ? barcode : null;
}

/** Identifies the generic and category-specific Ozon brand attributes. */
function isBrandAttributeDefinition(definition: { id: number; name: string }): boolean {
  return definition.id === 31 || definition.id === 85 || /бренд/i.test(definition.name);
}

function positiveMeasurement(value: string | undefined): boolean {
  const number = Number((value ?? "").replace(",", "."));
  return Number.isFinite(number) && number > 0;
}

function attributeValue(attributes: Record<string, unknown> | undefined, id: number): unknown {
  if (!attributes) return undefined;
  return attributes[String(id)] ?? attributes[`attribute_${id}`] ?? attributes[id as unknown as keyof typeof attributes];
}

function missingPackageDimensions(dimensions: ResellPackageDimensions | undefined): string[] {
  if (!dimensions) return ["包装长度", "包装宽度", "包装高度", "包装重量"];
  const missing: string[] = [];
  if (!positiveMeasurement(dimensions.depth)) missing.push("包装长度");
  if (!positiveMeasurement(dimensions.width)) missing.push("包装宽度");
  if (!positiveMeasurement(dimensions.height)) missing.push("包装高度");
  if (!dimensions.dimensionUnit.trim()) missing.push("尺寸单位");
  if (!positiveMeasurement(dimensions.weight)) missing.push("包装重量");
  if (!dimensions.weightUnit.trim()) missing.push("重量单位");
  return missing;
}

function requiredAttributeViews(
  definitions: OzonCategoryAttribute[],
  attributes: Record<string, unknown> | undefined,
  dictionaryValues: Map<number, Array<{ id: string; name: string }>> = new Map(),
): ResellRequiredAttribute[] {
  return definitions.filter((definition) => definition.required).map((definition) => {
    const values = dictionaryValues.get(definition.id);
    return {
      id: definition.id,
      name: definition.name,
      required: true,
      dictionaryId: definition.dictionaryId,
      isCollection: definition.isCollection,
      value: attributeValue(attributes, definition.id),
      ...(values ? { dictionaryValues: values } : {}),
    };
  });
}

/** Resolves readable dictionary labels to the IDs required by Ozon imports. */
function normalizeDictionaryAttributes(
  attributes: Record<string, unknown> | undefined,
  definitions: OzonCategoryAttribute[],
  dictionaryValues: Map<number, Array<{ id: string; name: string }>>,
): Record<string, unknown> | undefined {
  if (!attributes) return attributes;
  const normalized = { ...attributes };
  for (const definition of definitions) {
    if (!definition.dictionaryId) continue;
    const current = attributeValue(normalized, definition.id);
    if (current === undefined || current === null) continue;
    const options = dictionaryValues.get(definition.id) ?? [];
    const rawValues = Array.isArray(current) ? current : [current];
    const mappedValues = rawValues.map((value) => {
      if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const dictionaryValueId = record.dictionary_value_id ?? record.dictionaryValueId;
        if (dictionaryValueId !== undefined) return String(dictionaryValueId);
        value = record.value;
      }
      const text = String(value ?? "").trim();
      if (/^\d+$/.test(text)) return text;
      return options.find((option) => option.name.trim().toLocaleLowerCase() === text.toLocaleLowerCase())?.id ?? value;
    });
    const hasChanged = mappedValues.some((value, index) => String(value) !== String(rawValues[index]));
    if (hasChanged) normalized[String(definition.id)] = definition.isCollection ? mappedValues : mappedValues[0];
  }
  return normalized;
}

/** Converts the editor's compact `{attributeId: value}` shape to Ozon's array payload. */
export function normalizeOzonAttributes(attributes: Record<string, unknown> | undefined, definitions: OzonCategoryAttribute[] = []): Array<Record<string, unknown>> {
  if (!attributes) return [];
  const definitionsById = new Map(definitions.map((definition) => [String(definition.id), definition]));
  const byId = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(attributes)) {
    if (value && typeof value === "object" && !Array.isArray(value) && "values" in value) {
      const payload = value as Record<string, unknown>;
      const id = Number(payload.id ?? key.replace(/^attribute_/, ""));
      if (IMAGE_ATTRIBUTE_IDS.has(id) || id === BARCODE_ATTRIBUTE_ID) continue;
      if (!Number.isInteger(id) || id <= 0 || !hasPublishAttributeValue(payload.values)) continue;
      const current = byId.get(id);
      const values = Array.isArray(payload.values) ? payload.values : [payload.values];
      byId.set(id, current
        ? { ...current, values: dedupeAttributeValues([...(Array.isArray(current.values) ? current.values : [current.values]), ...values]) }
        : { ...payload, id, values: dedupeAttributeValues(values) });
      continue;
    }
    const id = Number(key.replace(/^attribute_/, ""));
    if (IMAGE_ATTRIBUTE_IDS.has(id) || id === BARCODE_ATTRIBUTE_ID) continue;
    if (!Number.isInteger(id) || id <= 0 || !hasPublishAttributeValue(value)) continue;
    const definition = definitionsById.get(String(id));
    const values = Array.isArray(value) ? value : [value];
    const payload = {
      id,
      values: dedupeAttributeValues(values.map((item) => {
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const dictionaryValueId = record.dictionary_value_id ?? record.dictionaryValueId;
          if (dictionaryValueId !== undefined && definition?.dictionaryId) {
            return { dictionary_value_id: Number(dictionaryValueId) };
          }
          if ("value" in record) item = record.value;
        }
        const numeric = Number(item);
        return definition?.dictionaryId && typeof item === "string" && Number.isInteger(numeric) && numeric > 0
          ? { dictionary_value_id: numeric }
          : { value: String(item) };
      })),
    };
    const current = byId.get(id);
    byId.set(id, current
      ? { ...current, values: dedupeAttributeValues([...(Array.isArray(current.values) ? current.values : [current.values]), ...payload.values]) }
      : payload);
  }
  return [...byId.values()];
}

function dedupeAttributeValues(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Only target-store verified or explicitly manual description IDs may reach Ozon. */
function verifiedDescriptionCategoryId(source: ResellSourceView): number | null {
  const fieldSource = source.fieldSources?.descriptionCategoryId;
  return (fieldSource === "ozon_category_tree" || fieldSource === "manual") && isPositiveTypeId(source.descriptionCategoryId)
    ? source.descriptionCategoryId
    : null;
}

function normalizeSourceImages(images: ResellSourceView["images"]): ResellSourceView["images"] {
  return (images ?? []).flatMap((image, index) => {
    if (!image || !/^https:\/\//i.test(image.url)) return [];
    const byteSize = Number.isInteger(image.byteSize) && image.byteSize >= 0 ? image.byteSize : 0;
    const width = Number.isInteger(image.width) && image.width > 0 ? image.width : 1;
    const height = Number.isInteger(image.height) && image.height > 0 ? image.height : 1;
    const id = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(image.id)
      ? image.id
      : randomUUID();
    return [{
      ...image,
      id,
      fileName: image.fileName || `来源图片 ${index + 1}`,
      mimeType: image.mimeType || "image/*",
      byteSize,
      width,
      height,
      source: "source" as const,
    }];
  });
}

function normalizeCategoryName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function categoryTreeLanguagesForSource(source: ResellSourceView): string[] {
  const categoryText = `${source.category ?? ""} ${source.productName ?? ""}`;
  return /[\u3400-\u9fff]/u.test(categoryText)
    ? [DEFAULT_CATEGORY_TREE_LANGUAGE, SIMPLIFIED_CHINESE_CATEGORY_TREE_LANGUAGE]
    : [DEFAULT_CATEGORY_TREE_LANGUAGE];
}

interface CategoryTypeLeaf {
  node: OzonDescriptionCategoryNode;
  descriptionCategoryId: number | null;
}

export interface ResolvedCategoryType {
  typeId: number;
  descriptionCategoryId: number | null;
}

function categoryLeafNodes(nodes: OzonDescriptionCategoryNode[]): CategoryTypeLeaf[] {
  const leaves: CategoryTypeLeaf[] = [];
  const visit = (items: OzonDescriptionCategoryNode[], parentDescriptionCategoryId: number | null): void => {
    for (const item of items) {
      const descriptionCategoryId = isPositiveTypeId(item.description_category_id)
        ? item.description_category_id
        : parentDescriptionCategoryId;
      if (isPositiveTypeId(item.type_id)) {
        leaves.push({ node: item, descriptionCategoryId });
      }
      visit(item.children, descriptionCategoryId);
    }
  };
  visit(nodes, null);
  return leaves;
}

function findCategoryTypeLeaf(source: ResellSourceView, nodes: OzonDescriptionCategoryNode[]): CategoryTypeLeaf | null {
  const leaves = categoryLeafNodes(nodes);
  if (isPositiveTypeId(source.descriptionCategoryId)) {
    const matches = leaves.filter((item) => item.descriptionCategoryId === source.descriptionCategoryId);
    const typeIds = [...new Set(matches.map((item) => item.node.type_id).filter(isPositiveTypeId))];
    if (typeIds.length === 1) {
      return matches.find((item) => item.node.type_id === typeIds[0]) ?? null;
    }
  }

  const names = [source.typeName, ...(source.category ?? "").split("/")]
    .map((value) => normalizeCategoryName(value ?? ""))
    .filter(Boolean);
  if (names.length === 0) {
    return null;
  }
  const matches = leaves.filter(({ node }) => [node.title, node.category_name, node.type_name]
    .some((label) => label && names.includes(normalizeCategoryName(label))));
  const typeIds = [...new Set(matches.map((item) => item.node.type_id).filter(isPositiveTypeId))];
  return typeIds.length === 1 ? matches.find((item) => item.node.type_id === typeIds[0]) ?? null : null;
}

export function resolveTypeDetailsFromCategoryTree(source: ResellSourceView, nodes: OzonDescriptionCategoryNode[]): ResolvedCategoryType | null {
  const match = findCategoryTypeLeaf(source, nodes);
  return match && isPositiveTypeId(match.node.type_id)
    ? { typeId: match.node.type_id, descriptionCategoryId: match.descriptionCategoryId }
    : null;
}

export function resolveTypeFromCategoryTree(source: ResellSourceView, nodes: OzonDescriptionCategoryNode[]): number | null {
  return resolveTypeDetailsFromCategoryTree(source, nodes)?.typeId ?? null;
}

function findTypeLeaf(nodes: OzonDescriptionCategoryNode[], typeId: number): CategoryTypeLeaf | null {
  const leaves = categoryLeafNodes(nodes);
  return leaves.find((item) => item.node.type_id === typeId) ?? null;
}

function taskView(row: ResellTaskRow, store: StoreRecord): ResellTaskView {
  let verification: ResellStockVerification | undefined;
  if (row.source_snapshot_json) {
    try {
      const snapshot = JSON.parse(row.source_snapshot_json) as ResellSourceView;
      verification = snapshot.stockVerification;
    } catch {
      // Historical snapshots are user data; a malformed optional field must
      // not prevent the task history from rendering.
    }
  }
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceSku: row.source_sku,
    storeId: row.store_id,
    storeName: store.name,
    targetOfferId: row.target_offer_id,
    mode: row.mode,
    price: { amount: row.price, currency: row.currency },
    oldPrice: row.old_price ? { amount: row.old_price, currency: row.currency } : null,
    vat: row.vat,
    stock: row.stock,
    imageCount: row.image_count,
    fulfillmentMode: row.fulfillment_mode,
    warehouseId: row.warehouse_id,
    status: row.status,
    ozonTaskId: row.ozon_task_id,
    productId: row.product_id,
    lastError: row.last_error,
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
    completedAt: row.completed_at_ms ? new Date(row.completed_at_ms).toISOString() : null,
    ...(verification ? { actualStock: verification.actual, stockCheckedAt: verification.checkedAt } : {}),
  };
}

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00+08:00`);
}

function dayAfterEndMs(day: string): number {
  return dayStartMs(day) + 24 * 60 * 60 * 1000;
}

/** Coordinates Ozon product reuse, target-store pricing, stock, and audit state. */
export class ResellModule {
  private readonly fetchImplementation: typeof fetch;
  private readonly categoryTreeCache = new Map<string, CategoryTreeCacheEntry>();
  private readonly activeTaskIds = new Set<string>();
  private pendingImportTimer: ReturnType<typeof setInterval> | null = null;
  private pendingImportPollRunning = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase,
    private readonly stores: StoresRepository,
    private readonly myData: MyDataModule,
    private readonly images: ResellImageService,
    options: ResellModuleOptions = {},
  ) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  /** Starts the background continuation loop for Ozon imports that are still pending. */
  public start(): void {
    if (this.pendingImportTimer) return;
    void this.pollPendingImports();
    this.pendingImportTimer = setInterval(() => void this.pollPendingImports(), PENDING_IMPORT_POLL_INTERVAL_MS);
    this.pendingImportTimer.unref();
  }

  /** Stops the pending-import loop during a graceful service shutdown. */
  public stop(): void {
    if (!this.pendingImportTimer) return;
    clearInterval(this.pendingImportTimer);
    this.pendingImportTimer = null;
  }

  /** Returns the newest MY snapshot used to seed the follow-sale form. */
  public getSource(sku: string): ResellSourceView | null {
    const product = this.myData.getProductBySku(sku);
    if (!product) {
      return null;
    }
    return {
      sku: product.sku,
      productName: product.productName,
      sourceType: "follow_sell",
      category: product.category,
      typeId: null,
      descriptionCategoryId: null,
      currentPrice: product.currentPrice,
      productUrl: product.productUrl,
      imageUrl: product.imageUrl,
      images: this.images.sourceImage(product.imageUrl),
      monthlyUnits: product.monthlyUnits,
      monthlySales: product.monthlySales,
      captureDay: product.captureDay,
    };
  }

  /** Normalizes an imported/plugin snapshot into the same source contract as MY data. */
  public getSourceFromSnapshot(snapshot: ResellSourceView, sourceType: PublishSourceType): ResellSourceView {
    const barcode = normalizeProductBarcode(snapshot.barcode);
    const { barcode: _ignoredBarcode, ...snapshotWithoutBarcode } = snapshot;
    return {
      ...snapshotWithoutBarcode,
      sourceType,
      typeId: isPositiveTypeId(snapshot.typeId) ? snapshot.typeId : null,
      descriptionCategoryId: isPositiveTypeId(snapshot.descriptionCategoryId) ? snapshot.descriptionCategoryId : null,
      images: normalizeSourceImages(snapshot.images),
      ...(barcode ? { barcode } : {}),
    };
  }

  /** Resolves a Seller snapshot using the selected target store's official type tree. */
  public async enrichSource(input: {
    storeId: string;
    sourceType: PublishSourceType;
    sourceSku: string;
    sourceSnapshot: ResellSourceView;
  }): Promise<ResellSourceView> {
    const store = await this.stores.findById(input.storeId);
    if (!store || !store.enabled) {
      throw new ResellValidationError(["目标店铺不存在或已停用"]);
    }
    const normalizedSource = this.getSourceFromSnapshot(input.sourceSnapshot, input.sourceType);
    const source = normalizedSource.sku ? normalizedSource : { ...normalizedSource, sku: input.sourceSku };
    // Source enrichment is a read-only foreground action. Keep its retry
    // budget short so a temporarily unavailable Ozon endpoint cannot leave
    // the publish page in a resolving state for several minutes.
    const client = this.clientFor(store, 1);
    if (isPositiveTypeId(source.typeId)) {
      const resolved = await this.resolveDescriptionCategoryForType(client, store.id, source.typeId);
      return resolved ? this.withResolvedTypeId(source, source.typeId, resolved) : source;
    }
    try {
      // The target-store product lookup is only a fallback. Run it alongside
      // the category-tree lookup so an unavailable product endpoint does not
      // delay the type resolution path unnecessarily.
      const [products, resolved] = await Promise.all([
        input.sourceSku ? client.getProductInfo([input.sourceSku]).catch(() => []) : Promise.resolve([]),
        this.resolveTypeDetailsFromStoreTrees(client, store.id, source),
      ]);
      const existing = products.find((product) => product.sources.some((sourceItem) => String(sourceItem.sku) === input.sourceSku)
        || product.offer_id === input.sourceSku);
      if (existing && isPositiveTypeId(existing.type_id)) {
        return this.withResolvedTypeId(source, existing.type_id, existing.description_category_id);
      }
      // Keep the complete Seller snapshot even when the target store's tree
      // cannot resolve a type yet. Preflight will surface the actionable
      // type_id error without discarding images, attributes, and title.
      return resolved ? this.withResolvedTypeId(source, resolved.typeId, resolved.descriptionCategoryId) : {
        ...source,
        missingFields: [...new Set([...(source.missingFields ?? []), "商品类型 ID"])],
      };
    } catch (error) {
      if (error instanceof ResellValidationError) throw error;
      throw new ResellValidationError([`读取目标店铺商品类型树失败：${formatError(error)}`]);
    }
  }

  /** Performs a read-only validation against the selected target store. */
  public async preflight(input: ResellTaskInput): Promise<ResellPreflightView> {
    const source = this.resolveSource(input);
    const store = await this.stores.findById(input.storeId);
    const errors = this.validateInput(input, store, source);
    let resolvedImages: Awaited<ReturnType<ResellImageService["resolve"]>> = [];
    if (source) {
      try {
        resolvedImages = await this.images.resolve(input.images, source.images);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "商品图片不正确");
      }
    }
    if (!source || !store) {
      return {
        valid: false,
        source: source ?? this.emptySource(input.sourceSku),
        store: store ? this.storeOption(store) : { id: input.storeId, name: "未知店铺", color: "#64748B", fulfillmentModes: [] },
        warehouses: [],
        existingOffer: null,
        limits: { dailyCreateRemaining: null, totalProductLimit: null },
        contractCurrency: null,
        warnings: [],
        errors,
        requiredAttributes: [],
        missingRequiredFields: [],
        packageDimensions: input.packageDimensions ?? source?.packageDimensions ?? null,
        quickCreateAllowed: false,
        mustUseEdit: input.mode === "quick",
      };
    }

    const client = this.clientFor(store);
    let resolvedSource = source;
    let warehouses: ResellWarehouseView[] = [];
    let existingOffer = null as ResellPreflightView["existingOffer"];
    let limits: ResellPreflightView["limits"] = { dailyCreateRemaining: null, totalProductLimit: null };
    let contractCurrency: string | null = null;
    let categoryAttributes: OzonCategoryAttribute[] = [];
    let packageDimensions = input.packageDimensions ?? resolvedSource?.packageDimensions ?? null;
    try {
      const [roles, warehouseResult, limitResult, products, sellerInfo] = await Promise.all([
        client.getRoles(),
        client.getWarehouses(),
        client.getProductInfoLimit().catch(() => ({ dailyCreateRemaining: null, totalProductLimit: null })),
        input.sourceSku ? client.getProductInfo([input.sourceSku]).catch(() => []) : Promise.resolve([]),
        client.getSellerInfo().catch(() => ({ currency: null, country: null })),
      ]);
      if (roles.roles.length === 0) {
        errors.push("目标店铺没有可用的 Seller API 角色权限");
      }
      warehouses = warehouseResult;
      limits = limitResult;
      contractCurrency = sellerInfo.currency;
      if (contractCurrency && input.currency !== contractCurrency) {
        errors.push(`目标店铺合同币种为 ${contractCurrency}，当前填写 ${input.currency}，系统将自动按合同币种提交`);
      }
      const existing = products.find((product) => product.offer_id === input.offerId
        || product.sources.some((sourceItem) => String(sourceItem.sku) === input.sourceSku));
      if (existing) {
        existingOffer = {
          offerId: existing.offer_id || input.offerId,
          productId: existing.id ?? existing.product_id ?? null,
          stock: null,
        };
      }
      const productType = products.find((product) => (product.offer_id === input.offerId
        || product.sources.some((sourceItem) => String(sourceItem.sku) === input.sourceSku))
        && isPositiveTypeId(product.type_id));
      if (resolvedSource && !isPositiveTypeId(resolvedSource.typeId) && productType) {
        resolvedSource = this.withResolvedTypeId(resolvedSource, productType.type_id ?? null, productType.description_category_id ?? null);
      }
      if (resolvedSource) {
        try {
          const resolved = await this.resolveTypeDetailsFromStoreTrees(client, store.id, resolvedSource);
          if (resolved) {
            resolvedSource = this.withResolvedTypeId(resolvedSource, resolved.typeId, resolved.descriptionCategoryId);
          } else {
            if (!isPositiveTypeId(resolvedSource.typeId)) {
              errors.push("未能根据当前类目解析商品类型 ID，请确认目标店铺国家/类目，或手动填写有效的 type_id");
            } else if (!isPositiveTypeId(resolvedSource.descriptionCategoryId)) {
              errors.push("未能根据商品类型 ID解析有效的类目描述 ID，请重新读取 Seller 补全");
            }
          }
        } catch (error) {
          errors.push(`读取目标店铺商品类型树失败：${formatError(error)}`);
        }
      }
      if (resolvedSource && isPositiveTypeId(resolvedSource.typeId) && isPositiveTypeId(resolvedSource.descriptionCategoryId)) {
        try {
          categoryAttributes = await client.getDescriptionCategoryAttributes({
            descriptionCategoryId: resolvedSource.descriptionCategoryId,
            typeId: resolvedSource.typeId,
          });
        } catch (error) {
          errors.push(`读取目标店铺类目属性失败：${formatError(error)}`);
        }
      }
      if (input.warehouseId && !warehouses.some((warehouse) => warehouse.id === input.warehouseId)) {
        errors.push("选择的仓库不属于目标店铺");
      }
    } catch (error) {
      errors.push(formatError(error));
    }

    if (resolvedSource && !isPositiveTypeId(resolvedSource.typeId)) {
      if (!errors.some((error) => error.includes("商品类型 ID") || error.includes("type_id"))) {
        errors.push("缺少商品类型 ID，请点击“读取 Seller 补全”，或在高级商品信息中填写有效的 type_id");
      }
    }

    const rawAttributes = input.attributes ?? resolvedSource?.attributes ?? source?.attributes;
    const dictionaryValues = new Map<number, Array<{ id: string; name: string }>>();
    if (resolvedSource && isPositiveTypeId(resolvedSource.typeId) && isPositiveTypeId(resolvedSource.descriptionCategoryId)) {
      await Promise.all(categoryAttributes
        .filter((definition) => definition.required && definition.dictionaryId)
        .map(async (definition) => {
          try {
            const values = await client.getDescriptionCategoryAttributeValues({
              descriptionCategoryId: resolvedSource.descriptionCategoryId!,
              typeId: resolvedSource.typeId!,
              attributeId: definition.id,
            });
            const currentValue = attributeValue(rawAttributes, definition.id);
            const currentValues = Array.isArray(currentValue) ? currentValue : [currentValue];
            const currentIds = currentValues
              .map((value) => value && typeof value === "object"
                ? (value as Record<string, unknown>).dictionary_value_id ?? (value as Record<string, unknown>).dictionaryValueId
                : value)
              .map((value) => String(value ?? "").trim())
              .filter(Boolean);
            // Brand dictionaries can contain thousands of entries, so the
            // official no-brand value is not guaranteed to be in the first
            // page. Fetch that value explicitly instead of guessing an ID.
            const noBrandValues = isBrandAttributeDefinition(definition)
              ? await client.searchDescriptionCategoryAttributeValues({
                descriptionCategoryId: resolvedSource.descriptionCategoryId!,
                typeId: resolvedSource.typeId!,
                attributeId: definition.id,
                query: "Нет бренда",
              }).catch(() => [])
              : [];
            const selectedOptions = [...values.slice(0, 100), ...noBrandValues]
              .filter((option, index, options) => options.findIndex((candidate) => candidate.id === option.id) === index);
            for (const id of currentIds) {
              if (!/^\d+$/.test(id) || selectedOptions.some((option) => option.id === id)) continue;
              const label = definition.id === 85 && resolvedSource?.brand ? resolvedSource.brand : `已选值 ${id}`;
              selectedOptions.push({ id, name: label });
            }
            dictionaryValues.set(definition.id, selectedOptions);
          } catch {
            // A large dictionary may be unavailable; the attribute remains editable as text.
          }
        }));
    }
    const attributes = normalizeDictionaryAttributes(rawAttributes, categoryAttributes, dictionaryValues);
    if (resolvedSource && attributes) {
      resolvedSource = { ...resolvedSource, attributes };
    }
    // Barcode attribute 7822 is submitted as the top-level barcode field. Keep
    // its required-state in sync with the validated real barcode so a stale
    // attribute entry cannot either bypass validation or create a duplicate.
    const barcodeAttributeValue = attributeValue(rawAttributes, BARCODE_ATTRIBUTE_ID);
    const barcodeFromAttribute = typeof barcodeAttributeValue === "object" && barcodeAttributeValue !== null
      ? (() => {
        const record = barcodeAttributeValue as Record<string, unknown>;
        return normalizeProductBarcode(String(record.value ?? record.barcode ?? ""));
      })()
      : normalizeProductBarcode(typeof barcodeAttributeValue === "string" || typeof barcodeAttributeValue === "number"
        ? String(barcodeAttributeValue)
        : undefined);
    const validatedBarcode = normalizeProductBarcode(input.barcode)
      ?? normalizeProductBarcode(resolvedSource?.barcode)
      ?? barcodeFromAttribute;
    const requiredAttributes = requiredAttributeViews(categoryAttributes, attributes, dictionaryValues);
    const missingRequiredFields = requiredAttributes
      .filter((attribute) => {
        if (attribute.id === BARCODE_ATTRIBUTE_ID) {
          attribute.value = validatedBarcode;
          return !validatedBarcode;
        }
        return !hasPublishAttributeValue(attribute.value);
      })
      .map((attribute) => `${attribute.name}（属性 ID ${attribute.id}）`);
    const missingDimensions = missingPackageDimensions(packageDimensions ?? undefined);
    const quickCreateAllowed = input.mode === "quick" && missingRequiredFields.length === 0 && missingDimensions.length === 0;
    const mustUseEdit = input.mode === "quick" && !quickCreateAllowed;
    if (input.mode === "edit" && missingRequiredFields.length > 0) {
      errors.push(`缺少必填商品属性：${missingRequiredFields.join("、")}`);
    }
    if (input.mode === "edit" && missingDimensions.length > 0) {
      errors.push(`缺少包装信息：${missingDimensions.join("、")}`);
    }
    if (mustUseEdit) {
      errors.push(`快速创建无法安全复制，缺少${[...missingRequiredFields, ...missingDimensions].join("、") || "目标类目字段"}；请改用编辑后发布`);
    }
    const vat = Number(input.vat.replace(",", "."));
    const warnings = [
      ...(resolvedImages.length > 0 ? [] : ["请至少添加一张商品图片，第一张将作为主图"]),
      ...(existingOffer ? ["目标店铺已经存在该商品或 Offer ID，请确认是否继续"] : []),
      ...(input.mode === "edit" ? ["编辑模式的类目必填属性以 Ozon 当前返回结果为准"] : []),
      ...(Number.isFinite(vat) && vat !== 0 ? ["VAT 非 0；请确认与目标店铺国家税率规则一致"] : []),
    ];
    return {
      valid: errors.length === 0,
      source: resolvedSource,
      store: this.storeOption(store),
      warehouses,
      existingOffer,
      limits,
      contractCurrency,
      warnings,
      errors,
      requiredAttributes,
      missingRequiredFields,
      packageDimensions,
      quickCreateAllowed,
      mustUseEdit,
    };
  }

  /** Creates an auditable task and starts the Ozon work in the background. */
  public async createTask(input: ResellTaskInput): Promise<ResellTaskView> {
    let effectiveInput = input;
    let result = await this.preflight(effectiveInput);
    // Persist the dictionary IDs resolved during preflight so the background
    // import sends the same values that the editor displayed.
    if (result.source.attributes) {
      effectiveInput = { ...effectiveInput, attributes: result.source.attributes };
    }
    if (result.contractCurrency && result.contractCurrency !== effectiveInput.currency) {
      effectiveInput = { ...effectiveInput, currency: result.contractCurrency };
      result = await this.preflight(effectiveInput);
    }
    const errors = [...result.errors];
    if (errors.length > 0) {
      throw new ResellValidationError(errors);
    }
    const store = await this.stores.findById(effectiveInput.storeId);
    if (!store) {
      throw new ResellValidationError(["目标店铺不存在"]);
    }
    if (effectiveInput.idempotencyKey) {
      const idempotent = this.database.prepare("SELECT * FROM resell_tasks WHERE idempotency_key = ?").get(effectiveInput.idempotencyKey) as ResellTaskRow | undefined;
      if (idempotent) {
        const idempotentStore = await this.stores.findById(idempotent.store_id);
        if (idempotentStore) return taskView(idempotent, idempotentStore);
      }
    }
    const existingTask = this.database.prepare("SELECT id FROM resell_tasks WHERE store_id = ? AND source_sku = ? AND target_offer_id = ? ORDER BY created_at_ms DESC LIMIT 1")
      .get(effectiveInput.storeId, effectiveInput.sourceSku, effectiveInput.offerId) as { id: string } | undefined;
    if (existingTask) {
      throw new ResellValidationError(["该店铺、SKU 和 Offer ID 已有跟卖任务，请打开原任务重试"], existingTask.id);
    }

    const id = randomUUID();
    const now = Date.now();
    const images = await this.images.resolve(effectiveInput.images, result.source.images);
    const taskSource: ResellSourceView = {
      ...result.source,
      ...(effectiveInput.packageDimensions ? { packageDimensions: effectiveInput.packageDimensions } : {}),
      ...(normalizeProductBarcode(effectiveInput.barcode) ? { barcode: normalizeProductBarcode(effectiveInput.barcode)! } : {}),
      ...(effectiveInput.attributes ? { attributes: effectiveInput.attributes } : {}),
    };
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO resell_tasks
        (id, store_id, source_sku, target_offer_id, mode, price, old_price, currency, vat, stock,
         fulfillment_mode, warehouse_id, title, description, attributes_json, status,
         source_type, source_snapshot_json, idempotency_key, created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?)`)
        .run(id, effectiveInput.storeId, effectiveInput.sourceSku, effectiveInput.offerId, effectiveInput.mode, effectiveInput.price, effectiveInput.oldPrice ?? null,
          effectiveInput.currency, effectiveInput.vat, effectiveInput.stock, effectiveInput.fulfillmentMode, effectiveInput.warehouseId,
          effectiveInput.title ?? result.source.productName, effectiveInput.description ?? result.source.description ?? null,
          effectiveInput.attributes || result.source.attributes ? JSON.stringify(effectiveInput.attributes ?? result.source.attributes) : null, effectiveInput.sourceType ?? "follow_sell",
          JSON.stringify(taskSource), effectiveInput.idempotencyKey ?? null, now, now);
      this.recordEvent(id, "creating", "跟卖任务已提交");
    })();
    this.images.saveTaskImages(id, images);
    void this.runTask(id).catch((error: unknown) => {
      this.updateTask(id, "failed", formatError(error));
    });
    return taskView(this.readTask(id), store);
  }

  /** Reads a task that belongs to the authenticated local administrator. */
  public async getTask(id: string): Promise<ResellTaskView | null> {
    const row = this.readTaskOrNull(id);
    if (!row) {
      return null;
    }
    const store = await this.stores.findById(row.store_id);
    return store ? taskView(row, store) : null;
  }

  /** Returns paginated local follow-sale history without exposing store credentials. */
  public async listTasks(query: ResellTaskListQuery): Promise<ResellTaskListPage> {
    const values: unknown[] = [];
    const conditions: string[] = [];
    if (query.storeId) {
      conditions.push("store_id = ?");
      values.push(query.storeId);
    }
    if (query.status) {
      conditions.push("status = ?");
      values.push(query.status);
    }
    if (query.sourceSku) {
      conditions.push("source_sku LIKE ?");
      values.push(`%${query.sourceSku}%`);
    }
    if (query.sourceType) {
      conditions.push("source_type = ?");
      values.push(query.sourceType);
    }
    if (query.from) {
      conditions.push("created_at_ms >= ?");
      values.push(dayStartMs(query.from));
    }
    if (query.to) {
      conditions.push("created_at_ms < ?");
      values.push(dayAfterEndMs(query.to));
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = (this.database.prepare(`SELECT COUNT(*) AS count FROM resell_tasks ${where}`).get(...values) as { count: number }).count;
    const offset = (query.page - 1) * query.pageSize;
    const rows = this.database.prepare(`SELECT resell_tasks.*,
      (SELECT COUNT(*) FROM resell_task_images WHERE task_id = resell_tasks.id) AS image_count
      FROM resell_tasks ${where} ORDER BY created_at_ms DESC LIMIT ? OFFSET ?`)
      .all(...values, query.pageSize, offset) as ResellTaskRow[];
    const stores = new Map((await this.stores.list()).map((store) => [store.id, store]));
    const items: ResellTaskListItem[] = rows.flatMap((row) => {
      const store = stores.get(row.store_id);
      if (!store) return [];
      const source = row.source_snapshot_json
        ? JSON.parse(row.source_snapshot_json) as ResellSourceView
        : this.getSource(row.source_sku);
      return [{ ...taskView(row, store), productTitle: row.title ?? source?.productName ?? null }];
    });
    return { items, page: query.page, pageSize: query.pageSize, total };
  }

  /** Returns a task together with its source link and status timeline. */
  public async getTaskDetail(id: string): Promise<ResellTaskDetailView | null> {
    const row = this.readTaskOrNull(id);
    if (!row) return null;
    const task = await this.getTask(id);
    if (!task) return null;
    const source = row.source_snapshot_json
      ? JSON.parse(row.source_snapshot_json) as ResellSourceView
      : this.getSource(row.source_sku);
    const events = (this.database.prepare("SELECT status, message, created_at_ms FROM resell_task_events WHERE task_id = ? ORDER BY created_at_ms ASC").all(id) as ResellTaskEventRow[])
      .map((event) => ({ status: event.status, message: event.message, createdAt: new Date(event.created_at_ms).toISOString() }));
    return { ...task, productTitle: row.title ?? source?.productName ?? null, sourceUrl: source?.productUrl || null, events };
  }

  /** Re-runs a failed or pending task with its original immutable input. */
  public async retryTask(id: string): Promise<ResellTaskView> {
    const row = this.readTaskOrNull(id);
    if (!row) {
      throw new ResellValidationError(["跟卖任务不存在"]);
    }
    if (!["failed", "needs_input", "moderating"].includes(row.status)) {
      throw new ResellValidationError(["当前任务状态不允许重试"]);
    }
    const source = row.source_snapshot_json
      ? JSON.parse(row.source_snapshot_json) as ResellSourceView
      : this.getSource(row.source_sku);
    if (!source) {
      throw new ResellValidationError(["跟卖来源商品不存在，请重新读取 Seller 补全"]);
    }
    const attributes = row.attributes_json ? JSON.parse(row.attributes_json) as Record<string, unknown> : undefined;
    const retryInput: ResellTaskInput = {
      sourceSku: row.source_sku,
      sourceType: row.source_type,
      sourceSnapshot: source,
      storeId: row.store_id,
      mode: row.mode,
      offerId: row.target_offer_id,
      price: row.price,
      ...(row.old_price ? { oldPrice: row.old_price } : {}),
      currency: row.currency,
      vat: row.vat,
      stock: row.stock,
      fulfillmentMode: row.fulfillment_mode,
      warehouseId: row.warehouse_id,
      ...(row.title ? { title: row.title } : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(attributes ? { attributes } : {}),
      ...(source.packageDimensions ? { packageDimensions: source.packageDimensions } : {}),
      ...(normalizeProductBarcode(source.barcode) ? { barcode: normalizeProductBarcode(source.barcode)! } : {}),
      images: this.images.listTaskImageUrls(id).map((url, position) => ({ sourceUrl: url, position })),
    };
    let retryPreflight = await this.preflight(retryInput);
    if (retryPreflight.contractCurrency && retryPreflight.contractCurrency !== retryInput.currency) {
      retryPreflight = await this.preflight({ ...retryInput, currency: retryPreflight.contractCurrency });
    }
    const retryErrors = [...retryPreflight.errors];
    if (retryErrors.length > 0) {
      throw new ResellValidationError(retryErrors);
    }
    if (retryPreflight.source.typeId && retryPreflight.source.typeId !== source.typeId) {
      this.updateTaskSourceSnapshot(id, retryPreflight.source);
    }
    this.updateTask(id, "creating", null);
    void this.runTask(id).catch((error: unknown) => {
      this.updateTask(id, "failed", formatError(error));
    });
    const task = await this.getTask(id);
    if (!task) {
      throw new ResellValidationError(["跟卖任务不存在"]);
    }
    return task;
  }

  /** Deletes only terminal failed tasks; active or successfully submitted tasks remain auditable. */
  public deleteFailedTask(id: string): boolean {
    const row = this.readTaskOrNull(id);
    if (!row) return false;
    if (!["failed", "preflight_failed", "needs_input"].includes(row.status)) {
      throw new ResellValidationError(["只有失败或需要补充的任务可以删除"]);
    }
    return this.database.prepare("DELETE FROM resell_tasks WHERE id = ?").run(id).changes > 0;
  }

  private async runTask(id: string): Promise<void> {
    if (this.activeTaskIds.has(id)) return;
    this.activeTaskIds.add(id);
    try {
      await this.runTaskInternal(id);
    } finally {
      this.activeTaskIds.delete(id);
    }
  }

  /** Continues tasks whose Ozon import request was accepted but not processed yet. */
  private async pollPendingImports(): Promise<void> {
    if (this.pendingImportPollRunning) return;
    this.pendingImportPollRunning = true;
    try {
      const rows = this.database.prepare(`SELECT id FROM resell_tasks
        WHERE status = 'pending' AND ozon_task_id IS NOT NULL AND product_id IS NULL`).all() as Array<{ id: string }>;
      await Promise.all(rows.map((row) => this.runTask(row.id).catch((error: unknown) => {
        const message = formatError(error);
        // A transient network/proxy/category lookup failure must not discard a
        // valid Ozon task. Keep it pending so the next scheduled pass retries
        // the existing Ozon task instead of creating a duplicate product.
        if (message.includes("Ozon 返回商品状态：")) {
          this.updateTask(row.id, "failed", message);
        } else {
          this.updateTask(row.id, "pending", `后台查询 Ozon 导入失败，稍后自动重试：${message}`);
        }
      })));
    } finally {
      this.pendingImportPollRunning = false;
    }
  }

  private async runTaskInternal(id: string): Promise<void> {
    const row = this.readTask(id);
    const store = await this.stores.findById(row.store_id);
    let source = row.source_snapshot_json
      ? JSON.parse(row.source_snapshot_json) as ResellSourceView
      : this.getSource(row.source_sku);
    if (!store || !source) {
      throw new Error("跟卖来源商品或目标店铺不存在");
    }
    const client = this.clientFor(store);
    const contractCurrency = (await client.getSellerInfo().catch(() => ({ currency: null, country: null }))).currency;
    const taskCurrency = contractCurrency ?? row.currency;
    if (taskCurrency !== row.currency) {
      this.setTaskCurrency(id, taskCurrency);
    }
    let resolvedTypeId = source.typeId;
    let resolvedFromTree = false;
    if (!isPositiveTypeId(source.typeId)) {
      const resolved = await this.resolveTypeDetailsFromStoreTrees(client, row.store_id, source);
      if (!resolved) {
        throw new Error("缺少商品类型 ID，请重新读取 Seller 补全后再重试");
      }
      resolvedTypeId = resolved.typeId;
      source = this.withResolvedTypeId(source, resolved.typeId, resolved.descriptionCategoryId);
      resolvedFromTree = true;
    } else if (!isPositiveTypeId(source.descriptionCategoryId) || source.fieldSources?.descriptionCategoryId === "seller_bridge") {
      const resolved = await this.resolveTypeDetailsFromStoreTrees(client, row.store_id, source);
      if (resolved && resolved.typeId === resolvedTypeId) {
        source = this.withResolvedTypeId(source, resolved.typeId, resolved.descriptionCategoryId);
        resolvedFromTree = true;
      }
    }
    if (!isPositiveTypeId(resolvedTypeId)) {
      throw new Error("缺少商品类型 ID，请重新读取 Seller 补全后再重试");
    }
    if (resolvedFromTree) {
      this.updateTaskSourceSnapshot(id, source);
    }
    const attributes = row.attributes_json ? JSON.parse(row.attributes_json) as Record<string, unknown> : undefined;
    const imageUrls = this.images.listTaskImageUrls(id);
    const descriptionCategoryId = verifiedDescriptionCategoryId(source);
    const attributeDefinitions = descriptionCategoryId
      ? await client.getDescriptionCategoryAttributes({ descriptionCategoryId, typeId: resolvedTypeId }).catch(() => [])
      : [];
    const ozonAttributes = normalizeOzonAttributes(attributes, attributeDefinitions);
    const packageDimensions = source.packageDimensions;
    const dimensionsPayload = packageDimensions ? {
      depth: Number(packageDimensions.depth.replace(",", ".")),
      width: Number(packageDimensions.width.replace(",", ".")),
      height: Number(packageDimensions.height.replace(",", ".")),
      dimension_unit: packageDimensions.dimensionUnit,
      weight: Number(packageDimensions.weight.replace(",", ".")),
      weight_unit: packageDimensions.weightUnit,
    } : {};
    // A task with an existing Product ID is retried in-place. Re-importing the
    // SKU would create a second draft, so only image/price/stock steps run.
    const importedItem = row.product_id
      ? { offerId: row.target_offer_id, productId: row.product_id, status: "processed", errors: [], warnings: [] }
      : row.ozon_task_id
        ? await (async () => {
          const imported = await this.waitForImport(client, row.ozon_task_id!, row.target_offer_id);
          return imported.find((item) => item.offerId === row.target_offer_id) ?? imported[0];
        })()
      : await (async () => {
        const result = row.mode === "quick" && row.source_type === "follow_sell"
          ? await client.importProductBySku({ sku: row.source_sku, name: row.title ?? source.productName, typeId: resolvedTypeId, descriptionCategoryId, offerId: row.target_offer_id, price: row.price, ...(row.old_price ? { oldPrice: row.old_price } : {}), currency: taskCurrency, vat: row.vat })
          : await client.importProduct({
            type_id: resolvedTypeId,
            ...(descriptionCategoryId ? { description_category_id: descriptionCategoryId } : {}),
            offer_id: row.target_offer_id,
            name: row.title ?? source.productName,
            ...(row.description ? { description: row.description } : {}),
            price: row.price,
            ...(row.old_price ? { old_price: row.old_price } : {}),
            currency_code: taskCurrency,
            vat: row.vat,
            ...(normalizeProductBarcode(source.barcode) ? { barcode: normalizeProductBarcode(source.barcode)! } : {}),
            ...(row.mode === "edit" ? dimensionsPayload : {}),
            ...(ozonAttributes.length > 0 ? { attributes: ozonAttributes } : {}),
          });
        if (result.unmatchedSkuList.length > 0) {
          throw new Error(`Ozon 无法匹配 SKU：${result.unmatchedSkuList.join(", ")}`);
        }
        this.setTaskOzonId(id, result.taskId);
        this.updateTask(id, "pending", null);
        const imported = await this.waitForImport(client, result.taskId, row.target_offer_id);
        return imported.find((item) => item.offerId === row.target_offer_id) ?? imported[0];
      })();
    if (!importedItem) {
      this.updateTask(id, "pending", "Ozon 仍在处理商品导入，系统每 30 秒自动查询，完成后继续上传图片");
      return;
    }
    const blockingErrors = importedItem.errors.filter((error) => !error.toLowerCase().includes("warning"));
    if (isFailedImportStatus(importedItem.status) || blockingErrors.length > 0) {
      throw new Error(blockingErrors.join("；") || importedItem.errors.join("；") || `Ozon 返回商品状态：${importedItem.status}`);
    }
    if (!isProcessedImportStatus(importedItem.status)) {
      this.updateTask(id, "pending", `Ozon 返回商品状态：${importedItem.status}；系统每 30 秒自动查询，完成后继续上传图片`);
      return;
    }
    if (!importedItem.productId) {
      throw new Error("Ozon 已完成导入，但没有返回 product_id");
    }
    this.setTaskProductId(id, importedItem.productId);
    this.updateTask(id, "created", null);
    if (imageUrls.length > 0) {
      this.updateTask(id, "setting_images", null);
      await client.importProductPictures({ productId: importedItem.productId, images: imageUrls });
      await client.verifyProductPictures(importedItem.productId);
    }
    this.updateTask(id, "setting_price", null);
    await client.updateProductPrice({ offerId: row.target_offer_id, price: row.price, ...(row.old_price ? { oldPrice: row.old_price } : {}), currency: taskCurrency, vat: row.vat });
    if (row.fulfillment_mode === "FBO") {
      this.updateTask(id, "moderating", "FBO 库存需入 Ozon 仓库后产生，未调用卖家库存接口");
      return;
    }
    await this.configureStock(id, row, client, importedItem.productId);
  }

  /**
   * Configures and verifies FBS/rFBS stock independently from product images
   * and pricing. A stock failure keeps the published product auditable and
   * allows the operator to retry inventory later without creating a product.
   */
  private async configureStock(id: string, row: ResellTaskRow, client: OzonClient, productId: string): Promise<void> {
    this.updateTask(id, "setting_stock", null);
    try {
      await client.updateProductStock({ offerId: row.target_offer_id, productId, warehouseId: row.warehouse_id, stock: row.stock });
      this.updateTask(id, "setting_stock", "Ozon 已接受库存请求，正在回读目标仓库实际库存");
      const actualStock = await this.waitForStockReadback(client, {
        offerId: row.target_offer_id,
        productId,
        warehouseId: row.warehouse_id,
        expectedStock: row.stock,
      });
      this.updateTaskStockVerification(id, {
        requested: row.stock,
        actual: actualStock,
        warehouseId: row.warehouse_id,
        checkedAt: new Date().toISOString(),
      });
      if (actualStock !== row.stock) {
        this.updateTask(id, "stock_pending", `Ozon 已接受库存请求，但目标仓库实际库存仍为 ${actualStock ?? 0}，可稍后重新设置库存`);
        return;
      }
    } catch (error) {
      this.updateTask(id, "stock_pending", `商品和图片已完成，库存稍后设置：${formatError(error)}`);
      return;
    }
    this.updateTask(id, "sellable", null);
  }

  /** Re-applies inventory for a created FBS/rFBS product without re-importing it. */
  public async setTaskStock(id: string): Promise<ResellTaskView> {
    const row = this.readTaskOrNull(id);
    if (!row) throw new ResellValidationError(["跟卖任务不存在"]);
    if (!row.product_id) throw new ResellValidationError(["商品尚未获得 Product ID，暂时不能单独设置库存"]);
    if (row.fulfillment_mode === "FBO") throw new ResellValidationError(["FBO 库存需入 Ozon 仓库后产生，不能通过卖家库存接口设置"]);
    if (!row.warehouse_id.trim()) throw new ResellValidationError(["请选择目标仓库后再设置库存"]);
    const store = await this.stores.findById(row.store_id);
    if (!store) throw new ResellValidationError(["目标店铺不存在"]);
    await this.configureStock(id, row, this.clientFor(store), row.product_id);
    return taskView(this.readTask(id), store);
  }

  /** Reads the requested target offer once; the 30-second scheduler retries pending imports. */
  private async waitForImport(client: OzonClient, taskId: string, targetOfferId: string): Promise<OzonProductImportItemResult[]> {
    return client.getProductImportInfo(taskId);
  }

  /** Polls Ozon until the selected FBS/rFBS warehouse reflects the requested stock. */
  private async waitForStockReadback(client: OzonClient, input: {
    offerId: string;
    productId: string;
    warehouseId: string;
    expectedStock: number;
  }): Promise<number | null> {
    let actual: number | null = null;
    for (let attempt = 0; attempt < MAX_STOCK_POLLS; attempt += 1) {
      const result = await client.getFbsStockByWarehouse(input);
      actual = result?.stock ?? null;
      if (actual === input.expectedStock) return actual;
      if (attempt + 1 < MAX_STOCK_POLLS) await wait(STOCK_POLL_INTERVAL_MS);
    }
    return actual;
  }

  private validateInput(input: ResellTaskInput, store: StoreRecord | null, source: ResellSourceView | null): string[] {
    const errors: string[] = [];
    if (!source && input.sourceType !== "normal_publish") errors.push("商品来源中不存在该 SKU");
    if (input.sourceType === "normal_publish" && !input.title?.trim() && !source?.productName?.trim()) errors.push("普通商品发布需要商品标题");
    if (input.sourceType === "normal_publish" && input.mode === "quick") errors.push("普通商品发布请选择编辑模式");
    if (!store) errors.push("目标店铺不存在");
    if (store && !store.enabled) errors.push("目标店铺已停用");
    if (store && !store.fulfillmentModes.includes(input.fulfillmentMode)) errors.push("目标店铺未启用该履约模式");
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(input.offerId)) errors.push("Offer ID 只能包含字母、数字、点、下划线和短横线");
    if (!isPositiveMoney(input.price)) errors.push("销售价必须是大于 0 的数字");
    if (input.oldPrice && !isPositiveMoney(input.oldPrice)) errors.push("划线价必须是大于 0 的数字");
    if (!/^[A-Z]{3}$/.test(input.currency)) errors.push("币种必须是 3 位大写代码");
    if (input.barcode?.trim() && !normalizeProductBarcode(input.barcode)) {
      errors.push("当前条码不是有效商品条码，不能使用 OZN + SKU 代替；请填写真实 EAN/GTIN/UPC，或按目标类目规则留空");
    }
    const vat = Number(input.vat.replace(",", "."));
    if (!input.vat.trim()) errors.push("VAT 不能为空");
    else if (!Number.isFinite(vat) || vat < 0 || vat > 1) errors.push("VAT 必须是 0 到 1 之间的数字，例如 0 或 0.2");
    if (!Number.isInteger(input.stock) || input.stock < 0) errors.push("库存必须是非负整数");
    return errors;
  }

  private clientFor(store: StoreRecord, maxAttempts?: number): OzonClient {
    return new OzonClient({
      clientId: store.clientId,
      apiKey: decryptSecret(store.apiKeyCiphertext, this.config.ENCRYPTION_KEY),
      baseUrl: this.config.OZON_API_BASE_URL,
      fetchImplementation: this.fetchImplementation,
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    });
  }

  private withResolvedTypeId(source: ResellSourceView, typeId: number | null, descriptionCategoryId?: number | null): ResellSourceView {
    if (!isPositiveTypeId(typeId)) {
      return source;
    }
    const resolvedDescriptionCategoryId = isPositiveTypeId(descriptionCategoryId)
      ? descriptionCategoryId
      : source.fieldSources?.descriptionCategoryId === "seller_bridge"
        ? null
        : (isPositiveTypeId(source.descriptionCategoryId) ? source.descriptionCategoryId : null);
    return {
      ...source,
      typeId,
      // A previous enrichment attempt may have recorded this field as missing.
      // Remove the stale marker once a valid type_id has been resolved.
      missingFields: (source.missingFields ?? []).filter((field) => field !== "商品类型 ID"),
      // A Seller bridge may carry a category ID from another country. Keep
      // only the ID explicitly verified for this target store's tree.
      descriptionCategoryId: resolvedDescriptionCategoryId,
      fieldSources: {
        ...(source.fieldSources ?? {}),
        typeId: "ozon_category_tree",
        ...(resolvedDescriptionCategoryId ? { descriptionCategoryId: "ozon_category_tree" } : {}),
      },
    };
  }

  private async resolveTypeDetailsFromStoreTrees(client: OzonClient, storeId: string, source: ResellSourceView): Promise<ResolvedCategoryType | null> {
    for (const language of categoryTreeLanguagesForSource(source)) {
      const nodes = await this.getDescriptionCategoryTree(client, storeId, language);
      if (isPositiveTypeId(source.typeId)) {
        const typeLeaf = findTypeLeaf(nodes, source.typeId);
        if (typeLeaf) {
          return { typeId: source.typeId, descriptionCategoryId: typeLeaf.descriptionCategoryId };
        }
      }
      const resolved = resolveTypeDetailsFromCategoryTree(source, nodes);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  private async resolveDescriptionCategoryForType(client: OzonClient, storeId: string, typeId: number): Promise<number | null> {
    for (const language of [DEFAULT_CATEGORY_TREE_LANGUAGE]) {
      const nodes = await this.getDescriptionCategoryTree(client, storeId, language);
      const typeLeaf = findTypeLeaf(nodes, typeId);
      if (typeLeaf) return typeLeaf.descriptionCategoryId;
    }
    return null;
  }

  private async getDescriptionCategoryTree(client: OzonClient, storeId: string, language: string): Promise<OzonDescriptionCategoryNode[]> {
    const cacheKey = `${storeId}:${language}`;
    const cached = this.categoryTreeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.nodes;
    }
    const nodes = await client.getDescriptionCategoryTree(language);
    this.categoryTreeCache.set(cacheKey, {
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      nodes,
    });
    return nodes;
  }

  private storeOption(store: StoreRecord): ResellPreflightView["store"] {
    return { id: store.id, name: store.name, color: store.color, fulfillmentModes: store.fulfillmentModes };
  }

  private emptySource(sku: string, sourceType: PublishSourceType = "normal_publish"): ResellSourceView {
    return { sku, productName: "", sourceType, typeId: null, descriptionCategoryId: null, currentPrice: { amount: "0", currency: "RUB" }, productUrl: "", imageUrl: null, images: [], monthlyUnits: 0, monthlySales: { amount: "0", currency: "RUB" }, captureDay: "" };
  }

  private resolveSource(input: ResellTaskInput): ResellSourceView | null {
    if (input.sourceSnapshot) {
      return this.getSourceFromSnapshot(input.sourceSnapshot, input.sourceType ?? input.sourceSnapshot.sourceType ?? "follow_sell");
    }
    if (input.sourceType && input.sourceType !== "follow_sell") return this.emptySource(input.sourceSku, input.sourceType);
    return this.getSource(input.sourceSku);
  }

  private readTask(id: string): ResellTaskRow {
    const row = this.readTaskOrNull(id);
    if (!row) throw new Error("跟卖任务不存在");
    return row;
  }

  private readTaskOrNull(id: string): ResellTaskRow | null {
    return (this.database.prepare(`SELECT resell_tasks.*,
      (SELECT COUNT(*) FROM resell_task_images WHERE task_id = resell_tasks.id) AS image_count
      FROM resell_tasks WHERE resell_tasks.id = ?`).get(id) as ResellTaskRow | undefined) ?? null;
  }

  private setTaskOzonId(id: string, taskId: string): void {
    this.database.prepare("UPDATE resell_tasks SET ozon_task_id = ?, updated_at_ms = ? WHERE id = ?").run(taskId, Date.now(), id);
  }

  private setTaskProductId(id: string, productId: string): void {
    this.database.prepare("UPDATE resell_tasks SET product_id = ?, updated_at_ms = ? WHERE id = ?").run(productId, Date.now(), id);
  }

  private setTaskCurrency(id: string, currency: string): void {
    this.database.prepare("UPDATE resell_tasks SET currency = ?, updated_at_ms = ? WHERE id = ?").run(currency, Date.now(), id);
  }

  private updateTask(id: string, status: ResellStatus, error: string | null): void {
    const current = this.database.prepare("SELECT status, last_error FROM resell_tasks WHERE id = ?")
      .get(id) as { status: ResellStatus; last_error: string | null } | undefined;
    if (current?.status === status && current.last_error === error) return;
    const now = Date.now();
    this.database.transaction(() => {
      this.database.prepare("UPDATE resell_tasks SET status = ?, last_error = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?")
        .run(status, error, now, ["sellable", "failed"].includes(status) ? now : null, id);
      this.recordEvent(id, status, error);
    })();
  }

  private updateTaskSourceSnapshot(id: string, source: ResellSourceView): void {
    this.database.prepare("UPDATE resell_tasks SET source_snapshot_json = ?, updated_at_ms = ? WHERE id = ?")
      .run(JSON.stringify(source), Date.now(), id);
  }

  /** Persists the latest requested/actual warehouse stock comparison in the task snapshot. */
  private updateTaskStockVerification(id: string, verification: ResellStockVerification): void {
    const row = this.readTask(id);
    let source: ResellSourceView = this.emptySource(row.source_sku, row.source_type);
    if (row.source_snapshot_json) {
      try {
        source = JSON.parse(row.source_snapshot_json) as ResellSourceView;
      } catch {
        // Preserve the task even when a legacy snapshot is malformed.
      }
    }
    this.updateTaskSourceSnapshot(id, { ...source, stockVerification: verification });
  }

  private recordEvent(taskId: string, status: string, message: string | null): void {
    this.database.prepare("INSERT INTO resell_task_events (id, task_id, status, message, created_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), taskId, status, message, Date.now());
  }
}

export { DEFAULT_STOCK };
