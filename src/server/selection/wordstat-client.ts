import { setTimeout as wait } from "node:timers/promises";

import { z } from "zod";

const WORDSTAT_BASE_URL = "https://searchapi.api.cloud.yandex.net";

const phraseCountSchema = z.object({
  phrase: z.string(),
  count: z.coerce.number().int().nonnegative(),
});

const topResponseSchema = z.object({
  totalCount: z.coerce.number().int().nonnegative(),
  results: z.array(phraseCountSchema).default([]),
  associations: z.array(phraseCountSchema).default([]),
});

const dynamicsResponseSchema = z.object({
  results: z.array(z.object({
    date: z.string().datetime(),
    count: z.coerce.number().int().nonnegative(),
    share: z.number().nonnegative(),
  })).default([]),
});

export interface WordstatPhraseCount {
  phrase: string;
  count: number;
}

export interface WordstatDynamicsPoint {
  date: string;
  count: number;
  share: number;
}

export interface WordstatProfile {
  totalCount30d: number;
  topRequests: WordstatPhraseCount[];
  associations: WordstatPhraseCount[];
  dynamics: WordstatDynamicsPoint[];
}

interface WordstatClientOptions {
  folderId: string;
  apiKey: string;
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  maxAttempts?: number;
}

export class WordstatApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WordstatApiError";
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.min(Math.max(seconds * 1000, 0), 30_000);
    }
  }
  return Math.min(500 * 2 ** attempt, 10_000);
}

function completeMonthWindow(now: Date): { fromDate: Date; toDate: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    fromDate: new Date(Date.UTC(year, month - 24, 1)),
    toDate: new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)),
  };
}

/** Adapts the current Yandex Cloud Wordstat v2 REST interface to one keyword profile. */
export class WordstatClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => Date;
  private readonly maxAttempts: number;

  public constructor(private readonly options: WordstatClientOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  /** Returns recent related requests and 24 complete calendar months for one phrase. */
  public async fetchProfile(phrase: string): Promise<WordstatProfile> {
    const { fromDate, toDate } = completeMonthWindow(this.now());
    const common = {
      phrase,
      regions: ["225"],
      devices: ["DEVICE_ALL"],
      folderId: this.options.folderId,
    };
    const [top, dynamics] = await Promise.all([
      this.request("/v2/wordstat/topRequests", { ...common, numPhrases: 100 }, topResponseSchema),
      this.request("/v2/wordstat/dynamics", {
        ...common,
        period: "PERIOD_MONTHLY",
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
      }, dynamicsResponseSchema),
    ]);
    return {
      totalCount30d: top.totalCount,
      topRequests: top.results,
      associations: top.associations,
      dynamics: dynamics.results,
    };
  }

  /** Uses the free region-tree call to verify credentials and folder access. */
  public async testConnection(): Promise<void> {
    await this.request("/v2/wordstat/getRegionsTree", { folderId: this.options.folderId }, z.object({
      regions: z.array(z.object({ id: z.coerce.string(), name: z.string() })).default([]),
    }));
  }

  private async request<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(new URL(path, WORDSTAT_BASE_URL), {
          method: "POST",
          headers: {
            Authorization: `Api-key ${this.options.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        if (attempt + 1 >= this.maxAttempts) {
          throw new WordstatApiError(error instanceof Error ? error.message : "Wordstat 网络请求失败", 0, true);
        }
        await wait(Math.min(500 * 2 ** attempt, 10_000));
        continue;
      }
      if (response.ok) {
        return schema.parse(await response.json());
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt + 1 < this.maxAttempts) {
        await wait(retryDelay(response, attempt));
        continue;
      }
      const responseText = (await response.text()).slice(0, 500);
      throw new WordstatApiError(
        `Wordstat API ${response.status}: ${responseText || response.statusText}`,
        response.status,
        retryable,
      );
    }
    throw new WordstatApiError("Wordstat API 重试次数已用尽", 0, true);
  }
}
