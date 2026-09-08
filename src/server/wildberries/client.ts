import { setTimeout as wait } from "node:timers/promises";

import { format } from "date-fns";
import type { ZodType } from "zod";

import {
  wildberriesBalanceResponseSchema,
  wildberriesReportResponseSchema,
  type WildberriesBalanceResponse,
  type WildberriesReportRow,
} from "./schemas";

const MAX_AUTOMATIC_RETRY_DELAY_MS = 10_000;

export const WILDBERRIES_API_BASE_URLS = {
  statistics: "https://statistics-api.wildberries.ru",
  finance: "https://finance-api.wildberries.ru",
} as const;

export interface WildberriesClientOptions {
  apiToken: string;
  statisticsBaseUrl?: string;
  financeBaseUrl?: string;
  fetchImplementation?: typeof fetch;
  directFetchImplementation?: typeof fetch;
  maxAttempts?: number;
}

export class WildberriesApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "WildberriesApiError";
  }
}

function retryDelay(response: Response, attempt: number): number {
  const wildberriesRetry = response.headers.get("x-ratelimit-retry");
  if (wildberriesRetry) {
    const seconds = Number(wildberriesRetry);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(seconds * 1000, 30_000);
    }
  }
  return Math.min(500 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250);
}

function dateParameter(value: Date): string {
  return format(value, "yyyy-MM-dd");
}

export class WildberriesClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly maxAttempts: number;
  private readonly statisticsBaseUrl: string;
  private readonly financeBaseUrl: string;
  private readonly directFetchImplementation: typeof fetch;

  public constructor(private readonly options: WildberriesClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 4;
    this.statisticsBaseUrl = options.statisticsBaseUrl ?? WILDBERRIES_API_BASE_URLS.statistics;
    this.financeBaseUrl = options.financeBaseUrl ?? WILDBERRIES_API_BASE_URLS.finance;
    this.directFetchImplementation = options.directFetchImplementation ?? fetch;
  }

  public async getOrders(dateFrom: Date, dateTo: Date): Promise<WildberriesReportRow[]> {
    return this.request(
      this.statisticsBaseUrl,
      "/api/v1/supplier/orders",
      { dateFrom: dateParameter(dateFrom), flag: "0" },
      wildberriesReportResponseSchema,
    );
  }

  public async getSales(dateFrom: Date, dateTo: Date): Promise<WildberriesReportRow[]> {
    return this.request(
      this.statisticsBaseUrl,
      "/api/v1/supplier/sales",
      { dateFrom: dateParameter(dateFrom), flag: "0" },
      wildberriesReportResponseSchema,
    );
  }

  public async getBalance(): Promise<WildberriesBalanceResponse> {
    return this.request(this.financeBaseUrl, "/api/v1/account/balance", {}, wildberriesBalanceResponseSchema);
  }

  private async request<T>(baseUrl: string, path: string, query: Record<string, string>, schema: ZodType<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const url = new URL(path, baseUrl);
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
      let response: Response;
      try {
        response = await this.fetch(url);
      } catch (proxyError) {
        if (this.fetchImplementation === this.directFetchImplementation) {
          if (attempt + 1 >= this.maxAttempts) {
            throw new WildberriesApiError(proxyError instanceof Error ? proxyError.message : "Wildberries network request failed", 0, true);
          }
          await wait(Math.min(500 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250));
          continue;
        }
        try {
          response = await this.directFetch(url);
        } catch (directError) {
          if (attempt + 1 >= this.maxAttempts) {
            throw new WildberriesApiError(directError instanceof Error ? directError.message : "Wildberries network request failed", 0, true);
          }
          await wait(Math.min(500 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250));
          continue;
        }
      }
      if (!response) {
        if (attempt + 1 >= this.maxAttempts) {
          throw new WildberriesApiError("Wildberries network request failed", 0, true);
        }
        await wait(Math.min(500 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250));
        continue;
      }
      if (response.ok) {
        return schema.parse(await response.json());
      }
      const retryable = response.status === 429 || response.status >= 500;
      const delayMs = retryDelay(response, attempt);
      if (retryable && attempt + 1 < this.maxAttempts && delayMs <= MAX_AUTOMATIC_RETRY_DELAY_MS) {
        await wait(delayMs);
        continue;
      }
      const responseText = (await response.text()).slice(0, 500);
      const retryAfterSeconds = response.status === 429 ? Math.ceil(delayMs / 1000) : null;
      const retryHint = retryAfterSeconds !== null ? `；建议约 ${retryAfterSeconds} 秒后重试` : "";
      throw new WildberriesApiError(
        `Wildberries API ${response.status}: ${responseText || response.statusText}${retryHint}`,
        response.status,
        retryable,
        retryAfterSeconds,
      );
    }
    throw new WildberriesApiError("Wildberries API retry budget exhausted", 0, true);
  }

  private requestInit(): RequestInit {
    return {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.options.apiToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(20_000),
    };
  }

  private fetch(url: URL): Promise<Response> {
    return this.fetchImplementation(url, this.requestInit());
  }

  private directFetch(url: URL): Promise<Response> {
    return this.directFetchImplementation(url, this.requestInit());
  }
}
