import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { myDataFulfillmentModes, myDataSorts, publishDraftStages, publishSourceTypes, resellModes, resellStatuses, selectionCandidateStatuses, selectionKeywordSorts, selectionMarketProductSorts } from "../../shared/contracts";
import { requireSession } from "../security/session";
import type { MyDataImportFile, MyDataModule } from "../selection/my-data-module";
import type { SelectionImportFile, SelectionModule } from "../selection/selection-module";
import { ResellModule, ResellValidationError } from "../selection/resell-module";
import { ResellImageService } from "../selection/resell-image-service";
import { PublishDraftsModule } from "../selection/publish-drafts";
import type { PublishVariantDraft, ResellPreflightInput, ResellSourceView } from "../../shared/contracts";

const idParamsSchema = z.object({ id: z.string().uuid() });
const keywordQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(selectionKeywordSorts).default("demandScore"),
  search: z.string().trim().max(200).optional(),
  minimumPrice: z.coerce.number().nonnegative().optional(),
  maximumPrice: z.coerce.number().nonnegative().optional(),
});
const marketProductQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(selectionMarketProductSorts).default("orderedAmount"),
  search: z.string().trim().max(300).optional(),
  categoryLevel1: z.string().trim().max(300).optional(),
  categoryLevel3: z.string().trim().max(300).optional(),
  productFlag: z.string().trim().max(300).optional(),
  minimumPrice: z.coerce.number().nonnegative().optional(),
  maximumPrice: z.coerce.number().nonnegative().optional(),
});
const candidateQuerySchema = z.object({
  status: z.enum(selectionCandidateStatuses).optional(),
  search: z.string().trim().max(200).optional(),
});
const myDataQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  captureDay: z.string().date().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  allDates: z.string().optional().transform((value) => value === "true"),
  search: z.string().trim().max(300).optional(),
  keyword: z.string().trim().max(300).optional(),
  category: z.string().trim().max(300).optional(),
  fulfillmentMode: z.enum(myDataFulfillmentModes).optional(),
  minMonthlyUnits: z.coerce.number().int().nonnegative().optional(),
  maxMonthlyUnits: z.coerce.number().int().nonnegative().optional(),
  minAov: z.coerce.number().nonnegative().optional(),
  maxAov: z.coerce.number().nonnegative().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  maxRating: z.coerce.number().min(0).max(5).optional(),
  minReviewCount: z.coerce.number().int().nonnegative().optional(),
  maxReviewCount: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(myDataSorts).default("monthlyUnits"),
}).refine((query) => !query.from || !query.to || query.from <= query.to, { message: "日期范围不正确", path: ["to"] });
const candidateCreateSchema = z.object({
  keywordId: z.string().uuid().optional(),
  marketProductId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(300),
  ozonUrl: z.string().trim().url().max(2000).optional(),
  category: z.string().trim().max(300).optional(),
  targetPrice: z.string().trim().max(50).optional(),
  note: z.string().trim().max(5000).optional(),
});
const packageDimensionsSchema = z.object({
  depth: z.string().trim().max(30),
  width: z.string().trim().max(30),
  height: z.string().trim().max(30),
  dimensionUnit: z.string().trim().max(20),
  weight: z.string().trim().max(30),
  weightUnit: z.string().trim().max(20),
});
const resellInputSchema = z.object({
  sourceSku: z.string().trim().max(100).default(""),
  sourceType: z.enum(publishSourceTypes).default("follow_sell"),
  sourceSnapshot: z.object({
    sku: z.string().max(100).default(""),
    productName: z.string().max(500),
    description: z.string().max(20_000).optional(),
    brand: z.string().max(300).optional(),
    category: z.string().max(500).optional(),
    typeName: z.string().max(500).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    packageDimensions: packageDimensionsSchema.optional(),
    barcode: z.string().trim().max(100).optional(),
    fieldSources: z.record(z.string(), z.string()).optional(),
    missingFields: z.array(z.string()).optional(),
    sourceDiagnostics: z.object({ extractor: z.string(), collectedAt: z.string(), warnings: z.array(z.string()) }).optional(),
    descriptionImages: z.array(z.string().url()).max(100).optional(),
    sourceVideos: z.array(z.string().url()).max(20).optional(),
    sourceType: z.enum(publishSourceTypes).optional(),
    typeId: z.number().int().positive().nullable().default(null),
    descriptionCategoryId: z.number().int().positive().nullable().default(null),
    currentPrice: z.object({ amount: z.string(), currency: z.string() }),
    productUrl: z.string().max(2000).default(""),
    imageUrl: z.string().nullable().default(null),
    // Seller/browser snapshots may not know remote image dimensions or have a
    // persisted asset UUID. ResellModule normalizes those values at the trust
    // boundary before they are used for Ozon requests.
    images: z.array(z.object({ id: z.string().default(""), url: z.string().url(), fileName: z.string().default(""), mimeType: z.string().default("image/*"), byteSize: z.number().int().nonnegative().default(0), width: z.number().int().nonnegative().default(0), height: z.number().int().nonnegative().default(0), source: z.enum(["source", "uploaded"]).default("source") })).max(30).default([]),
    monthlyUnits: z.number().int().nonnegative().default(0),
    monthlySales: z.object({ amount: z.string(), currency: z.string() }),
    captureDay: z.string().default(""),
  }).optional(),
  idempotencyKey: z.string().trim().max(120).optional(),
  storeId: z.string().uuid(),
  mode: z.enum(resellModes).default("quick"),
  offerId: z.string().trim().min(1).max(80),
  price: z.string().trim().min(1).max(50),
  oldPrice: z.string().trim().max(50).optional(),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  vat: z.string().trim().min(1).max(30),
  stock: z.coerce.number().int().min(0).max(1_000_000),
  fulfillmentMode: z.enum(["FBO", "FBS", "RFBS"]),
  warehouseId: z.string().trim().max(100).default(""),
  title: z.string().trim().max(500).optional(),
  description: z.string().trim().max(20_000).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  packageDimensions: packageDimensionsSchema.optional(),
  barcode: z.string().trim().max(100).optional(),
  images: z.array(z.object({ assetId: z.string().uuid().optional(), sourceUrl: z.string().url().optional(), position: z.number().int().min(0) })).max(15).default([]),
  publishDraftId: z.string().uuid().optional(),
  publishVariantId: z.string().trim().min(1).max(120).optional(),
});
const resellTaskListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  storeId: z.string().uuid().optional(),
  status: z.enum(resellStatuses).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  sourceSku: z.string().trim().max(100).optional(),
  sourceType: z.enum(publishSourceTypes).optional(),
}).refine((query) => !query.from || !query.to || query.from <= query.to, { message: "日期范围不正确", path: ["to"] });
const candidateUpdateSchema = z.object({
  keywordId: z.string().uuid().nullable().optional(),
  marketProductId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(300).optional(),
  ozonUrl: z.string().trim().url().max(2000).nullable().optional(),
  category: z.string().trim().max(300).nullable().optional(),
  targetPrice: z.string().trim().max(50).nullable().optional(),
  status: z.enum(selectionCandidateStatuses).optional(),
  decisionReason: z.string().trim().max(5000).nullable().optional(),
  note: z.string().trim().max(5000).nullable().optional(),
});
const publishDraftSchema = z.object({
  sourceType: z.enum(publishSourceTypes),
  sourceSku: z.string().trim().max(100).default(""),
  title: z.string().trim().max(500).nullable().optional(),
  sourceSnapshot: resellInputSchema.shape.sourceSnapshot.unwrap(),
  fieldOverrides: z.record(z.string(), z.unknown()).optional(),
  workflowStage: z.enum(publishDraftStages).optional(),
  variants: z.array(z.object({
    id: z.string().trim().min(1).max(120), sourceSkuId: z.string().max(120).default(""), label: z.string().max(500).default(""),
    imageUrl: z.string().max(2000).default(""), richContent: z.string().max(20_000).default(""), videoUrl: z.string().max(2000).default(""),
    offerId: z.string().max(80).default(""), purchasePrice: z.string().max(50).default(""), price: z.string().max(50).default(""), oldPrice: z.string().max(50).default(""),
    currency: z.string().length(3).default("RUB"), stock: z.number().int().min(0).max(1_000_000).nullable().default(null), packageDimensions: packageDimensionsSchema,
    attributes: z.record(z.string(), z.unknown()).default({}),
  })).max(100).optional(),
});
const publishDraftPatchSchema = publishDraftSchema.partial();
const publishDraftListSchema = z.object({ stage: z.enum(publishDraftStages).optional() });
const publishSourceEnrichSchema = z.object({
  storeId: z.string().uuid(),
  sourceType: z.enum(publishSourceTypes),
  sourceSku: z.string().trim().max(100).default(""),
  sourceSnapshot: resellInputSchema.shape.sourceSnapshot.unwrap(),
});


function parseResellInput(value: unknown): ResellPreflightInput {
  return resellInputSchema.parse(value) as ResellPreflightInput;
}
const wordstatSettingsSchema = z.object({
  folderId: z.string().trim().min(1).max(300),
  apiKey: z.string().trim().min(1).max(2000).optional(),
});
const wordstatJobSchema = z.object({
  keywordIds: z.array(z.string().uuid()).min(1).max(100),
  force: z.boolean().default(false),
});
const importMappingSchema = z.object({
  phrase: z.string().min(1),
  searchCount: z.string().min(1),
  cartRate: z.string().min(1),
  cartRateUnit: z.enum(["percent", "fraction"]),
  orderRate: z.string().min(1),
  orderRateUnit: z.enum(["percent", "fraction"]),
  averagePrice: z.string().min(1).optional(),
});

interface MultipartImport extends SelectionImportFile {
  fields: Record<string, string>;
}

interface MultipartMyImport {
  files: MyDataImportFile[];
  fields: Record<string, string>;
}

interface PublishPackageFile {
  fileName: string;
  content: Buffer;
}

interface PublishPackagePreview {
  productCount: number;
  imageCount: number;
  products: Array<{ sku: string; title: string; imageCount: number; missingFields: string[] }>;
  errors: string[];
}

function isSafePackagePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return Boolean(normalized) && !normalized.startsWith("/") && !normalized.split("/").includes("..") && normalized.length <= 300;
}

/** Validates a standard manifest and its relative image paths without writing files. */
function previewPublishPackage(files: PublishPackageFile[]): PublishPackagePreview {
  const manifestFile = files.find((file) => file.fileName.split("/").at(-1)?.toLowerCase() === "manifest.json");
  if (!manifestFile) return { productCount: 0, imageCount: 0, products: [], errors: ["文件夹中缺少 manifest.json"] };
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestFile.content.toString("utf8"));
  } catch {
    return { productCount: 0, imageCount: 0, products: [], errors: ["manifest.json 不是有效 JSON"] };
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return { productCount: 0, imageCount: 0, products: [], errors: ["manifest.json 顶层必须是对象"] };
  const input = manifest as { schemaVersion?: unknown; products?: unknown };
  const errors: string[] = [];
  if (input.schemaVersion !== 1) errors.push("仅支持 schemaVersion=1 的商品清单");
  if (!Array.isArray(input.products) || input.products.length === 0) errors.push("manifest.json 中没有 products");
  if (errors.length > 0) return { productCount: 0, imageCount: 0, products: [], errors };
  const names = new Set(files.map((file) => file.fileName.replaceAll("\\", "/")));
  const products: PublishPackagePreview["products"] = [];
  let imageCount = 0;
  for (const item of input.products as Array<Record<string, unknown>>) {
    const sku = typeof item.sku === "string" ? item.sku.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const images = Array.isArray(item.images) ? item.images : [];
    const missingFields = [!title ? "标题" : "", images.length === 0 ? "图片" : ""].filter(Boolean);
    if (!sku) missingFields.push("SKU");
    for (const image of images as Array<Record<string, unknown>>) {
      const path = typeof image.path === "string" ? image.path.replaceAll("\\", "/") : "";
      imageCount += 1;
      if (!isSafePackagePath(path) || !names.has(path) && !names.has(`${manifestFile.fileName.split("/").slice(0, -1).join("/")}/${path}`.replace(/^\//, ""))) {
        missingFields.push(`图片路径无效：${path || "空路径"}`);
      }
    }
    products.push({ sku, title, imageCount: images.length, missingFields });
  }
  return { productCount: products.length, imageCount, products, errors };
}

function isSqliteConstraint(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    && error.code.startsWith("SQLITE_CONSTRAINT");
}

function isFileTooLarge(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "FST_REQ_FILE_TOO_LARGE";
}

async function readMultipartImport(request: FastifyRequest): Promise<MultipartImport> {
  let file: SelectionImportFile | null = null;
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (file) {
        throw new Error("每次只能上传一个文件");
      }
      file = { fileName: part.filename, content: await part.toBuffer() };
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  if (!file) {
    throw new Error("请选择要上传的报表文件");
  }
  return { ...file, fields };
}

async function readMultipartMyImport(request: FastifyRequest): Promise<MultipartMyImport> {
  const files: MyDataImportFile[] = [];
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === "file") {
      files.push({ fileName: part.filename, content: await part.toBuffer() });
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { files, fields };
}

/** Registers loopback-admin interfaces for product selection analysis. */
export function registerSelectionRoutes(app: FastifyInstance, selection: SelectionModule, myData: MyDataModule, resell: ResellModule, resellImages: ResellImageService, publishDrafts: PublishDraftsModule): void {
  app.get("/api/selection/overview", { preHandler: requireSession }, async () => selection.getOverview());

  app.get("/api/selection/imports", { preHandler: requireSession }, async () => selection.listImports());
  app.delete("/api/selection/imports/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!selection.deleteImport(id)) {
      return reply.code(404).send({ error: "IMPORT_NOT_FOUND", message: "导入记录不存在" });
    }
    return reply.code(204).send();
  });

  app.post("/api/selection/my/imports/preview", { preHandler: requireSession }, async (request, reply) => {
    try {
      const upload = await readMultipartMyImport(request);
      return await myData.previewImport(upload.files, upload.fields.folderName ?? "MY 数据文件夹");
    } catch (error) {
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({
        error: "MY_IMPORT_PREVIEW_FAILED",
        message: error instanceof Error ? error.message : "无法预览 MY 数据",
      });
    }
  });
  app.post("/api/selection/my/imports", { preHandler: requireSession }, async (request, reply) => {
    try {
      const upload = await readMultipartMyImport(request);
      return reply.code(201).send(await myData.commitImport(upload.files, upload.fields.folderName ?? "MY 数据文件夹"));
    } catch (error) {
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({
        error: "MY_IMPORT_FAILED",
        message: error instanceof Error ? error.message : "MY 数据导入失败",
      });
    }
  });
  app.get("/api/selection/my/imports", { preHandler: requireSession }, async () => myData.listImports());
  app.get("/api/selection/my/overview", { preHandler: requireSession }, async (request) => {
    const query = z.object({ captureDay: z.string().date().optional() }).parse(request.query);
    return myData.getOverview(query.captureDay);
  });
  app.get("/api/selection/my/products", { preHandler: requireSession }, async (request) => myData.listProducts(myDataQuerySchema.parse(request.query)));
  app.delete("/api/selection/my/data", { preHandler: requireSession }, async (_request, reply) => {
    myData.clearData();
    return reply.code(204).send();
  });
  app.get("/api/selection/resell/source/:sku", { preHandler: requireSession }, async (request, reply) => {
    const sku = z.string().trim().min(1).max(100).parse((request.params as { sku: string }).sku);
    const source = resell.getSource(sku);
    return source ?? reply.code(404).send({ error: "RESELL_SOURCE_NOT_FOUND", message: "MY 数据中不存在该 SKU" });
  });
  app.post("/api/selection/resell/images/upload", { preHandler: requireSession }, async (request, reply) => {
    try {
      let uploaded: { fileName: string; content: Buffer } | null = null;
      for await (const part of request.parts()) {
        if (part.type === "file") {
          if (uploaded) throw new Error("每次只能上传一张图片");
          uploaded = { fileName: part.filename, content: await part.toBuffer() };
        }
      }
      if (!uploaded) throw new Error("请选择图片文件");
      return reply.code(201).send(await resellImages.upload(uploaded.fileName, uploaded.content));
    } catch (error) {
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({ error: "RESELL_IMAGE_UPLOAD_FAILED", message: error instanceof Error ? error.message : "图片上传失败" });
    }
  });
  app.delete("/api/selection/resell/images/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!resellImages.deleteAsset(id)) return reply.code(404).send({ error: "RESELL_IMAGE_NOT_FOUND", message: "图片资产不存在或已被任务使用" });
    return reply.code(204).send();
  });
  app.post("/api/selection/resell/preflight", { preHandler: requireSession }, async (request) => {
    return resell.preflight(parseResellInput(request.body));
  });
  app.post("/api/selection/resell/tasks", { preHandler: requireSession }, async (request, reply) => {
    try {
      const task = await resell.createTask(parseResellInput(request.body));
      return reply.code(202).send(task);
    } catch (error) {
      if (error instanceof ResellValidationError) {
        return reply.code(409).send({ error: "RESELL_VALIDATION_FAILED", message: error.message, issues: error.errors });
      }
      throw error;
    }
  });
  app.get("/api/selection/resell/tasks", { preHandler: requireSession }, async (request) => {
    return resell.listTasks(resellTaskListQuerySchema.parse(request.query));
  });
  app.get("/api/selection/resell/tasks/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await resell.getTaskDetail(id);
    return task ?? reply.code(404).send({ error: "RESELL_TASK_NOT_FOUND", message: "跟卖任务不存在" });
  });
  app.post("/api/selection/resell/tasks/:id/retry", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      return reply.code(202).send(await resell.retryTask(id));
    } catch (error) {
      if (error instanceof ResellValidationError) {
        return reply.code(409).send({ error: "RESELL_RETRY_FAILED", message: error.message, issues: error.errors });
      }
      throw error;
    }
  });
  app.post("/api/selection/resell/tasks/:id/stock", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      return reply.code(202).send(await resell.setTaskStock(id));
    } catch (error) {
      if (error instanceof ResellValidationError) return reply.code(409).send({ error: "RESELL_STOCK_FAILED", message: error.message, issues: error.errors });
      throw error;
    }
  });
  app.delete("/api/selection/resell/tasks/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      if (!resell.deleteFailedTask(id)) return reply.code(404).send({ error: "RESELL_TASK_NOT_FOUND", message: "跟卖任务不存在" });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof ResellValidationError) return reply.code(409).send({ error: "RESELL_DELETE_FAILED", message: error.message, issues: error.errors });
      throw error;
    }
  });

  app.post("/api/selection/publish/sources/preview", { preHandler: requireSession }, async (request, reply) => {
    try {
      const files: PublishPackageFile[] = [];
      for await (const part of request.parts()) {
        if (part.type === "file") files.push({ fileName: part.filename, content: await part.toBuffer() });
      }
      return previewPublishPackage(files);
    } catch (error) {
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({ error: "PUBLISH_SOURCE_PREVIEW_FAILED", message: error instanceof Error ? error.message : "无法预览商品包" });
    }
  });
  app.get("/api/selection/publish/online-products", { preHandler: requireSession }, async (request, reply) => {
    const query = z.object({ storeId: z.string().uuid(), visibility: z.enum(["ALL", "VISIBLE", "INVISIBLE", "ARCHIVED"]).default("ALL"), productIds: z.string().optional() }).parse(request.query);
    try {
      const productIds = query.productIds ? [...new Set(query.productIds.split(",").map((id) => id.trim()).filter(Boolean))] : undefined;
      if (productIds && (productIds.length > 1000 || productIds.some((id) => !/^\d+$/.test(id)))) return reply.code(400).send({ error: "ONLINE_PRODUCTS_READ_FAILED", message: "所选商品编号无效或超过 1000 个" });
      const items = await resell.listOnlineProducts({ storeId: query.storeId, visibility: query.visibility, ...(productIds ? { productIds } : {}) });
      return { storeId: query.storeId, visibility: query.visibility, items, count: items.length, readAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ResellValidationError) return reply.code(422).send({ error: "ONLINE_PRODUCTS_READ_FAILED", message: error.message });
      throw error;
    }
  });
  app.post("/api/selection/publish/online-products/prices", { preHandler: requireSession }, async (request, reply) => {
    const body = z.object({ storeId: z.string().uuid(), edits: z.array(z.object({ productId: z.string().regex(/^\d+$/), price: z.string().trim().min(1).max(50), oldPrice: z.string().trim().max(50).optional(), minimumPrice: z.string().trim().max(50).optional() })).min(1).max(1000) }).parse(request.body);
    try { return await resell.updateOnlineProductPrices({ storeId: body.storeId, edits: body.edits.map(({ productId, price, oldPrice, minimumPrice }) => ({ productId, price, ...(oldPrice === undefined ? {} : { oldPrice }), ...(minimumPrice === undefined ? {} : { minimumPrice }) })) }); }
    catch (error) {
      if (error instanceof ResellValidationError) return reply.code(422).send({ error: "ONLINE_PRODUCT_PRICE_UPDATE_FAILED", message: error.message });
      throw error;
    }
  });
  app.get("/api/selection/publish/online-products/warehouses", { preHandler: requireSession }, async (request, reply) => {
    const query = z.object({ storeId: z.string().uuid() }).parse(request.query);
    try { return { items: await resell.listOnlineProductWarehouses(query.storeId) }; }
    catch (error) {
      if (error instanceof ResellValidationError) return reply.code(422).send({ error: "ONLINE_PRODUCT_WAREHOUSES_READ_FAILED", message: error.message });
      throw error;
    }
  });
  app.post("/api/selection/publish/online-products/stocks", { preHandler: requireSession }, async (request, reply) => {
    const body = z.object({ storeId: z.string().uuid(), warehouseId: z.string().min(1).max(50), items: z.array(z.object({ productId: z.string().regex(/^\d+$/), stock: z.number().int().min(0).max(1_000_000) })).min(1).max(1000) }).parse(request.body);
    try { return await resell.updateOnlineProductStocks(body); }
    catch (error) {
      if (error instanceof ResellValidationError) return reply.code(422).send({ error: "ONLINE_PRODUCT_STOCK_UPDATE_FAILED", message: error.message });
      throw error;
    }
  });
  app.post("/api/selection/publish/online-products/archive", { preHandler: requireSession }, async (request, reply) => {
    const body = z.object({ storeId: z.string().uuid(), productIds: z.array(z.string().regex(/^\d+$/)).min(1).max(1000) }).parse(request.body);
    try { return await resell.archiveOnlineProducts(body); }
    catch (error) {
      if (error instanceof ResellValidationError) return reply.code(422).send({ error: "ONLINE_PRODUCT_ARCHIVE_FAILED", message: error.message });
      throw error;
    }
  });
  app.post("/api/selection/publish/online-products/source-links", { preHandler: requireSession }, async (request, reply) => {
    const body = z.object({ storeId: z.string().uuid(), edits: z.array(z.object({ productId: z.string().regex(/^\d+$/), sourceUrl: z.string().trim().max(2000).refine((value) => !value || /^https?:\/\//i.test(value), "链接需以 http:// 或 https:// 开头") })).min(1).max(1000) }).parse(request.body);
    try { return resell.updateOnlineProductSourceLinks(body); }
    catch (error) {
      if (error instanceof ResellValidationError) return reply.code(422).send({ error: "ONLINE_PRODUCT_SOURCE_LINK_UPDATE_FAILED", message: error.message });
      throw error;
    }
  });
  app.post("/api/selection/publish/distribution/submit", { preHandler: requireSession }, async (request, reply) => {
    const body = z.object({ sourceTaskIds: z.array(z.string().uuid()).min(1).max(100), targetStoreIds: z.array(z.string().uuid()).min(1).max(20) }).parse(request.body);
    const submitted: Array<{ sourceTaskId: string; targetStoreId: string; taskId: string; status: string }> = [];
    const skipped: Array<{ sourceTaskId: string; targetStoreId: string; reason: string }> = [];
    for (const sourceTaskId of [...new Set(body.sourceTaskIds)]) for (const targetStoreId of [...new Set(body.targetStoreIds)]) {
      try {
        const task = await resell.distributeTask({ sourceTaskId, targetStoreId });
        submitted.push({ sourceTaskId, targetStoreId, taskId: task.id, status: task.status });
      } catch (error) {
        if (error instanceof ResellValidationError) skipped.push({ sourceTaskId, targetStoreId, reason: error.message });
        else throw error;
      }
    }
    return reply.code(202).send({ submitted, skipped });
  });
  app.post("/api/selection/publish/sources/import", { preHandler: requireSession }, async (request, reply) => {
    const body = publishDraftSchema.parse(request.body);
    return reply.code(201).send(publishDrafts.create(body as Parameters<PublishDraftsModule["create"]>[0]));
  });
  app.get("/api/selection/publish/sources", { preHandler: requireSession }, async (request) => {
    const { stage } = publishDraftListSchema.parse(request.query);
    return publishDrafts.list(stage);
  });
  app.delete("/api/selection/publish/drafts/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    if (!publishDrafts.delete(id)) return reply.code(404).send({ error: "PUBLISH_DRAFT_NOT_FOUND", message: "商品草稿不存在" });
    return reply.code(204).send();
  });
  app.post("/api/selection/publish/sources/enrich", { preHandler: requireSession }, async (request, reply) => {
    try {
      const body = publishSourceEnrichSchema.parse(request.body);
      return await resell.enrichSource({
        storeId: body.storeId,
        sourceType: body.sourceType,
        sourceSku: body.sourceSku,
        sourceSnapshot: body.sourceSnapshot as ResellSourceView,
      });
    } catch (error) {
      if (error instanceof ResellValidationError) {
        return reply.code(422).send({ error: "PUBLISH_SOURCE_ENRICH_FAILED", message: error.message, issues: error.errors });
      }
      throw error;
    }
  });
  app.get("/api/selection/publish/sources/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const draft = publishDrafts.get(id);
    return draft ?? reply.code(404).send({ error: "PUBLISH_DRAFT_NOT_FOUND", message: "商品草稿不存在" });
  });
  app.patch("/api/selection/publish/drafts/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const draft = publishDrafts.update(id, publishDraftPatchSchema.parse(request.body) as Parameters<PublishDraftsModule["update"]>[1]);
    return draft ?? reply.code(404).send({ error: "PUBLISH_DRAFT_NOT_FOUND", message: "商品草稿不存在" });
  });
  app.post("/api/selection/publish/drafts/batch-submit", { preHandler: requireSession }, async (request, reply) => {
    const body = z.object({ draftIds: z.array(z.string().uuid()).min(1).max(100) }).parse(request.body);
    const submitted: Array<{ draftId: string; title: string | null; tasks: Array<{ variantId: string; taskId: string; status: string }> }> = [];
    const skipped: Array<{ draftId: string; title: string | null; reason: string }> = [];
    for (const draftId of [...new Set(body.draftIds)]) {
      const draft = publishDrafts.get(draftId);
      if (!draft) { skipped.push({ draftId, title: null, reason: "商品草稿不存在" }); continue; }
      if (draft.workflowStage !== "ready") { skipped.push({ draftId, title: draft.title, reason: "商品组尚未完成预检" }); continue; }
      if (!(["1688_collector", "public_page"] as string[]).includes(draft.sourceType) || draft.variants.length === 0) { skipped.push({ draftId, title: draft.title, reason: "当前仅支持包含变体的 1688 或 Ozon 商品组" }); continue; }
      const overrides = draft.fieldOverrides;
      const source = draft.sourceSnapshot;
      const storeId = String(overrides.storeId ?? "");
      const fulfillmentMode = String(overrides.fulfillmentMode ?? "FBS");
      const warehouseId = String(overrides.warehouseId ?? "");
      const vat = String(overrides.vat ?? "0");
      const groupModel = `${draft.title || source.productName} ${draft.sourceSku}`.trim().slice(0, 100);
      if (!storeId) { skipped.push({ draftId, title: draft.title, reason: "缺少目标店铺配置" }); continue; }
      const inputs: Array<{ variant: PublishVariantDraft; input: ResellPreflightInput }> = [];
      const preflightIssues: string[] = [];
      for (const variant of draft.variants) {
        const imageUrls = [variant.imageUrl, ...source.images.map((image) => image.url)].filter((url, index, all) => Boolean(url) && all.indexOf(url) === index).slice(0, 15);
        if (imageUrls.some((url) => !/^https?:\/\//i.test(url))) {
          preflightIssues.push(`${variant.label || variant.sourceSkuId || variant.id}：图片地址无效`);
          continue;
        }
        if (!variant.offerId.trim() || !variant.price.trim() || imageUrls.length === 0) {
          preflightIssues.push(`${variant.label || variant.sourceSkuId || variant.id}：缺少 Offer ID、Ozon 售价或图片`);
          continue;
        }
        if (variant.stock === null) {
          preflightIssues.push(`${variant.label || variant.sourceSkuId || variant.id}：缺少库存数据`);
          continue;
        }
        const input = parseResellInput({
          sourceSku: variant.sourceSkuId || draft.sourceSku,
          sourceType: draft.sourceType,
          sourceSnapshot: { ...source, sku: variant.sourceSkuId || draft.sourceSku, productName: draft.title || source.productName, packageDimensions: variant.packageDimensions },
          storeId, mode: "edit", offerId: variant.offerId, price: variant.price, ...(variant.oldPrice ? { oldPrice: variant.oldPrice } : {}), currency: variant.currency,
          vat, stock: variant.stock, fulfillmentMode, warehouseId, title: draft.title || source.productName,
          description: source.description ?? "", packageDimensions: variant.packageDimensions,
          // Ozon merges same-card variants by shared attribute 9048; a stable
          // source SKU suffix keeps separate supplier products with same title apart.
          attributes: { ...(source.attributes ?? {}), ...variant.attributes, 9048: groupModel },
          images: imageUrls.map((sourceUrl, position) => ({ sourceUrl, position })),
          idempotencyKey: `publish:${draft.id}:${variant.id}`, publishDraftId: draft.id, publishVariantId: variant.id,
        });
        try {
          let result = await resell.preflight(input);
          if (!input.warehouseId && result.warehouses[0]?.id) {
            input.warehouseId = result.warehouses[0].id;
            result = await resell.preflight(input);
          }
          if (!result.valid) preflightIssues.push(`${variant.label || variant.sourceSkuId || variant.id}：${result.errors.join("；")}`);
          inputs.push({ variant, input });
        } catch (error) {
          preflightIssues.push(`${variant.label || variant.sourceSkuId || variant.id}：${error instanceof Error ? error.message : "预检失败"}`);
        }
      }
      if (preflightIssues.length > 0 || inputs.length !== draft.variants.length) {
        skipped.push({ draftId, title: draft.title, reason: preflightIssues.join(" | ") || "有变体未通过预检" });
        continue;
      }
      const tasks: Array<{ variantId: string; taskId: string; status: string }> = [];
      try {
        for (const { variant, input } of inputs) {
          const task = await resell.createTask(input);
          tasks.push({ variantId: variant.id, taskId: task.id, status: task.status });
        }
        publishDrafts.update(draft.id, { workflowStage: "submitted" });
        submitted.push({ draftId, title: draft.title, tasks });
      } catch (error) {
        skipped.push({ draftId, title: draft.title, reason: `变体任务提交中断，已提交 ${tasks.length}/${inputs.length} 行：${error instanceof Error ? error.message : "未知错误"}` });
        if (tasks.length > 0) publishDrafts.update(draft.id, { workflowStage: "submitted" });
      }
    }
    return reply.code(202).send({ submitted, skipped });
  });
  app.post("/api/selection/publish/preflight", { preHandler: requireSession }, async (request) => resell.preflight(parseResellInput(request.body)));
  app.post("/api/selection/publish/tasks", { preHandler: requireSession }, async (request, reply) => {
    try {
      return reply.code(202).send(await resell.createTask(parseResellInput(request.body)));
    } catch (error) {
      if (error instanceof ResellValidationError) {
        return reply.code(409).send({
          error: "PUBLISH_VALIDATION_FAILED",
          message: error.message,
          issues: error.errors,
          ...(error.existingTaskId ? { existingTaskId: error.existingTaskId } : {}),
        });
      }
      throw error;
    }
  });
  app.get("/api/selection/publish/tasks", { preHandler: requireSession }, async (request) => resell.listTasks(resellTaskListQuerySchema.parse(request.query)));
  app.get("/api/selection/publish/tasks/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const task = await resell.getTaskDetail(id);
    return task ?? reply.code(404).send({ error: "PUBLISH_TASK_NOT_FOUND", message: "发布任务不存在" });
  });
  app.post("/api/selection/publish/tasks/:id/retry", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      return reply.code(202).send(await resell.retryTask(id));
    } catch (error) {
      if (error instanceof ResellValidationError) return reply.code(409).send({ error: "PUBLISH_RETRY_FAILED", message: error.message, issues: error.errors });
      throw error;
    }
  });
  app.post("/api/selection/publish/tasks/:id/stock", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      return reply.code(202).send(await resell.setTaskStock(id));
    } catch (error) {
      if (error instanceof ResellValidationError) return reply.code(409).send({ error: "PUBLISH_STOCK_FAILED", message: error.message, issues: error.errors });
      throw error;
    }
  });
  app.delete("/api/selection/publish/tasks/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      if (!resell.deleteFailedTask(id)) return reply.code(404).send({ error: "PUBLISH_TASK_NOT_FOUND", message: "发布任务不存在" });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof ResellValidationError) return reply.code(409).send({ error: "PUBLISH_DELETE_FAILED", message: error.message, issues: error.errors });
      throw error;
    }
  });
  app.post("/api/selection/imports/preview", { preHandler: requireSession }, async (request, reply) => {
    try {
      const upload = await readMultipartImport(request);
      return await selection.previewImport({
        fileName: upload.fileName,
        content: upload.content,
        ...(upload.fields.sheetName ? { sheetName: upload.fields.sheetName } : {}),
      });
    } catch (error) {
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({
        error: "IMPORT_PREVIEW_FAILED",
        message: error instanceof Error ? error.message : "无法预览导入文件",
      });
    }
  });
  app.post("/api/selection/imports", { preHandler: requireSession }, async (request, reply) => {
    try {
      const upload = await readMultipartImport(request);
      const mapping = upload.fields.mapping
        ? importMappingSchema.parse(JSON.parse(upload.fields.mapping))
        : undefined;
      const snapshotDate = z.string().date().parse(upload.fields.snapshotDate);
      const result = await selection.commitImport({
        fileName: upload.fileName,
        content: upload.content,
        snapshotDate,
        ...(mapping ? { mapping } : {}),
        ...(upload.fields.sheetName ? { sheetName: upload.fields.sheetName } : {}),
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (isSqliteConstraint(error)) {
        return reply.code(409).send({ error: "IMPORT_ALREADY_EXISTS", message: "该报表文件已经导入" });
      }
      return reply.code(isFileTooLarge(error) ? 413 : 400).send({
        error: "IMPORT_FAILED",
        message: error instanceof Error ? error.message : "导入失败",
      });
    }
  });

  app.get("/api/selection/keywords", { preHandler: requireSession }, async (request) => {
    return selection.listKeywords(keywordQuerySchema.parse(request.query));
  });
  app.get("/api/selection/keywords/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const keyword = selection.getKeyword(id);
    return keyword ?? reply.code(404).send({ error: "KEYWORD_NOT_FOUND", message: "关键词不存在" });
  });

  app.get("/api/selection/products", { preHandler: requireSession }, async (request) => {
    return selection.listMarketProducts(marketProductQuerySchema.parse(request.query));
  });
  app.get("/api/selection/products/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const product = selection.getMarketProduct(id);
    return product ?? reply.code(404).send({ error: "MARKET_PRODUCT_NOT_FOUND", message: "热销商品不存在" });
  });

  app.get("/api/selection/candidates", { preHandler: requireSession }, async (request) => {
    return selection.listCandidates(candidateQuerySchema.parse(request.query));
  });
  app.post("/api/selection/candidates", { preHandler: requireSession }, async (request, reply) => {
    return reply.code(201).send(selection.createCandidate(candidateCreateSchema.parse(request.body)));
  });
  app.patch("/api/selection/candidates/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      return selection.updateCandidate(id, candidateUpdateSchema.parse(request.body));
    } catch (error) {
      if (error instanceof Error && error.message === "候选商品不存在") {
        return reply.code(404).send({ error: "CANDIDATE_NOT_FOUND", message: error.message });
      }
      throw error;
    }
  });

  app.get("/api/selection/sources/wordstat", { preHandler: requireSession }, async () => {
    return selection.viewWordstatSettings();
  });
  app.put("/api/selection/sources/wordstat", { preHandler: requireSession }, async (request) => {
    return selection.updateWordstatSettings(wordstatSettingsSchema.parse(request.body));
  });
  app.post("/api/selection/sources/wordstat/test", { preHandler: requireSession }, async (_request, reply) => {
    try {
      await selection.testWordstatConnection();
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({
        error: "WORDSTAT_CONNECTION_FAILED",
        message: error instanceof Error ? error.message : "Wordstat 连接失败",
      });
    }
  });
  app.get("/api/selection/wordstat/jobs", { preHandler: requireSession }, async () => selection.listWordstatJobs());
  app.post("/api/selection/wordstat/jobs", { preHandler: requireSession }, async (request, reply) => {
    const input = wordstatJobSchema.parse(request.body);
    try {
      return reply.code(202).send(selection.enqueueWordstat(input));
    } catch (error) {
      return reply.code(409).send({
        error: "WORDSTAT_JOB_REJECTED",
        message: error instanceof Error ? error.message : "无法创建 Wordstat 任务",
      });
    }
  });
  app.get("/api/selection/wordstat/jobs/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    try {
      return selection.getWordstatJob(id);
    } catch {
      return reply.code(404).send({ error: "WORDSTAT_JOB_NOT_FOUND", message: "Wordstat 任务不存在" });
    }
  });
}
