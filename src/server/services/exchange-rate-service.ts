import type { ExchangeRateSnapshot } from "../../shared/contracts";
import { SettingsRepository } from "../db/settings-repository";

const SETTING_KEY = "tools.exchange_rate.cny_rub";
const DAILY_URL = "https://www.cbr.ru/scripts/XML_daily.asp";
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

interface StoredExchangeRate extends ExchangeRateSnapshot {}

function emptySnapshot(error: string | null = null): ExchangeRateSnapshot {
  return { available: false, rate: null, fromCurrency: "CNY", toCurrency: "RUB", source: DAILY_URL, effectiveDate: null, checkedAt: null, fetchedAt: null, error };
}

function readTag(xml: string, tag: string): string | null {
  return xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`))?.[1]?.trim() ?? null;
}

/** Parses the CBR daily XML into a CNY-to-RUB quote. */
export function parseCbrCnyRate(xml: string, checkedAt: string): ExchangeRateSnapshot {
  const codeIndex = xml.indexOf("<NumCode>156</NumCode>");
  const startIndex = codeIndex >= 0 ? xml.lastIndexOf("<Valute", codeIndex) : -1;
  const endIndex = startIndex >= 0 ? xml.indexOf("</Valute>", codeIndex) : -1;
  const block = startIndex >= 0 && endIndex >= 0 ? xml.slice(startIndex, endIndex + "</Valute>".length) : null;
  const value = block ? readTag(block, "Value")?.replace(",", ".") : null;
  const nominal = block ? readTag(block, "Nominal") : null;
  const rawDate = xml.match(/<ValCurs[^>]*Date="([^"]+)"/)?.[1] ?? null;
  if (!value || !nominal || !Number.isFinite(Number(value)) || Number(nominal) <= 0) {
    throw new Error("俄罗斯央行未返回人民币汇率");
  }
  return {
    available: true,
    rate: (Number(value) / Number(nominal)).toFixed(8).replace(/0+$/, "").replace(/\.$/, ""),
    fromCurrency: "CNY",
    toCurrency: "RUB",
    source: DAILY_URL,
    effectiveDate: rawDate ? rawDate.split(".").reverse().join("-") : checkedAt.slice(0, 10),
    checkedAt,
    fetchedAt: checkedAt,
    error: null,
  };
}

/** Persists one machine-local exchange-rate snapshot and refreshes it on a daily timer. */
export class ExchangeRateService {
  private timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly settings: SettingsRepository,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public view(): ExchangeRateSnapshot {
    const raw = this.settings.get(SETTING_KEY);
    if (!raw) return emptySnapshot();
    try {
      return JSON.parse(raw) as StoredExchangeRate;
    } catch {
      return emptySnapshot("本地汇率缓存损坏，请重新获取");
    }
  }

  public async refresh(): Promise<ExchangeRateSnapshot> {
    const checkedAt = this.now().toISOString();
    try {
      const response = await this.fetchImplementation(DAILY_URL, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`汇率服务返回 HTTP ${response.status}`);
      const snapshot = parseCbrCnyRate(await response.text(), checkedAt);
      this.settings.set(SETTING_KEY, JSON.stringify(snapshot));
      return snapshot;
    } catch (error) {
      const previous = this.view();
      const snapshot = { ...previous, checkedAt, error: error instanceof Error ? error.message : "汇率更新失败" };
      this.settings.set(SETTING_KEY, JSON.stringify(snapshot));
      return snapshot;
    }
  }

  public async refreshIfStale(): Promise<ExchangeRateSnapshot> {
    const current = this.view();
    const checkedAt = current.checkedAt ? Date.parse(current.checkedAt) : 0;
    return current.available && checkedAt > 0 && this.now().getTime() - checkedAt < STALE_AFTER_MS ? current : this.refresh();
  }

  /** Starts the daily refresh loop; the first check also runs at service startup. */
  public start(): () => void {
    void this.refreshIfStale();
    const schedule = (): void => {
      this.timer = setTimeout(async () => {
        await this.refresh();
        schedule();
      }, this.nextRefreshDelay());
      this.timer.unref?.();
    };
    schedule();
    return () => this.stop();
  }

  public stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private nextRefreshDelay(): number {
    const next = new Date(this.now());
    next.setHours(8, 0, 0, 0);
    if (next.getTime() <= this.now().getTime()) next.setDate(next.getDate() + 1);
    return Math.max(60_000, next.getTime() - this.now().getTime());
  }
}
