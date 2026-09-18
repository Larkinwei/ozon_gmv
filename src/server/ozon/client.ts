import { setTimeout as wait } from "node:timers/promises";

import type { ZodType } from "zod";

import {
  postingListResponseSchema,
  descriptionCategoryTreeResponseSchema,
  descriptionCategoryAttributesResponseSchema,
  descriptionCategoryAttributeValuesResponseSchema,
  productImportInfoResponseSchema,
  productImportResponseSchema,
  productInfoLimitResponseSchema,
  productInfoListResponseSchema,
  productPicturesImportResponseSchema,
  productPicturesInfoResponseSchema,
  stockReadbackResponseSchema,
  stockUpdateResponseSchema,
  rolesResponseSchema,
  sellerInfoResponseSchema,
  financeBalanceResponseSchema,
  financeAccrualByDayResponseSchema,
  financeAccrualPostingsResponseSchema,
  financeAccrualTypesResponseSchema,
  financeCashFlowStatementResponseSchema,
  questionCountResponseSchema,
  questionInfoResponseSchema,
  questionListResponseSchema,
  warehouseListResponseSchema,
  type OzonPosting,
  type OzonDescriptionCategoryNode,
  type OzonProductInfo,
  type OzonRoles,
  type OzonFinanceAccrual,
  type OzonFinanceAccrualPostings,
  type OzonFinanceAccrualType,
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

export interface OzonSellerInfo {
  currency: string | null;
  country: string | null;
}

export interface OzonFinanceAmount {
  currencyCode: string | null;
  value: string | null;
}

export interface OzonFinanceBalance {
  openingBalance: OzonFinanceAmount | null;
  closingBalance: OzonFinanceAmount | null;
  accrued: OzonFinanceAmount | null;
  payments: OzonFinanceAmount[];
}

export interface OzonFinanceAccrualPage {
  accruals: OzonFinanceAccrual[];
  lastId: string | null;
}

export interface OzonFinanceAccrualPosting extends OzonFinanceAccrualPostings {}

export interface OzonFinanceCashFlowReport {
  raw: unknown;
}

export interface OzonQuestion {
  id: string;
  text: string;
  status: string;
  sku: string | null;
  productName: string | null;
  productUrl: string | null;
  questionLink: string | null;
  publishedAt: string | null;
  answersCount: number;
}

export interface OzonQuestionCount {
  all: number;
  new: number;
  processed: number;
  unprocessed: number;
  viewed: number;
}

export interface OzonQuestionList {
  questions: OzonQuestion[];
  lastId: string | null;
  hasNext: boolean;
}

export interface OzonCategoryAttribute {
  id: number;
  name: string;
  required: boolean;
  dictionaryId: number | null;
  isCollection: boolean;
  type: string | null;
  raw: Record<string, unknown>;
}

export interface OzonCategoryAttributeValue {
  id: string;
  name: string;
}

export interface OzonStockUpdateResult {
  updated: boolean;
  errors: string[];
  offerId: string | null;
  productId: string | null;
  warehouseId: string | null;
}

export interface OzonProductStock {
  offerId: string | null;
  productId: string | null;
  warehouseId: string | null;
  stock: number | null;
  reserved: number | null;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeFinanceAmount(value: { currency_code?: string | null | undefined; value?: string | null | undefined } | null | undefined): OzonFinanceAmount | null {
  if (!value || value.value === null || value.value === undefined) {
    return null;
  }
  const currencyCode = value.currency_code?.trim().toUpperCase() || null;
  return { currencyCode, value: String(value.value) };
}

function formatFinanceDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function normalizeQuestion(value: {
  id?: string | null | undefined;
  question_id?: string | null | undefined;
  answers_count?: number | undefined;
  product_url?: string | null | undefined;
  question_link?: string | null | undefined;
  published_at?: string | null | undefined;
  sku?: string | null | undefined;
  status?: string | null | undefined;
  text?: string | undefined;
  product_name?: string | null | undefined;
}): OzonQuestion {
  const id = value.id ?? value.question_id;
  if (!id) {
    throw new Error("Ozon question response is missing the question id");
  }
  return {
    id,
    text: value.text ?? "",
    status: value.status ?? "UNKNOWN",
    sku: value.sku ?? null,
    productName: value.product_name ?? null,
    productUrl: value.product_url ?? null,
    questionLink: value.question_link ?? null,
    publishedAt: value.published_at ?? null,
    answersCount: value.answers_count ?? 0,
  };
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeCategoryAttribute(value: unknown): OzonCategoryAttribute[] {
  const record = asRecord(value);
  if (!record) return [];
  const id = positiveNumber(record.id ?? record.attribute_id);
  if (!id) return [];
  const name = String(record.name ?? record.title ?? record.attribute_name ?? `属性 ${id}`).trim();
  return [{
    id,
    name,
    required: record.is_required === true || record.required === true,
    dictionaryId: positiveNumber(record.dictionary_id ?? record.dictionaryId),
    isCollection: record.is_collection === true || record.collection === true,
    type: typeof record.type === "string" ? record.type : null,
    raw: record,
  }];
}

function normalizeCategoryAttributeValue(value: unknown): OzonCategoryAttributeValue[] {
  const record = asRecord(value);
  if (!record) return [];
  const id = record.id ?? record.value_id ?? record.valueId ?? record.dictionary_value_id;
  const name = String(record.name ?? record.value ?? record.title ?? "").trim();
  return id !== undefined && name ? [{ id: String(id), name }] : [];
}

function responseItems(value: unknown, key: "attributes" | "values"): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  return record && Array.isArray(record[key]) ? record[key] : [];
}

function stockItems(response: { result: unknown }): Array<{
  offer_id?: string | null;
  product_id?: string | null;
  warehouse_id?: string | null;
  updated?: boolean | null;
  errors?: Array<string | { code?: string | null; message?: string | null }>;
  stock?: number | null;
  present?: number | null;
  reserved?: number | null;
}> {
  const result = response.result;
  if (Array.isArray(result)) return result;
  const record = asRecord(result);
  return record && Array.isArray(record.items) ? record.items as Array<{
    offer_id?: string | null;
    product_id?: string | null;
    warehouse_id?: string | null;
    updated?: boolean | null;
    errors?: Array<string | { code?: string | null; message?: string | null }>;
    stock?: number | null;
    present?: number | null;
    reserved?: number | null;
  }> : [];
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

  /** Returns the settlement currency and country configured for the seller contract. */
  public async getSellerInfo(): Promise<OzonSellerInfo> {
    const response = await this.request("/v1/seller/info", {}, sellerInfoResponseSchema);
    const currency = response.company?.currency?.trim().toUpperCase() || null;
    const country = response.company?.country?.trim().toUpperCase() || null;
    return { currency, country };
  }

  /** Reads the Ozon balance report for the most recent 30-day reporting window. */
  public async getFinanceBalance(dateFrom: Date, dateTo: Date): Promise<OzonFinanceBalance> {
    const response = await this.request("/v1/finance/balance", {
      date_from: formatFinanceDate(dateFrom),
      date_to: formatFinanceDate(dateTo),
    }, financeBalanceResponseSchema);
    const total = response.total;
    return {
      openingBalance: normalizeFinanceAmount(total?.opening_balance),
      closingBalance: normalizeFinanceAmount(total?.closing_balance),
      accrued: normalizeFinanceAmount(total?.accrued),
      payments: (total?.payments ?? []).map((payment) => normalizeFinanceAmount(payment)).filter((payment): payment is OzonFinanceAmount => payment !== null),
    };
  }

  /** Reads one cursor page of the new Ozon accrual ledger for a calendar date. */
  public async getFinanceAccrualByDay(date: string, lastId = ""): Promise<OzonFinanceAccrualPage> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new RangeError(`Invalid finance accrual date: ${date}`);
    }
    const response = await this.request("/v1/finance/accrual/by-day", {
      date,
      last_id: lastId,
    }, financeAccrualByDayResponseSchema);
    return { accruals: response.accruals, lastId: response.last_id ?? null };
  }

  /** Reads the dynamic finance type dictionary used to label and classify accruals. */
  public async getFinanceAccrualTypes(): Promise<OzonFinanceAccrualType[]> {
    const response = await this.request("/v1/finance/accrual/types", {}, financeAccrualTypesResponseSchema);
    return response.accrual_types;
  }

  /** Reads order-level accrual rows for a bounded batch of posting numbers. */
  public async getFinanceAccrualPostings(postingNumbers: string[]): Promise<OzonFinanceAccrualPosting[]> {
    if (postingNumbers.length === 0) {
      return [];
    }
    const response = await this.request("/v1/finance/accrual/postings", { posting_numbers: postingNumbers }, financeAccrualPostingsResponseSchema);
    return response.posting_accruals;
  }

  /** Stores the seller-level cash-flow response for reconciliation without reshaping unknown fields. */
  public async getFinanceCashFlowStatement(dateFrom: Date, dateTo: Date): Promise<OzonFinanceCashFlowReport> {
    const raw = await this.request("/v1/finance/cash-flow-statement/list", {
      page: 1,
      page_size: 1000,
      date: { from: formatFinanceDate(dateFrom), to: formatFinanceDate(dateTo) },
      with_details: true,
    }, financeCashFlowStatementResponseSchema);
    return { raw };
  }

  /** Returns status counts for product questions, when the seller plan grants access. */
  public async getQuestionCount(): Promise<OzonQuestionCount> {
    const response = await this.request("/v1/question/count", {}, questionCountResponseSchema);
    return response;
  }

  /** Returns the most recent product questions in descending publication order. */
  public async getQuestionList(limit = 5): Promise<OzonQuestionList> {
    const response = await this.request("/v1/question/list", {
      filter: { status: "ALL" },
      limit,
      last_id: "",
      sort_dir: "DESC",
    }, questionListResponseSchema);
    return {
      questions: response.questions.map(normalizeQuestion),
      lastId: response.last_id ?? null,
      hasNext: response.has_next,
    };
  }

  /** Returns one product question for the read-only dashboard detail drawer. */
  public async getQuestionInfo(questionId: string): Promise<OzonQuestion> {
    const response = await this.request("/v1/question/info", { question_id: questionId }, questionInfoResponseSchema);
    return normalizeQuestion(response);
  }

  /** Returns product card metadata for at most 1000 seller SKUs. */
  public async getProductInfo(skus: string[]): Promise<OzonProductInfo[]> {
    if (skus.length === 0 || skus.length > 1000) {
      throw new RangeError("Ozon product info requests require between 1 and 1000 SKUs");
    }
    const response = await this.request("/v3/product/info/list", { sku: skus }, productInfoListResponseSchema);
    return response.items;
  }

  /** Returns the official product category/type tree for the target seller account. */
  public async getDescriptionCategoryTree(language = "DEFAULT"): Promise<OzonDescriptionCategoryNode[]> {
    const response = await this.request("/v1/description-category/tree", { language }, descriptionCategoryTreeResponseSchema);
    return response.result;
  }

  /** Returns dynamic required/optional attributes for one target-store product type. */
  public async getDescriptionCategoryAttributes(input: {
    descriptionCategoryId: number;
    typeId: number;
    language?: string;
  }): Promise<OzonCategoryAttribute[]> {
    const response = await this.request("/v1/description-category/attribute", {
      description_category_id: input.descriptionCategoryId,
      type_id: input.typeId,
      language: input.language ?? "DEFAULT",
    }, descriptionCategoryAttributesResponseSchema);
    return responseItems(response.result, "attributes").flatMap((value) => normalizeCategoryAttribute(value));
  }

  /** Returns dictionary values for a category attribute. */
  public async getDescriptionCategoryAttributeValues(input: {
    descriptionCategoryId: number;
    typeId: number;
    attributeId: number;
    language?: string;
  }): Promise<OzonCategoryAttributeValue[]> {
    const response = await this.request("/v1/description-category/attribute/values", {
      description_category_id: input.descriptionCategoryId,
      type_id: input.typeId,
      attribute_id: input.attributeId,
      language: input.language ?? "DEFAULT",
      limit: 100,
      last_value_id: 0,
    }, descriptionCategoryAttributeValuesResponseSchema);
    return responseItems(response.result, "values").flatMap((value) => normalizeCategoryAttributeValue(value));
  }

  /** Searches dictionary values when a category has a large value set. */
  public async searchDescriptionCategoryAttributeValues(input: {
    descriptionCategoryId: number;
    typeId: number;
    attributeId: number;
    query: string;
    language?: string;
  }): Promise<OzonCategoryAttributeValue[]> {
    const response = await this.request("/v1/description-category/attribute/values/search", {
      description_category_id: input.descriptionCategoryId,
      type_id: input.typeId,
      attribute_id: input.attributeId,
      language: input.language ?? "DEFAULT",
      limit: 100,
      value: input.query,
    }, descriptionCategoryAttributeValuesResponseSchema);
    return responseItems(response.result, "values").flatMap((value) => normalizeCategoryAttributeValue(value));
  }

  /** Creates a target-store product from an Ozon catalog SKU. */
  public async importProductBySku(input: {
    sku: string;
    name: string;
    typeId: number;
    descriptionCategoryId?: number | null | undefined;
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
        type_id: input.typeId,
        ...(input.descriptionCategoryId ? { description_category_id: input.descriptionCategoryId } : {}),
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
  }): Promise<OzonStockUpdateResult> {
    const response = await this.request("/v2/products/stocks", {
      stocks: [{
        offer_id: input.offerId,
        product_id: input.productId,
        warehouse_id: input.warehouseId,
        stock: input.stock,
      }],
    }, stockUpdateResponseSchema);
    const item = stockItems(response)[0];
    if (!item) {
      throw new Error("Ozon 库存接口未返回目标商品结果");
    }
    const errors = (item.errors ?? []).flatMap((error) => {
      if (typeof error === "string") return [error];
      return [error.code, error.message].filter((value): value is string => Boolean(value));
    });
    const result: OzonStockUpdateResult = {
      updated: item.updated === true,
      errors,
      offerId: item.offer_id ?? null,
      productId: item.product_id ?? null,
      warehouseId: item.warehouse_id ?? null,
    };
    const identityMismatch = [
      result.offerId && result.offerId !== input.offerId ? `Offer ID 不匹配（返回 ${result.offerId}）` : null,
      result.productId && result.productId !== input.productId ? `Product ID 不匹配（返回 ${result.productId}）` : null,
      result.warehouseId && result.warehouseId !== input.warehouseId ? `仓库 ID 不匹配（返回 ${result.warehouseId}）` : null,
    ].filter((message): message is string => Boolean(message));
    if (!result.updated || result.errors.length > 0 || identityMismatch.length > 0) {
      throw new Error(`Ozon 库存配置未确认：${[...identityMismatch, ...result.errors].join("；") || "updated=false"}`);
    }
    return result;
  }

  /** Reads the actual stock in the selected FBS/rFBS warehouse after an update. */
  public async getFbsStockByWarehouse(input: {
    offerId: string;
    productId: string;
    warehouseId: string;
  }): Promise<OzonProductStock | null> {
    const response = await this.request("/v2/product/info/stocks-by-warehouse/fbs", {
      warehouse_id: Number(input.warehouseId) || input.warehouseId,
      limit: 100,
      offset: 0,
    }, stockReadbackResponseSchema);
    const item = stockItems(response).find((candidate) => {
      const productMatches = !candidate.product_id || candidate.product_id === input.productId;
      const warehouseMatches = !candidate.warehouse_id || candidate.warehouse_id === input.warehouseId;
      const offerMatches = !candidate.offer_id || candidate.offer_id === input.offerId;
      return productMatches && warehouseMatches && offerMatches;
    });
    if (!item) return null;
    const stock = item.stock ?? item.present ?? null;
    return {
      offerId: item.offer_id ?? null,
      productId: item.product_id ?? null,
      warehouseId: item.warehouse_id ?? null,
      stock: Number.isFinite(stock) ? stock : null,
      reserved: item.reserved ?? null,
    };
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
