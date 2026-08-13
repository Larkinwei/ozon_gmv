import Decimal from "decimal.js";

import type { Money, OrderNotificationEvent } from "../../shared/contracts";

export interface NotificationSummary {
  count: number;
  amounts: Money[];
}

interface NotificationBatcherOptions {
  onOrder: (event: OrderNotificationEvent) => void;
  onSummary: (summary: NotificationSummary) => void;
  windowMs?: number;
  immediateLimit?: number;
}

/** Caps desktop popups while preserving the first few orders in a busy period. */
export class NotificationBatcher {
  private readonly windowMs: number;
  private readonly immediateLimit: number;
  private windowStartedAt = 0;
  private immediateCount = 0;
  private buffered: OrderNotificationEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  public constructor(private readonly options: NotificationBatcherOptions) {
    this.windowMs = options.windowMs ?? 10_000;
    this.immediateLimit = options.immediateLimit ?? 3;
  }

  public add(event: OrderNotificationEvent, now = Date.now()): void {
    if (this.windowStartedAt === 0 || now - this.windowStartedAt >= this.windowMs) {
      this.flush();
      this.windowStartedAt = now;
      this.immediateCount = 0;
    }
    if (this.immediateCount < this.immediateLimit) {
      this.immediateCount += 1;
      this.options.onOrder(event);
      return;
    }
    this.buffered.push(event);
    if (!this.flushTimer) {
      const remaining = Math.max(1, this.windowMs - (now - this.windowStartedAt));
      this.flushTimer = setTimeout(() => this.flush(), remaining);
      this.flushTimer.unref();
    }
  }

  public flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffered.length > 0) {
      this.options.onSummary({
        count: this.buffered.length,
        amounts: summarizeAmounts(this.buffered),
      });
      this.buffered = [];
    }
    this.windowStartedAt = 0;
    this.immediateCount = 0;
  }
}

function summarizeAmounts(events: OrderNotificationEvent[]): Money[] {
  const totals = new Map<string, Decimal>();
  for (const event of events) {
    totals.set(event.amount.currency, (totals.get(event.amount.currency) ?? new Decimal(0)).plus(event.amount.amount));
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) }));
}
