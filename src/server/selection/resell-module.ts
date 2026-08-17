import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

import type {
  FulfillmentMode,
  ResellPreflightInput,
  ResellPreflightView,
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
import { OzonClient, type OzonProductImportItemResult } from "../ozon/client";
import type { MyDataModule } from "./my-data-module";
import { ResellImageService } from "./resell-image-service";

const DEFAULT_STOCK = 2;
const MAX_IMPORT_POLLS = 15;
const IMPORT_POLL_INTERVAL_MS = 2_000;

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
}

interface ResellTaskInput extends ResellPreflightInput {
  title?: string | undefined;
  description?: string | undefined;
  attributes?: Record<string, unknown> | undefined;
}

interface ResellModuleOptions {
  fetchImplementation?: typeof fetch;
}

export interface ResellTaskListQuery {
  page: number;
  pageSize: number;
  storeId?: string | undefined;
  status?: ResellStatus | undefined;
  from?: string | undefined;
  to?: string | undefined;
  sourceSku?: string | undefined;
}

interface ResellTaskEventRow {
  status: ResellStatus;
  message: string | null;
  created_at_ms: number;
}

export class ResellValidationError extends Error {
  public constructor(public readonly errors: string[]) {
    super(errors.join("；") || "跟卖参数不正确");
    this.name = "ResellValidationError";
  }
}

function isSuccessfulImportStatus(status: string): boolean {
  return ["imported", "processed", "success", "created"].includes(status.toLowerCase());
}

function isFailedImportStatus(status: string): boolean {
  return ["failed", "error", "rejected"].includes(status.toLowerCase());
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Ozon 请求失败";
}

function isPositiveMoney(value: string): boolean {
  const number = Number(value.replace(",", "."));
  return Number.isFinite(number) && number > 0;
}

function taskView(row: ResellTaskRow, store: StoreRecord): ResellTaskView {
  return {
    id: row.id,
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

  /** Returns the newest MY snapshot used to seed the follow-sale form. */
  public getSource(sku: string): ResellSourceView | null {
    const product = this.myData.getProductBySku(sku);
    if (!product) {
      return null;
    }
    return {
      sku: product.sku,
      productName: product.productName,
      currentPrice: product.currentPrice,
      productUrl: product.productUrl,
      imageUrl: product.imageUrl,
      images: this.images.sourceImage(product.imageUrl),
      monthlyUnits: product.monthlyUnits,
      monthlySales: product.monthlySales,
      captureDay: product.captureDay,
    };
  }

  /** Performs a read-only validation against the selected target store. */
  public async preflight(input: ResellTaskInput): Promise<ResellPreflightView> {
    const source = this.getSource(input.sourceSku);
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
        warnings: [],
        errors,
      };
    }

    const client = this.clientFor(store);
    let warehouses: ResellWarehouseView[] = [];
    let existingOffer = null as ResellPreflightView["existingOffer"];
    let limits: ResellPreflightView["limits"] = { dailyCreateRemaining: null, totalProductLimit: null };
    try {
      const [roles, warehouseResult, limitResult, products] = await Promise.all([
        client.getRoles(),
        client.getWarehouses(),
        client.getProductInfoLimit().catch(() => ({ dailyCreateRemaining: null, totalProductLimit: null })),
        client.getProductInfo([input.sourceSku]).catch(() => []),
      ]);
      if (roles.roles.length === 0) {
        errors.push("目标店铺没有可用的 Seller API 角色权限");
      }
      warehouses = warehouseResult;
      limits = limitResult;
      const existing = products.find((product) => product.offer_id === input.offerId
        || product.sources.some((sourceItem) => String(sourceItem.sku) === input.sourceSku));
      if (existing) {
        existingOffer = {
          offerId: existing.offer_id || input.offerId,
          productId: existing.id ?? existing.product_id ?? null,
          stock: null,
        };
      }
      if (input.warehouseId && !warehouses.some((warehouse) => warehouse.id === input.warehouseId)) {
        errors.push("选择的仓库不属于目标店铺");
      }
    } catch (error) {
      errors.push(formatError(error));
    }

    if (input.mode === "edit" && !input.attributes) {
      errors.push("编辑后上架需要提供类目属性");
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
      source,
      store: this.storeOption(store),
      warehouses,
      existingOffer,
      limits,
      warnings,
      errors,
    };
  }

  /** Creates an auditable task and starts the Ozon work in the background. */
  public async createTask(input: ResellTaskInput): Promise<ResellTaskView> {
    const result = await this.preflight(input);
    const errors = [...result.errors];
    if (!input.warehouseId.trim()) {
      errors.push("请选择仓库");
    }
    if (errors.length > 0) {
      throw new ResellValidationError(errors);
    }
    const store = await this.stores.findById(input.storeId);
    if (!store) {
      throw new ResellValidationError(["目标店铺不存在"]);
    }
    const existingTask = this.database.prepare("SELECT id FROM resell_tasks WHERE store_id = ? AND source_sku = ? AND target_offer_id = ?")
      .get(input.storeId, input.sourceSku, input.offerId) as { id: string } | undefined;
    if (existingTask) {
      throw new ResellValidationError(["该店铺、SKU 和 Offer ID 已有跟卖任务，请打开原任务重试"]);
    }

    const id = randomUUID();
    const now = Date.now();
    const images = await this.images.resolve(input.images, result.source.images);
    this.database.transaction(() => {
      this.database.prepare(`INSERT INTO resell_tasks
        (id, store_id, source_sku, target_offer_id, mode, price, old_price, currency, vat, stock,
         fulfillment_mode, warehouse_id, title, description, attributes_json, status,
         created_at_ms, updated_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?)`)
        .run(id, input.storeId, input.sourceSku, input.offerId, input.mode, input.price, input.oldPrice ?? null,
          input.currency, input.vat, input.stock, input.fulfillmentMode, input.warehouseId,
          input.title ?? result.source.productName, input.description ?? null,
          input.attributes ? JSON.stringify(input.attributes) : null, now, now);
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
      const source = this.getSource(row.source_sku);
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
    const source = this.getSource(row.source_sku);
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
    if (row.product_id) {
      throw new ResellValidationError(["商品已在 Ozon 创建，请先修正已有商品，不要重复创建"]);
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

  private async runTask(id: string): Promise<void> {
    const row = this.readTask(id);
    const store = await this.stores.findById(row.store_id);
    const source = this.getSource(row.source_sku);
    if (!store || !source) {
      throw new Error("跟卖来源商品或目标店铺不存在");
    }
    const client = this.clientFor(store);
    const attributes = row.attributes_json ? JSON.parse(row.attributes_json) as Record<string, unknown> : undefined;
    const imageUrls = this.images.listTaskImageUrls(id);
    const result = row.mode === "quick"
      ? await client.importProductBySku({ sku: row.source_sku, name: row.title ?? source.productName, offerId: row.target_offer_id, price: row.price, ...(row.old_price ? { oldPrice: row.old_price } : {}), currency: row.currency, vat: row.vat })
      : await client.importProduct({
        offer_id: row.target_offer_id,
        name: row.title ?? source.productName,
        ...(row.description ? { description: row.description } : {}),
        price: row.price,
        ...(row.old_price ? { old_price: row.old_price } : {}),
        currency_code: row.currency,
        vat: row.vat,
        ...(imageUrls.length > 0 ? { images: imageUrls } : {}),
        ...(attributes ?? {}),
      });
    if (result.unmatchedSkuList.length > 0) {
      throw new Error(`Ozon 无法匹配 SKU：${result.unmatchedSkuList.join(", ")}`);
    }
    this.setTaskOzonId(id, result.taskId);
    this.updateTask(id, "pending", null);

    const imported = await this.waitForImport(client, result.taskId);
    const importedItem = imported.find((item) => item.offerId === row.target_offer_id) ?? imported[0];
    if (!importedItem) {
      this.updateTask(id, "pending", "Ozon 仍在处理商品导入，请稍后刷新或重试");
      return;
    }
    const blockingErrors = importedItem.errors.filter((error) => !error.toLowerCase().includes("warning"));
    if (isFailedImportStatus(importedItem.status) || blockingErrors.length > 0) {
      throw new Error(blockingErrors.join("；") || importedItem.errors.join("；") || `Ozon 返回商品状态：${importedItem.status}`);
    }
    if (!isSuccessfulImportStatus(importedItem.status)) {
      this.updateTask(id, "pending", `Ozon 返回商品状态：${importedItem.status}`);
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
    await client.updateProductPrice({ offerId: row.target_offer_id, price: row.price, ...(row.old_price ? { oldPrice: row.old_price } : {}), currency: row.currency, vat: row.vat });
    this.updateTask(id, "setting_stock", null);
    try {
      await client.updateProductStock({ offerId: row.target_offer_id, productId: importedItem.productId, warehouseId: row.warehouse_id, stock: row.stock });
    } catch (error) {
      const message = formatError(error);
      this.updateTask(id, message.includes("TAGGED") ? "moderating" : "failed", message);
      return;
    }
    this.updateTask(id, "sellable", null);
  }

  private async waitForImport(client: OzonClient, taskId: string): Promise<OzonProductImportItemResult[]> {
    let latest: OzonProductImportItemResult[] = [];
    for (let attempt = 0; attempt < MAX_IMPORT_POLLS; attempt += 1) {
      latest = await client.getProductImportInfo(taskId);
      const item = latest[0];
      if (item && (isSuccessfulImportStatus(item.status) || isFailedImportStatus(item.status))) {
        return latest;
      }
      await wait(IMPORT_POLL_INTERVAL_MS);
    }
    return latest;
  }

  private validateInput(input: ResellTaskInput, store: StoreRecord | null, source: ResellSourceView | null): string[] {
    const errors: string[] = [];
    if (!source) errors.push("MY 数据中不存在该 SKU");
    if (!store) errors.push("目标店铺不存在");
    if (store && !store.enabled) errors.push("目标店铺已停用");
    if (store && !store.fulfillmentModes.includes(input.fulfillmentMode)) errors.push("目标店铺未启用该履约模式");
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(input.offerId)) errors.push("Offer ID 只能包含字母、数字、点、下划线和短横线");
    if (!isPositiveMoney(input.price)) errors.push("销售价必须是大于 0 的数字");
    if (input.oldPrice && !isPositiveMoney(input.oldPrice)) errors.push("划线价必须是大于 0 的数字");
    if (!/^[A-Z]{3}$/.test(input.currency)) errors.push("币种必须是 3 位大写代码");
    const vat = Number(input.vat.replace(",", "."));
    if (!input.vat.trim()) errors.push("VAT 不能为空");
    else if (!Number.isFinite(vat) || vat < 0 || vat > 1) errors.push("VAT 必须是 0 到 1 之间的数字，例如 0 或 0.2");
    if (!Number.isInteger(input.stock) || input.stock < 0) errors.push("库存必须是非负整数");
    return errors;
  }

  private clientFor(store: StoreRecord): OzonClient {
    return new OzonClient({
      clientId: store.clientId,
      apiKey: decryptSecret(store.apiKeyCiphertext, this.config.ENCRYPTION_KEY),
      baseUrl: this.config.OZON_API_BASE_URL,
      fetchImplementation: this.fetchImplementation,
    });
  }

  private storeOption(store: StoreRecord): ResellPreflightView["store"] {
    return { id: store.id, name: store.name, color: store.color, fulfillmentModes: store.fulfillmentModes };
  }

  private emptySource(sku: string): ResellSourceView {
    return { sku, productName: "", currentPrice: { amount: "0", currency: "RUB" }, productUrl: "", imageUrl: null, images: [], monthlyUnits: 0, monthlySales: { amount: "0", currency: "RUB" }, captureDay: "" };
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

  private updateTask(id: string, status: ResellStatus, error: string | null): void {
    const now = Date.now();
    this.database.transaction(() => {
      this.database.prepare("UPDATE resell_tasks SET status = ?, last_error = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ?")
        .run(status, error, now, ["sellable", "failed"].includes(status) ? now : null, id);
      this.recordEvent(id, status, error);
    })();
  }

  private recordEvent(taskId: string, status: string, message: string | null): void {
    this.database.prepare("INSERT INTO resell_task_events (id, task_id, status, message, created_at_ms) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), taskId, status, message, Date.now());
  }
}

export { DEFAULT_STOCK };
