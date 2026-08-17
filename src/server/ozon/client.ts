import { setTimeout as wait } from "node:timers/promises";

import type { ZodType } from "zod";

import {
  postingListResponseSchema,
  productImportInfoResponseSchema,
  productImportResponseSchema,
  productInfoLimitResponseSchema,
  productInfoListResponseSchema,
  productPicturesImportResponseSchema,
  productPicturesInfoResponseSchema,
  rolesResponseSchema,
  warehouseListResponseSchema,
  type OzonPosting,
  type OzonProductInfo,
  type OzonRoles,
} from "./schemas";

interface OzonClientOptions {
  clientId: string;
  apiKey: string;
  baseUrl: string;
  fetchImplementation?: typeof fetch;
  maxAttempts?: number;
}

export interface OzonPostingPage {
  postings: OzonPosting[];
  nextCursor: string | null;
  hasNext: boolean;
}

export interface OzonProductImportResult {
  taskId: string;
  unmatchedSkuList: string[];
}

export interface OzonProductImportItemResult {
  offerId: string;
  productId: string | null;
  status: string;
  errors: string[];
  warnings: string[];
}

export interface OzonWarehouse {
  id: string;
  name: string;
  status: string;
}

export interface OzonProductInfoLimit {
  dailyCreateRemaining: number | null;
  totalProductLimit: number | null;
}

export class OzonApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OzonApiError";
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(seconds * 1000, 30_000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), 30_000);
    }
  }
  const base = Math.min(500 * 2 ** attempt, 10_000);
  return base + Math.floor(Math.random() * 250);
}

export class OzonClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly maxAttempts: number;

  public constructor(private readonly options: OzonClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 4;
  }

  /** Returns the roles and expiry reported for the supplied API key. */
  public async getRoles(): Promise<OzonRoles> {
    return this.request("/v1/roles", {}, rolesResponseSchema);
  }

  /** Returns product card metadata for at most 1000 seller SKUs. */
  public async getProductInfo(skus: string[]): Promise<OzonProductInfo[]> {
    if (skus.length === 0 || skus.length > 1000) {
      throw new RangeError("Ozon product info requests require between 1 and 1000 SKUs");
    }
    const response = await this.request("/v3/product/info/list", { sku: skus }, productInfoListResponseSchema);
    return response.items;
  }

  /** Creates a target-store product from an Ozon catalog SKU. */
  public async importProductBySku(input: {
    sku: string;
    name: string;
    offerId: string;
    price: string;
    oldPrice?: string | undefined;
    currency: string;
    vat: string;
  }): Promise<OzonProductImportResult> {
    const response = await this.request("/v1/product/import-by-sku", {
      items: [{
        sku: input.sku,
        name: input.name,
        offer_id: input.offerId,
        price: input.price,
        ...(input.oldPrice ? { old_price: input.oldPrice } : {}),
        currency_code: input.currency,
        vat: input.vat,
      }],
    }, productImportResponseSchema);
    return { taskId: response.result.task_id, unmatchedSkuList: response.result.unmatched_sku_list };
  }

  /** Creates or updates a complete product card for edit mode. */
  public async importProduct(input: Record<string, unknown>): Promise<OzonProductImportResult> {
    const response = await this.request("/v3/product/import", { items: [input] }, productImportResponseSchema);
    return { taskId: response.result.task_id, unmatchedSkuList: response.result.unmatched_sku_list };
  }

  /** Reads the asynchronous product import result. */
  public async getProductImportInfo(taskId: string): Promise<OzonProductImportItemResult[]> {
    const response = await this.request("/v1/product/import/info", { task_id: taskId }, productImportInfoResponseSchema);
    return response.result.items.map((item) => ({
      offerId: item.offer_id,
      productId: item.product_id ?? null,
      status: item.status,
      errors: item.errors.filter((error) => error.level !== "warning").flatMap((error) => [error.code, error.message].filter((value): value is string => Boolean(value))),
      warnings: item.errors.filter((error) => error.level === "warning").flatMap((error) => [error.code, error.message].filter((value): value is string => Boolean(value))),
    }));
  }

  /** Replaces the complete ordered image list after a product receives a product ID. */
  public async importProductPictures(input: { productId: string; images: string[] }): Promise<void> {
    await this.request("/v1/product/pictures/import", {
      product_id: Number(input.productId) || input.productId,
      images: input.images,
    }, productPicturesImportResponseSchema);
  }

  /** Verifies that Ozon accepted the complete product image list before pricing and stock updates. */
  public async verifyProductPictures(productId: string): Promise<void> {
    const response = await this.request("/v2/product/pictures/info", {
      product_id: [Number(productId) || productId],
    }, productPicturesInfoResponseSchema);
    const body = response as { items?: Array<{ errors?: Array<{ message?: string | null }> }> };
    const errors = body.items?.flatMap((item) => item.errors ?? []).map((error) => error.message).filter((message): message is string => Boolean(message)) ?? [];
    if (errors.length > 0) {
      throw new Error(`Ozon 图片校验失败：${errors.join("；")}`);
    }
  }

  /** Returns target-store warehouses used by FBO, FBS, or rFBS inventory. */
  public async getWarehouses(): Promise<OzonWarehouse[]> {
    const response = await this.request("/v2/warehouse/list", {}, warehouseListResponseSchema);
    return response.warehouses.flatMap((warehouse) => {
      const id = warehouse.warehouse_id ?? warehouse.id;
      return id ? [{ id, name: warehouse.name || id, status: warehouse.status }] : [];
    });
  }

  /** Returns the target-store product creation limits when the account exposes them. */
  public async getProductInfoLimit(): Promise<OzonProductInfoLimit> {
    const response = await this.request("/v4/product/info/limit", {}, productInfoLimitResponseSchema);
    return {
      dailyCreateRemaining: response.daily_create_remaining ?? null,
      totalProductLimit: response.total_product_limit ?? null,
    };
  }

  /** Updates target-store prices after a product import has completed. */
  public async updateProductPrice(input: {
    offerId: string;
    price: string;
    oldPrice?: string | undefined;
    currency: string;
    vat: string;
  }): Promise<void> {
    await this.request("/v1/product/import/prices", {
      prices: [{
        offer_id: input.offerId,
        price: input.price,
        ...(input.oldPrice ? { old_price: input.oldPrice } : {}),
        currency_code: input.currency,
        vat: input.vat,
      }],
    }, null);
  }

  /** Sets target-store stock only after Ozon reports a product ID. */
  public async updateProductStock(input: {
    offerId: string;
    productId: string;
    warehouseId: string;
    stock: number;
  }): Promise<void> {
    await this.request("/v2/products/stocks", {
      stocks: [{
        offer_id: input.offerId,
        product_id: input.productId,
        warehouse_id: input.warehouseId,
        stock: input.stock,
      }],
    }, null);
  }

  /** Iterates current cursor-paginated FBO v3 or FBS v4 posting pages. */
  public async *iteratePostingPages(
    source: "FBO" | "FBS",
    since: Date,
    to: Date,
    startCursor?: string,
  ): AsyncGenerator<OzonPostingPage> {
    let cursor = startCursor;
    let page = 0;
    while (true) {
      const response = await this.request(
        source === "FBO" ? "/v3/posting/fbo/list" : "/v4/posting/fbs/list",
        this.buildListPayload(source, since, to, cursor),
        postingListResponseSchema,
      );
      const nextCursor = response.cursor || null;
      yield { postings: response.postings, nextCursor, hasNext: response.has_next };
      page += 1;
      if (!response.has_next) {
        break;
      }
      if (!nextCursor) {
        throw new Error(`Ozon ${source} pagination returned has_next without a cursor`);
      }
      if (page > 10_000) {
        throw new Error(`Ozon ${source} pagination exceeded the safety limit`);
      }
      cursor = nextCursor;
    }
  }

  private buildListPayload(source: "FBO" | "FBS", since: Date, to: Date, cursor?: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      filter: { since: since.toISOString(), to: to.toISOString() },
      limit: 100,
      sort_dir: "ASC",
      translit: false,
      with: {
        analytics_data: false,
        financial_data: false,
        legal_info: false,
        ...(source === "FBS" ? { barcodes: false } : {}),
      },
    };
    if (cursor) {
      payload.cursor = cursor;
    }
    return payload;
  }

  private async request<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T>;
  private async request(path: string, body: unknown, schema: null): Promise<void>;
  private async request<T>(path: string, body: unknown, schema: ZodType<T> | null): Promise<T | void> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(new URL(path, this.options.baseUrl), {
          method: "POST",
          headers: {
            "Client-Id": this.options.clientId,
            "Api-Key": this.options.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        if (attempt + 1 >= this.maxAttempts) {
          throw new OzonApiError(error instanceof Error ? error.message : "Ozon network request failed", 0, true);
        }
        await wait(Math.min(500 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250));
        continue;
      }

      if (response.ok) {
        if (!schema) {
          return;
        }
        return schema.parse(await response.json());
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt + 1 < this.maxAttempts) {
        await wait(retryDelay(response, attempt));
        continue;
      }
      const responseText = (await response.text()).slice(0, 500);
      throw new OzonApiError(`Ozon API ${response.status}: ${responseText || response.statusText}`, response.status, retryable);
    }
    throw new OzonApiError("Ozon API retry budget exhausted", 0, true);
  }
}
