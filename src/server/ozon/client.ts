import { setTimeout as wait } from "node:timers/promises";

import type { ZodType } from "zod";

import {
  postingListResponseSchema,
  productInfoListResponseSchema,
  rolesResponseSchema,
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
