import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { OrderNotificationEvent } from "../shared/contracts";
import { NotificationBatcher, type NotificationSummary } from "./desktop-notifications/notification-batcher";
import { NotificationImageCache } from "./desktop-notifications/notification-image-cache";
import { showWindowsToast } from "./desktop-notifications/windows-toast";

const ADMIN_BASE_URL = process.env.OZON_GMV_ADMIN_URL ?? "http://127.0.0.1:3001";
const STATE_DIR = process.env.NOTIFIER_DATA_DIR ?? join(homedir(), ".ozon-gmv-dashboard");
const PID_PATH = join(STATE_DIR, "notifier.pid");

function acquireProcessLock(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    const descriptor = openSync(PID_PATH, "wx");
    writeFileSync(descriptor, String(process.pid));
    closeSync(descriptor);
  } catch {
    const existingPid = Number(readFileSync(PID_PATH, "utf8"));
    try {
      process.kill(existingPid, 0);
      process.exit(0);
    } catch {
      unlinkSync(PID_PATH);
      acquireProcessLock();
    }
  }
}

function openDashboard(path: string): void {
  const url = new URL(path, ADMIN_BASE_URL).toString();
  if (process.platform === "win32") {
    spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

function formatAmount(amount: string, currency: string): string {
  return `${amount} ${currency}`;
}

function showMacNotification(title: string, message: string, path: string, imageUrl: string | null = null): void {
  const helper = process.env.MAC_NOTIFIER_BIN;
  if (!helper) {
    void reportStatus({ error: "macOS 通知助手尚未安装" });
    return;
  }
  const argumentsList = ["--title", title, "--message", message, "--open", new URL(path, ADMIN_BASE_URL).toString()];
  if (imageUrl) {
    argumentsList.push("--image", imageUrl);
  }
  const child = spawn(helper, argumentsList, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let delivered = false;
  let failureReported = false;
  let standardError = "";
  const reportFailure = (message: string): void => {
    if (failureReported || delivered) {
      return;
    }
    failureReported = true;
    void reportStatus({ error: message });
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (output: string) => {
    if (!delivered && output.split(/\r?\n/).includes("DELIVERED")) {
      delivered = true;
      void reportStatus({ deliveredAt: new Date().toISOString(), error: null });
    }
  });
  child.stderr.on("data", (output: string) => {
    standardError += output;
  });
  child.once("error", (error) => reportFailure(error.message));
  child.once("close", (code) => {
    if (!delivered) {
      const message = standardError.trim() || `macOS 通知助手退出（代码 ${code ?? "未知"}）`;
      reportFailure(message);
    }
  });
}

const notificationImages = process.platform === "win32" ? new NotificationImageCache() : null;

async function showOrder(event: OrderNotificationEvent): Promise<void> {
  const path = event.orderId ? `/dashboard?order=${encodeURIComponent(event.orderId)}` : "/dashboard";
  const title = event.kind === "test" ? "Ozon GMV 通知测试" : `新订单 · ${event.storeName}`;
  const message = `${formatAmount(event.amount.amount, event.amount.currency)}\n${event.productName} · ${event.itemCount} 件 · ${event.fulfillment}`;
  if (process.platform === "win32") {
    try {
      const imagePath = await notificationImages?.resolve(event.imageUrl) ?? null;
      await showWindowsToast({ title, message, imagePath, onActivate: () => openDashboard(path) });
      void reportStatus({ deliveredAt: new Date().toISOString(), error: null });
    } catch (error) {
      void reportStatus({ error: error instanceof Error ? error.message : "Windows 通知发送失败" });
    }
    return;
  }
  showMacNotification(title, message, path, event.imageUrl);
}

async function showSummary(summary: NotificationSummary): Promise<void> {
  const totals = summary.amounts.map((money) => formatAmount(money.amount, money.currency)).join(" · ");
  if (process.platform === "win32") {
    try {
      await showWindowsToast({
        title: `另外 ${summary.count} 笔新订单`,
        message: totals,
        onActivate: () => openDashboard("/dashboard"),
      });
      void reportStatus({ deliveredAt: new Date().toISOString(), error: null });
    } catch (error) {
      void reportStatus({ error: error instanceof Error ? error.message : "Windows 通知发送失败" });
    }
    return;
  }
  showMacNotification(`另外 ${summary.count} 笔新订单`, totals, "/dashboard");
}

async function reportStatus(status: { deliveredAt?: string; error?: string | null } = {}): Promise<void> {
  await fetch(`${ADMIN_BASE_URL}/api/internal/notifications/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(status),
  }).catch(() => undefined);
}

async function consumeStream(
  signal: AbortSignal,
  onEvent: (event: OrderNotificationEvent) => void,
  onEventId: (id: string) => void,
  lastEventId?: string,
): Promise<void> {
  const response = await fetch(`${ADMIN_BASE_URL}/api/internal/notifications/stream`, {
    ...(lastEventId ? { headers: { "Last-Event-ID": lastEventId } } : {}),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`通知事件流连接失败（${response.status}）`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const block = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const id = block.split("\n").find((line) => line.startsWith("id: "))?.slice(4);
      const data = block.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data) {
        const event = JSON.parse(data) as OrderNotificationEvent;
        onEvent(event);
        onEventId(id ?? event.id);
      }
      separator = buffer.indexOf("\n\n");
    }
  }
}

async function run(): Promise<void> {
  acquireProcessLock();
  await notificationImages?.cleanup();
  const controller = new AbortController();
  const batcher = new NotificationBatcher({ onOrder: showOrder, onSummary: showSummary });
  const heartbeat = setInterval(() => void reportStatus(), 30_000);
  const cleanup = (): void => {
    controller.abort();
    batcher.flush();
    clearInterval(heartbeat);
    try { unlinkSync(PID_PATH); } catch { /* The installer may already have removed the lock. */ }
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  let retryMs = 1_000;
  let lastEventId: string | undefined;
  const seenEventIds = new Set<string>();
  while (!controller.signal.aborted) {
    try {
      await reportStatus({ error: null });
      await consumeStream(controller.signal, (event) => {
        if (seenEventIds.has(event.id)) {
          return;
        }
        seenEventIds.add(event.id);
        if (seenEventIds.size > 500) {
          const oldestId = seenEventIds.values().next().value as string | undefined;
          if (oldestId) {
            seenEventIds.delete(oldestId);
          }
        }
        if (event.kind === "test") {
          showOrder(event);
        } else {
          batcher.add(event);
        }
      }, (eventId) => { lastEventId = eventId; }, lastEventId);
      retryMs = 1_000;
    } catch (error) {
      if (controller.signal.aborted) {
        break;
      }
      await reportStatus({ error: error instanceof Error ? error.message : "通知助手连接失败" });
      await new Promise((resolve) => setTimeout(resolve, retryMs + Math.floor(Math.random() * 500)));
      retryMs = Math.min(30_000, retryMs * 2);
    }
  }
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
