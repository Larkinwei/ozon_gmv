import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import type {
  DashboardEvent,
  FulfillmentMode,
  Money,
  OrderNotificationEvent,
  OrderNotificationSettings,
} from "../../shared/contracts";
import type { SettingsRepository } from "../db/settings-repository";
import type { DashboardEventBus } from "../realtime/event-bus";

const ENABLED_KEY = "notifications.orders_enabled";
const LAST_DELIVERED_KEY = "notifications.last_delivered_at";
const LAST_ERROR_KEY = "notifications.last_error";
const EVENT_NAME = "notification";
const FRESH_ORDER_WINDOW_MS = 5 * 60 * 1000;
const AGENT_CONNECTED_WINDOW_MS = 90 * 1000;

interface PostingCreatedData {
  id: string;
  storeName: string;
  storeColor: string;
  amount: Money;
  orderAt: string;
  fulfillment: FulfillmentMode;
  productNames: string[];
  itemCount: number;
}

/** Projects fresh dashboard order events into the private desktop-notification stream. */
export class OrderNotificationService {
  private readonly emitter = new EventEmitter();
  private readonly history: OrderNotificationEvent[] = [];
  private readonly unsubscribeDashboard: () => void;
  private lastAgentHeartbeatMs = 0;

  public constructor(
    private readonly settings: SettingsRepository,
    events: DashboardEventBus,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.unsubscribeDashboard = events.subscribe((event) => this.handleDashboardEvent(event));
  }

  public view(): OrderNotificationSettings {
    return {
      supported: this.platform === "win32" || this.platform === "darwin",
      enabled: this.isEnabled(),
      agentConnected: Date.now() - this.lastAgentHeartbeatMs < AGENT_CONNECTED_WINDOW_MS,
      lastDeliveredAt: this.settings.get(LAST_DELIVERED_KEY),
      lastError: this.settings.get(LAST_ERROR_KEY),
    };
  }

  public update(enabled: boolean): OrderNotificationSettings {
    this.settings.set(ENABLED_KEY, String(enabled));
    return this.view();
  }

  public publishTest(): OrderNotificationEvent {
    const event: OrderNotificationEvent = {
      id: `${Date.now()}-${randomUUID()}`,
      kind: "test",
      occurredAt: new Date().toISOString(),
      orderId: null,
      storeName: "通知测试",
      storeColor: "#3B82F6",
      amount: { amount: "99.00", currency: "RUB" },
      orderAt: new Date().toISOString(),
      fulfillment: "FBS",
      productName: "系统通知连接正常",
      itemCount: 1,
    };
    this.emit(event);
    return event;
  }

  public reportAgent(input: { deliveredAt?: string | undefined; error?: string | null | undefined }): OrderNotificationSettings {
    this.lastAgentHeartbeatMs = Date.now();
    if (input.deliveredAt) {
      this.settings.set(LAST_DELIVERED_KEY, input.deliveredAt);
    }
    if (input.error) {
      this.settings.set(LAST_ERROR_KEY, input.error);
    } else if (input.error === null) {
      this.settings.delete(LAST_ERROR_KEY);
    }
    return this.view();
  }

  public subscribe(listener: (event: OrderNotificationEvent) => void): () => void {
    this.emitter.on(EVENT_NAME, listener);
    return () => this.emitter.off(EVENT_NAME, listener);
  }

  public eventsAfter(id?: string): OrderNotificationEvent[] {
    if (!id) {
      return [];
    }
    const index = this.history.findIndex((event) => event.id === id);
    return index >= 0
      ? this.history.slice(index + 1).filter((event) => Date.now() - Date.parse(event.occurredAt) <= FRESH_ORDER_WINDOW_MS)
      : [];
  }

  public close(): void {
    this.unsubscribeDashboard();
    this.emitter.removeAllListeners();
  }

  private isEnabled(): boolean {
    return this.settings.get(ENABLED_KEY) !== "false";
  }

  private handleDashboardEvent(event: DashboardEvent): void {
    if (event.type !== "posting.created" || !this.isEnabled()) {
      return;
    }
    const data = event.data as PostingCreatedData;
    const orderAtMs = Date.parse(data.orderAt);
    if (!Number.isFinite(orderAtMs) || Date.now() - orderAtMs > FRESH_ORDER_WINDOW_MS || orderAtMs - Date.now() > FRESH_ORDER_WINDOW_MS) {
      return;
    }
    this.emit({
      id: event.id,
      kind: "order",
      occurredAt: event.occurredAt,
      orderId: data.id,
      storeName: data.storeName,
      storeColor: data.storeColor,
      amount: data.amount,
      orderAt: data.orderAt,
      fulfillment: data.fulfillment,
      productName: data.productNames[0] ?? "商品信息待更新",
      itemCount: data.itemCount,
    });
  }

  private emit(event: OrderNotificationEvent): void {
    this.history.push(event);
    if (this.history.length > 100) {
      this.history.splice(0, this.history.length - 100);
    }
    this.emitter.emit(EVENT_NAME, event);
  }
}
