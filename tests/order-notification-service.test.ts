import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrderNotificationEvent } from "../src/shared/contracts";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { NotificationBatcher } from "../src/server/desktop-notifications/notification-batcher";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { OrderNotificationService } from "../src/server/services/order-notification-service";
import { createTestDatabase } from "./test-context";

function orderEvent(id: string, amount: string, currency = "RUB"): OrderNotificationEvent {
  return {
    id,
    kind: "order",
    occurredAt: new Date().toISOString(),
    orderId: crypto.randomUUID(),
    storeName: "测试店铺",
    storeColor: "#3B82F6",
    amount: { amount, currency },
    orderAt: new Date().toISOString(),
    fulfillment: "FBS",
    productName: "测试商品",
    imageUrl: null,
    itemCount: 1,
  };
}

afterEach(() => vi.useRealTimers());

describe("order notification service", () => {
  it("defaults to enabled and emits only fresh created orders", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T03:00:00.000Z"));
    const context = createTestDatabase();
    const events = new DashboardEventBus();
    const images = new ProductImagesRepository(context.database);
    vi.spyOn(images, "findImageUrl").mockReturnValue("https://cdn.example.com/product.jpg");
    const service = new OrderNotificationService(new SettingsRepository(context.database), events, "darwin", images);
    const received: OrderNotificationEvent[] = [];
    service.subscribe((event) => received.push(event));

    expect(service.view()).toMatchObject({ supported: true, enabled: true, agentConnected: false });
    events.publish("posting.created", {
      id: crypto.randomUUID(), storeId: "store-a", storeName: "店铺 A", storeColor: "#F43F5E",
      amount: { amount: "100.00", currency: "RUB" }, orderAt: "2026-08-13T02:59:00.000Z",
      fulfillment: "FBS", productNames: ["商品 A"], productSkus: ["sku-a"], itemCount: 2,
    });
    events.publish("posting.updated", {
      id: crypto.randomUUID(), storeId: "store-a", storeName: "店铺 A", storeColor: "#F43F5E",
      amount: { amount: "100.00", currency: "RUB" }, orderAt: "2026-08-13T02:59:00.000Z",
      fulfillment: "FBS", productNames: ["商品 A"], productSkus: ["sku-a"], itemCount: 2,
    });
    events.publish("posting.created", {
      id: crypto.randomUUID(), storeId: "store-a", storeName: "店铺 A", storeColor: "#F43F5E",
      amount: { amount: "50.00", currency: "RUB" }, orderAt: "2026-08-13T02:00:00.000Z",
      fulfillment: "FBO", productNames: ["历史商品"], productSkus: ["sku-old"], itemCount: 1,
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      storeName: "店铺 A",
      productName: "商品 A",
      imageUrl: "https://cdn.example.com/product.jpg",
      itemCount: 2,
    });
    service.update(false);
    events.publish("posting.created", {
      id: crypto.randomUUID(), storeId: "store-b", storeName: "店铺 B", storeColor: "#22C55E",
      amount: { amount: "20.00", currency: "RUB" }, orderAt: new Date().toISOString(),
      fulfillment: "RFBS", productNames: ["商品 B"], productSkus: ["sku-b"], itemCount: 1,
    });
    expect(received).toHaveLength(1);

    service.close();
    context.cleanup();
  });

  it("tracks agent heartbeat and delivery diagnostics", () => {
    const context = createTestDatabase();
    const service = new OrderNotificationService(
      new SettingsRepository(context.database),
      new DashboardEventBus(),
      "win32",
    );
    const deliveredAt = new Date().toISOString();
    expect(service.reportAgent({ deliveredAt, error: null })).toMatchObject({
      agentConnected: true,
      lastDeliveredAt: deliveredAt,
      lastError: null,
    });
    expect(service.reportAgent({ error: "系统通知被拒绝" }).lastError).toBe("系统通知被拒绝");
    service.close();
    context.cleanup();
  });
});

describe("notification batcher", () => {
  it("shows three orders immediately and merges the remainder by currency", () => {
    vi.useFakeTimers();
    const individual: string[] = [];
    const summaries: Array<{ count: number; amounts: Array<{ amount: string; currency: string }> }> = [];
    const batcher = new NotificationBatcher({
      onOrder: (event) => individual.push(event.id),
      onSummary: (summary) => summaries.push(summary),
    });
    batcher.add(orderEvent("1", "10.00"), 1_000);
    batcher.add(orderEvent("2", "20.00"), 1_100);
    batcher.add(orderEvent("3", "30.00"), 1_200);
    batcher.add(orderEvent("4", "40.00"), 1_300);
    batcher.add(orderEvent("5", "12.50", "CNY"), 1_400);
    batcher.add(orderEvent("6", "5.00"), 1_500);
    batcher.flush();

    expect(individual).toEqual(["1", "2", "3"]);
    expect(summaries).toEqual([{ count: 3, amounts: [
      { amount: "12.50", currency: "CNY" },
      { amount: "45.00", currency: "RUB" },
    ] }]);
  });
});
