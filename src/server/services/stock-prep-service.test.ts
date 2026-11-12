import { readFileSync } from "node:fs";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config";
import { SettingsRepository } from "../db/settings-repository";
import { StockPrepService } from "./stock-prep-service";

const storeId = "5bb97f32-b358-4303-8163-d500a4bcdd54";
const offerUrl = "https://detail.1688.com/offer/747713283348.html";
const skuId = "6103279203988";
const databases: BetterSqlite3.Database[] = [];

function fixture(mappingRows = [["1645-2-XXL", `[${offerUrl}](${offerUrl})`, skuId]] as unknown[][], behavior: "success" | "pre-click-failure" | "dropship-button-missing" | "uncertain" | "wrong-cart" = "success") {
  const database = new BetterSqlite3(":memory:");
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE stores (id TEXT PRIMARY KEY,name TEXT,platform TEXT,enabled INTEGER);
    CREATE TABLE postings (id TEXT PRIMARY KEY,store_id TEXT,posting_number TEXT,fulfillment_mode TEXT,status TEXT,cancelled_at_ms INTEGER);
    CREATE TABLE posting_items (posting_id TEXT,offer_id TEXT,name TEXT,quantity INTEGER);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT,updated_at_ms INTEGER NOT NULL);
  `);
  database.exec(readFileSync(join(process.cwd(), "migrations/032_stock_prep.sql"), "utf8"));
  database.prepare("INSERT INTO stores VALUES (?,?,?,?)").run(storeId, "YOGOLD", "ozon", 1);
  database.prepare("INSERT INTO store_sku_sources VALUES (?,?,?,?,?)").run(storeId, "https://feishu/base", "base-token", "tbl-stock", Date.now());
  const addPosting = database.prepare("INSERT INTO postings VALUES (?,?,?,?,?,?)");
  const addItem = database.prepare("INSERT INTO posting_items VALUES (?,?,?,?)");
  for (const [id, postingNumber, mode, status, cancelled, offerId, quantity] of [
    ["p1", "post-1", "FBS", "awaiting_packaging", null, "1645-2-XXL", 1],
    ["p2", "post-2", "RFBS", "awaiting_packaging", null, "1645-2-XXL", 2],
    ["p3", "post-3", "FBO", "awaiting_packaging", null, "1645-2-XXL", 4],
    ["p4", "post-4", "FBS", "awaiting_deliver", null, "1645-2-XXL", 5],
    ["p5", "post-5", "FBS", "awaiting_packaging", Date.now(), "1645-2-XXL", 6],
    ["p6", "post-6", "FBS", "awaiting_packaging", null, "UNMAPPED", 1],
    ["p7", "post-7", "FBS", "awaiting_packaging", null, "DUPLICATE", 1],
    ["p8", "post-8", "FBS", "awaiting_packaging", null, "BAD-SKU", 1],
  ] as Array<[string, string, string, string, number | null, string, number]>) {
    addPosting.run(id, storeId, postingNumber, mode, status, cancelled);
    addItem.run(id, offerId, "Test product", quantity);
  }
  const appConfig = { ENCRYPTION_KEY: "a".repeat(64) } as AppConfig;
  const cartQuantities = { wholesale: 2, dropship: 0 };
  let currentCart: "wholesale" | "dropship" = "wholesale";
  let cartOpenCount = 0;
  let addClickCount = 0;
  let pendingQuantity = 0;
  const selectedModes: string[] = [];
  const addActions: string[] = [];
  let dropshipDialog = false;
  const service = new StockPrepService(database, new SettingsRepository(database as never), appConfig, {
    platform: "darwin",
    sleep: async () => undefined,
    feishu: async () => JSON.stringify({ ok: true, identity: "user", data: { data: mappingRows, fields: ["货号", "1688商品链接", "1688 SKU ID"] } }),
    browserHealth: async () => ({ ready: true, message: "connected" }),
    openCli: async (_session, args) => {
      const [action, value] = args;
      const script = value;
      if (action === "eval" && script) expect(() => new Function(`return ${script};`)).not.toThrow();
      if (action === "open") {
        if (value === "https://cart.1688.com/cart.htm") { cartOpenCount += 1; currentCart = "wholesale"; }
        if (value === "https://cart.1688.com/daixiao_cart.htm") currentCart = "dropship";
        return JSON.stringify({ url: value });
      }
      if (action === "eval" && script?.includes("const targets=")) {
        const serialized = script.match(/const targets=(\[.*?\]);\s*const normalize/su)?.[1];
        const targets = serialized ? JSON.parse(serialized) as Array<{ key: string }> : [];
        return JSON.stringify({ loaded: true, quantities: Object.fromEntries(targets.map((target) => [target.key, cartQuantities[currentCart]])) });
      }
      if (action === "eval" && script?.includes("desiredSkuId")) {
        expect(script).toContain("specAttrs");
        return JSON.stringify({ url: `https://detail.1688.com/offer/747713283348.html`, skuId, attributes: ["蓝底叶子", "XXL"], supplierName: "安丘市鑫达尔服装厂" });
      }
      if (action === "eval" && script?.includes("const expected=") && script.includes("masthead--active")) {
        selectedModes.push(script.match(/const expected="([^"]+)"/u)?.[1] ?? "unknown");
        return JSON.stringify({ selected: true });
      }
      if (action === "eval" && script?.includes("button[data-click=\"DX_ORDER\"]")) {
        dropshipDialog = true;
        return JSON.stringify({ clicked: true, count: 1 });
      }
      if (action === "frames") {
        return JSON.stringify(dropshipDialog ? [{ index: 6, name: "fullscreen-drawer-iframe", url: "https://air.1688.com/app/upkg-solution/od-panel/sku-panel.html?actionType=dxOrder" }] : []);
      }
      if (action === "eval" && args.includes("--frame") && script?.includes("found:false,active:false")) {
        return JSON.stringify({ found: true, active: true });
      }
      if (action === "eval" && args.includes("--frame") && script?.includes("HTMLInputElement.prototype")) {
        pendingQuantity = Number(script.match(/const quantity=(\d+)/u)?.[1] ?? 0);
        return JSON.stringify({ color: "蓝底叶子", size: "XXL", filled: behavior !== "pre-click-failure", actual: behavior === "pre-click-failure" ? "0" : String(pendingQuantity) });
      }
      if (action === "eval" && args.includes("--frame") && script?.includes("buttonCount:buttons.length")) {
        return JSON.stringify({ buttonCount: behavior === "dropship-button-missing" ? 0 : 1, colorActive: true, sizeFound: true, actual: String(pendingQuantity) });
      }
      if (action === "eval" && args.includes("--frame") && script?.includes("buttons[0].click()")) {
        addClickCount += 1;
        addActions.push("弹层加采购车");
        if (behavior === "success") cartQuantities.dropship += pendingQuantity;
        if (behavior === "wrong-cart") cartQuantities.wholesale += pendingQuantity;
        return JSON.stringify({ clicked: true, count: 1 });
      }
      if (action === "eval" && script?.includes("const target=") && script?.includes("sku-filter-button")) return JSON.stringify({ found: true });
      if (action === "eval" && script?.includes("expectedColor")) return JSON.stringify({ url: "https://detail.1688.com/offer/747713283348.html", color: "蓝底叶子", size: "XXL", skuId, inputIndex: 3 });
      if (action === "fill") {
        pendingQuantity = Number(args.at(-1));
        return JSON.stringify({ filled: true, verified: behavior !== "pre-click-failure", actual: behavior === "pre-click-failure" ? "0" : String(pendingQuantity) });
      }
      if (action === "click" && pendingQuantity > 0 && (args.includes("加采购车") || args.includes("button"))) {
        addClickCount += 1;
        const actionName = args.includes("--nth") ? "弹层加采购车" : "加采购车";
        addActions.push(actionName);
        if (behavior === "success") cartQuantities[dropshipDialog ? "dropship" : "wholesale"] += pendingQuantity;
        if (behavior === "wrong-cart") cartQuantities.wholesale += pendingQuantity;
        return JSON.stringify({ clicked: true });
      }
      if (action === "close") return "";
      throw new Error(`unexpected OpenCLI invocation: ${args.join(" ").slice(0, 120)}`);
    },
  });
  return { database, service, metrics: { cartOpenCount: () => cartOpenCount, addClickCount: () => addClickCount, selectedModes, addActions, cartQuantities } };
}

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

async function waitForBatch(service: StockPrepService, id: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const batch = service.getBatch(id)!;
    if (["completed", "completed_with_errors"].includes(String(batch.status))) return batch;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("batch did not finish");
}

describe("StockPrepService", () => {
  it("keeps the Ozon order snapshot fresh for one hour per store", () => {
    const { service } = fixture();
    const refreshedAt = 1_800_000_000_000;
    expect(service.hasFreshOrderSyncCache(storeId, refreshedAt)).toBe(false);
    service.markOrderSyncCacheFresh(storeId, refreshedAt);
    expect(service.hasFreshOrderSyncCache(storeId, refreshedAt + 3_599_999)).toBe(true);
    expect(service.hasFreshOrderSyncCache(storeId, refreshedAt + 3_600_000)).toBe(false);
    expect(service.hasFreshOrderSyncCache("another-store", refreshedAt + 1000)).toBe(false);
  });

  it("filters orders and marks missing, duplicated or invalid mappings unmatched", async () => {
    const { service } = fixture([
      ["1645-2-XXL", `[${offerUrl}](${offerUrl})`, skuId],
      ["DUPLICATE", "https://detail.1688.com/offer/747713283348.html", skuId],
      ["DUPLICATE", "invalid", skuId],
      ["BAD-SKU", offerUrl, "not-an-id"],
    ]);
    const result = await service.scan(storeId);
    const mapped = result.groups.find((group) => group.offerId === "1645-2-XXL")!;
    expect(mapped.orders.map((order) => order.postingNumber)).toEqual(["post-1", "post-2"]);
    expect(mapped.quantity).toBe(3);
    expect(mapped.orders.every((order) => order.state === "pending" && order.selectedByDefault)).toBe(true);
    expect(result.groups.find((group) => group.offerId === "DUPLICATE")?.status).toBe("unmatched");
    expect(result.groups.find((group) => group.offerId === "BAD-SKU")?.status).toBe("unmatched");
    expect(result.groups.find((group) => group.offerId === "UNMAPPED")?.orders[0]?.error).toBe("飞书未找到该货号");
    expect(result.groups.find((group) => group.offerId === "DUPLICATE")?.orders[0]?.error).toBe("飞书货号重复");
    expect(result.groups.find((group) => group.offerId === "BAD-SKU")?.orders[0]?.error).toBe("1688 SKU ID 无效");
    expect(result.groups.some((group) => group.offerId === "UNMAPPED")).toBe(true);
    expect(result.groups.some((group) => group.orders.some((order) => order.postingNumber === "post-3" || order.postingNumber === "post-4" || order.postingNumber === "post-5"))).toBe(false);
  });

  it("reconciles stale unmatched states with the current unique Feishu mapping", async () => {
    const { database, service } = fixture();
    database.prepare("INSERT INTO stock_prep_order_states (store_id,posting_number,offer_id,state,error,updated_at_ms) VALUES (?,?,?,?,?,?)")
      .run(storeId, "post-1", "1645-2-XXL", "unmatched", "飞书映射缺失、重复或无效", Date.now());
    const result = await service.scan(storeId);
    const mapped = result.groups.find((group) => group.offerId === "1645-2-XXL")!;
    expect(mapped.orders.map((order) => order.state)).toEqual(["pending", "pending"]);
    expect(mapped.orders.every((order) => order.error === null)).toBe(true);
  });

  it("adds the selected quantities once, verifies the cart delta, and supports manual state rollback", async () => {
    const { database, service, metrics } = fixture();
    const scan = await service.scan(storeId);
    const orders = scan.groups.find((group) => group.offerId === "1645-2-XXL")!.orders;
    const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));
    const result = await waitForBatch(service, batch.id);
    expect(result.status).toBe("completed");
    expect((result.items as Array<{ quantity: number; cart_before: number; cart_after: number }>)[0]).toMatchObject({ quantity: 3, cart_before: 2, cart_after: 5 });
    expect(metrics.cartOpenCount()).toBe(4);
    expect(metrics.addClickCount()).toBe(1);
    expect(metrics.addActions).toEqual(["加采购车"]);
    expect(metrics.selectedModes).toContain("批发");
    expect(database.prepare("SELECT COUNT(*) AS count FROM stock_prep_order_states WHERE state='added'").get()).toMatchObject({ count: 2 });
    expect(service.resetOrders(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))).toBe(2);
    expect(database.prepare("SELECT COUNT(*) AS count FROM stock_prep_order_states WHERE state='pending'").get()).toMatchObject({ count: 2 });
  });

  it("adds allowlisted supplier SKUs through the spec dialog and verifies both carts", async () => {
    const { database, service, metrics } = fixture();
    expect(service.saveDropshipSupplierNames(["安丘市鑫达尔服装厂"])).toEqual(["安丘市鑫达尔服装厂"]);
    expect(service.getDropshipSuppliers()).toEqual(["安丘市鑫达尔服装厂"]);
    const invalid = service.saveDropshipSupplierNames(["安丘市鑫达尔服装厂"]);
    expect(invalid).toHaveLength(1);
    expect(database.prepare("SELECT value FROM app_settings WHERE key='stock-prep.dropship-suppliers'").get()).toMatchObject({ value: JSON.stringify(invalid) });
    const scan = await service.scan(storeId);
    const orders = scan.groups.find((group) => group.offerId === "1645-2-XXL")!.orders;
    const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));
    const result = await waitForBatch(service, batch.id);
    expect(result.status).toBe("completed");
    expect(metrics.selectedModes).toContain("代发");
    expect(metrics.addActions).toEqual(["弹层加采购车"]);
    expect(metrics.addClickCount()).toBe(1);
    expect(metrics.cartQuantities).toEqual({ wholesale: 2, dropship: 3 });
    expect(result.items).toEqual([expect.objectContaining({ status: "added", quantity: 3, cart_before: 0, cart_after: 3 })]);
  });

  it("marks the batch uncertain if a dropship add increases the wholesale cart", async () => {
    const { database, service, metrics } = fixture(undefined, "wrong-cart");
    service.saveDropshipSupplierNames(["安丘市鑫达尔服装厂"]);
    const scan = await service.scan(storeId);
    const orders = scan.groups.find((group) => group.offerId === "1645-2-XXL")!.orders;
    const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));
    const result = await waitForBatch(service, batch.id);
    expect(result.status).toBe("completed_with_errors");
    expect(metrics.cartQuantities).toEqual({ wholesale: 5, dropship: 0 });
    expect((result.items as Array<{ status: string; error: string }>)[0]).toMatchObject({
      status: "uncertain",
      error: expect.stringContaining("另一购物车从 2 变为 5"),
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM stock_prep_order_states WHERE state='uncertain'").get()).toMatchObject({ count: 2 });
  });

  it("fails a dropship item before clicking when the iframe cart button is not unique", async () => {
    const { service, metrics } = fixture(undefined, "dropship-button-missing");
    service.saveDropshipSupplierNames(["安丘市鑫达尔服装厂"]);
    const scan = await service.scan(storeId);
    const orders = scan.groups.find((group) => group.offerId === "1645-2-XXL")!.orders;
    const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));
    const result = await waitForBatch(service, batch.id);
    expect(result.status).toBe("completed_with_errors");
    expect(metrics.addClickCount()).toBe(0);
    expect(result.items).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("提交前校验失败") })]);
  });

  it("marks failures before clicking as failed and uncertain cart outcomes as non-retryable", async () => {
    for (const behavior of ["pre-click-failure", "uncertain"] as const) {
      const { database, service } = fixture(undefined, behavior);
      const scan = await service.scan(storeId);
      const orders = scan.groups.find((group) => group.offerId === "1645-2-XXL")!.orders;
      const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));
      const result = await waitForBatch(service, batch.id);
      const expected = behavior === "pre-click-failure" ? "failed" : "uncertain";
      expect((result.items as Array<{ status: string }>)[0]?.status).toBe(expected);
      expect(service.resetOrders(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))).toBe(behavior === "pre-click-failure" ? 2 : 0);
      if (behavior === "uncertain") {
        expect(service.resolveUncertainAsFailed(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))).toBe(2);
        expect(database.prepare("SELECT COUNT(*) AS count FROM stock_prep_order_states WHERE state='failed'").get()).toMatchObject({ count: 2 });
      }
    }
  });

  it("consolidates multiple Ozon SKUs mapped to the same 1688 SKU and verifies one cart delta", async () => {
    const { service, metrics } = fixture([
      ["1645-2-XXL", `[${offerUrl}](${offerUrl})`, skuId],
      ["UNMAPPED", `[${offerUrl}](${offerUrl})`, skuId],
    ]);
    const scan = await service.scan(storeId);
    const orders = scan.groups.flatMap((group) => group.orders).filter((order) => order.state === "pending");
    const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));
    const result = await waitForBatch(service, batch.id);
    expect(result.status).toBe("completed");
    expect(result.items).toEqual([expect.objectContaining({ status: "added", quantity: 4, cart_before: 2, cart_after: 6 })]);
    expect(metrics.cartOpenCount()).toBe(4);
    expect(metrics.addClickCount()).toBe(1);
  });
});
