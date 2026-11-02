import { defaultOpenCliPath, runOpenCli } from "./opencli-runtime";

export { defaultOpenCliPath } from "./opencli-runtime";

export interface OpenCliStorefrontPriceCollectorOptions {
  executable: string;
  sessionName: string;
}

/** Reads public buyer prices through the user's authenticated Chrome or Edge session. */
export class OpenCliStorefrontPriceCollector {
  private ready = false;

  public constructor(private readonly options: OpenCliStorefrontPriceCollectorOptions) {}

  /** Reuses one authenticated Ozon tab so a batch does not reload the full product page for every SKU. */
  public async collect(sku: string): Promise<unknown> {
    await this.ensureReady();
    const retryDelays = [2_500, 6_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.collectOnce(sku);
      } catch (error) {
        if (attempt >= retryDelays.length || !this.isRetryable(error)) throw error;
        await this.sleep(retryDelays[attempt]!);
      }
    }
  }

  public async close(): Promise<void> {
    this.ready = false;
    await this.run(["browser", this.options.sessionName, "close"]).catch(() => undefined);
  }

  /** Opens one lightweight Ozon page before the first same-origin Composer request. */
  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await this.run(["browser", this.options.sessionName, "open", "https://www.ozon.ru/"]);
    await this.run(["browser", this.options.sessionName, "wait", "time", "2"]);
    this.ready = true;
  }

  /** Fetches one SKU through the already authenticated browser session. */
  private async collectOnce(sku: string): Promise<unknown> {
    const script = `(async () => {
      const path = ${JSON.stringify(`/product/${sku}/`)};
      const url = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=" + encodeURIComponent(path);
      try {
        const response = await fetch(url, { credentials: "include", headers: { accept: "application/json, text/plain, */*" } });
        if (!response.ok) return { __httpStatus: response.status };
        return await response.json();
      } catch (error) { return { __fetchError: String(error) }; }
    })()`;
    const output = await this.run(["browser", this.options.sessionName, "eval", script]);
    return this.parseJson(output);
  }

  /** Retries only transient browser, network, rate-limit and server failures. */
  private isRetryable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /HTTP 429|HTTP 5\d\d|fetch failed|Failed to fetch|超时|timeout|未返回可解析/iu.test(message);
  }

  private parseJson(output: string): unknown {
    const indexes = [output.indexOf("{"), output.indexOf("[")].filter((index) => index >= 0);
    const start = indexes.length ? Math.min(...indexes) : -1;
    const end = Math.max(output.lastIndexOf("}"), output.lastIndexOf("]"));
    if (start < 0 || end < start) throw new Error("OpenCLI 未返回可解析的 Ozon 前台数据");
    const parsed = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.__httpStatus === "number") {
      throw new Error(parsed.__httpStatus === 429 ? "Ozon 前台限流（HTTP 429），请稍后重试" : `Ozon 前台请求失败（HTTP ${parsed.__httpStatus}）`);
    }
    if (typeof parsed.__fetchError === "string") throw new Error(parsed.__fetchError);
    return parsed;
  }

  protected sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  protected run(argumentsList: string[]): Promise<string> {
    return runOpenCli(this.options.executable || defaultOpenCliPath(), argumentsList);
  }
}
