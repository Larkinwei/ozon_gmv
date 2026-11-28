import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../config";
import { SettingsRepository } from "../db/settings-repository";
import { buildCartQuantityReaderScript, StockPrepService } from "./stock-prep-service";

const storeId = "5bb97f32-b358-4303-8163-d500a4bcdd54";
const offerUrl = "https://detail.1688.com/offer/747713283348.html";
const skuId = "6103279203988";
const missingSkuId = "9999999999999";
const outOfStockSkuId = "8888888888888";
const databases: BetterSqlite3.Database[] = [];
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string, options: { runScripts: "outside-only"; url: string }) => {
    window: { document: Document; eval: (script: string) => unknown; close: () => void };
  };
};

function fixture(mappingRows = [["1645-2-XXL", `[${offerUrl}](${offerUrl})`, skuId]] as unknown[][], behavior: "success" | "pre-click-failure" | "dropship-button-missing" | "uncertain" | "wrong-cart" | "grouped-fill-race" | "react-input-desync" = "success", autoApprove = true) {
  const database = new BetterSqlite3(":memory:");
  databases.push(database);
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE stores (id TEXT PRIMARY KEY,name TEXT,platform TEXT,enabled INTEGER);
    CREATE TABLE postings (id TEXT PRIMARY KEY,store_id TEXT,posting_number TEXT,order_number TEXT,fulfillment_mode TEXT,status TEXT,cancelled_at_ms INTEGER,order_at_ms INTEGER,shipment_deadline_at_ms INTEGER);
    CREATE TABLE posting_items (posting_id TEXT,sku TEXT,offer_id TEXT,name TEXT,quantity INTEGER);
    CREATE TABLE product_images (store_id TEXT,sku TEXT,primary_image_url TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT,updated_at_ms INTEGER NOT NULL);
  `);
  database.exec(readFileSync(join(process.cwd(), "migrations/032_stock_prep.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations/033_stock_prep_buyer_risk.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations/034_stock_prep_buyer_blacklist.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations/035_stock_prep_buyer_prefix_history.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations/037_stock_prep_batch_route.sql"), "utf8"));
  database.exec(readFileSync(join(process.cwd(), "migrations/038_stock_prep_completion_method.sql"), "utf8"));
  database.prepare("INSERT INTO stores VALUES (?,?,?,?)").run(storeId, "YOGOLD", "ozon", 1);
  database.prepare("INSERT INTO store_sku_sources VALUES (?,?,?,?,?)").run(storeId, "https://feishu/base", "base-token", "tbl-stock", Date.now());
  const addPosting = database.prepare("INSERT INTO postings (id,store_id,posting_number,order_number,fulfillment_mode,status,cancelled_at_ms) VALUES (?,?,?,?,?,?,?)");
  const addItem = database.prepare("INSERT INTO posting_items (posting_id,offer_id,name,quantity) VALUES (?,?,?,?)");
  for (const [id, postingNumber, mode, status, cancelled, offerId, quantity] of [
    ["p1", "10000001-part-1", "FBS", "awaiting_packaging", null, "1645-2-XXL", 1],
    ["p2", "10000002-part-1", "RFBS", "awaiting_packaging", null, "1645-2-XXL", 2],
    ["p3", "10000003-part-1", "FBO", "awaiting_packaging", null, "1645-2-XXL", 4],
    ["p4", "10000004-part-1", "FBS", "awaiting_deliver", null, "1645-2-XXL", 5],
    ["p5", "10000005-part-1", "FBS", "awaiting_packaging", Date.now(), "1645-2-XXL", 6],
    ["p6", "10000006-part-1", "FBS", "awaiting_packaging", null, "UNMAPPED", 1],
    ["p7", "10000007-part-1", "FBS", "awaiting_packaging", null, "DUPLICATE", 1],
    ["p8", "10000008-part-1", "FBS", "awaiting_packaging", null, "BAD-SKU", 1],
  ] as Array<[string, string, string, string, number | null, string, number]>) {
    addPosting.run(id, storeId, postingNumber, postingNumber, mode, status, cancelled);
    addItem.run(id, offerId, "Test product", quantity);
  }
  const appConfig = { ENCRYPTION_KEY: "a".repeat(64) } as AppConfig;
  const cartQuantities = { wholesale: 2, dropship: 0 };
  const cartQuantitiesByKey = {
    wholesale: new Map([[`747713283348\u0000${skuId}`, 2]]),
    dropship: new Map<string, number>(),
  };
  let currentCart: "wholesale" | "dropship" = "wholesale";
  let cartOpenCount = 0;
  let detailOpenCount = 0;
  let addClickCount = 0;
  let pendingQuantity = 0;
  let selectedSkuId = skuId;
  const pendingQuantities = new Map<string, number>();
  const selectedModes: string[] = [];
  const addActions: string[] = [];
  let dropshipDialog = false;
  const service = new StockPrepService(database, new SettingsRepository(database as never), appConfig, {
    platform: "darwin",
    sleep: async () => undefined,
    feishu: async (args) => { const offset = Number(args[args.indexOf("--offset") + 1] ?? 0); const limit = Number(args[args.indexOf("--limit") + 1] ?? mappingRows.length); return JSON.stringify({ ok: true, identity: "user", data: { data: mappingRows.slice(offset, offset + limit), fields: ["货号", "1688商品链接", "1688 SKU ID"] } }); },
    browserHealth: async () => ({ ready: true, message: "connected" }),
    openCli: async (_session, args) => {
      const [action, value] = args;
      const script = value;
      if (action === "eval" && script) expect(() => new Function(`return ${script};`)).not.toThrow();
      if (action === "open") {
        if (value === "https://cart.1688.com/cart.htm") { cartOpenCount += 1; currentCart = "wholesale"; }
        if (value === "https://cart.1688.com/daixiao_cart.htm") currentCart = "dropship";
        if (value?.startsWith("https://detail.1688.com/offer/")) {
          detailOpenCount += 1;
          pendingQuantities.clear();
        }
        return JSON.stringify({ url: value });
      }
      if (action === "eval" && script?.includes("const targets=")) {
        expect(script).toContain("String(fields.skuId)===target.skuId");
        expect(script).not.toContain("skuTitle");
        const serialized = script.match(/const targets=(\[.*?\]);/su)?.[1];
        const targets = serialized ? JSON.parse(serialized) as Array<{ key: string }> : [];
        return JSON.stringify({ loaded: true, quantities: Object.fromEntries(targets.map((target) => [target.key, cartQuantitiesByKey[currentCart].get(target.key) ?? 0])) });
      }
      if (action === "eval" && script?.includes("const candidates=[document.scrollingElement")) return JSON.stringify({ moved: false, scrollers: 1 });
      if (action === "eval" && script?.includes("return {reset:true}")) return JSON.stringify({ reset: true });
      if (action === "eval" && script?.includes("desiredSkuIds")) {
        const desired = script.match(/const desiredSkuIds=(\[[^;]+\]);/u)?.[1];
        const desiredSkuIds = desired ? JSON.parse(desired) as string[] : [skuId];
        return JSON.stringify({
          url: "https://detail.1688.com/offer/747713283348.html",
          supplierName: "安丘市鑫达尔服装厂",
          skus: desiredSkuIds.flatMap((desiredSkuId, index) => desiredSkuId === missingSkuId ? [] : [{
            skuId: desiredSkuId,
            attributes: index === 0 ? ["蓝底叶子", "XXL"] : ["红底大花", "XL"],
            availableQuantity: desiredSkuId === outOfStockSkuId ? 0 : null,
          }]),
        });
      }
      if (action === "eval" && script?.includes("desiredSkuId") && script.includes("specAttrs")) {
        expect(script).toContain("specAttrs");
        if (script.includes("inputIndex")) {
          return JSON.stringify({ url: "https://detail.1688.com/offer/747713283348.html", color: "蓝底叶子", size: "XXL", skuId, attributes: ["蓝底叶子", "XXL"], availableQuantity: null, visibleSizes: ["M", "L", "XL", "XXL"], inputIndex: 3 });
        }
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
      if (action === "eval" && args.includes("--frame") && script?.includes("HTMLInputElement.prototype") && script.includes("expectedColor")) {
        pendingQuantity = Number(script.match(/const quantity=(\d+)/u)?.[1] ?? 0);
        return JSON.stringify({ color: "蓝底叶子", size: "XXL", filled: behavior !== "pre-click-failure", actual: behavior === "pre-click-failure" ? "0" : String(pendingQuantity) });
      }
      if (action === "eval" && args.includes("--frame") && script?.includes("HTMLInputElement.prototype") && script.includes("const expectedSize=")) {
        pendingQuantity = Number(script.match(/const quantity=(\d+)/u)?.[1] ?? 0);
        pendingQuantities.set(selectedSkuId, pendingQuantity);
        return JSON.stringify({ actual: behavior === "pre-click-failure" ? "0" : String(pendingQuantity), verified: behavior !== "pre-click-failure" });
      }
      if (action === "eval" && script?.includes("const expectedSize=") && script.includes("const write=(value)")) {
        pendingQuantity = Number(script.match(/const quantity=(\d+)/u)?.[1] ?? 0);
        const desiredSkuId = script.match(/const desiredSkuId="([^"]+)"/u)?.[1] ?? skuId;
        pendingQuantities.set(desiredSkuId, pendingQuantity);
        return JSON.stringify({ sizeFound: true, visibleSizes: ["M", "L", "XL", "XXL"], actual: behavior === "pre-click-failure" ? "0" : String(pendingQuantity), verified: behavior !== "pre-click-failure" });
      }
      if (action === "eval" && args.includes("--frame") && script?.includes("buttonCount:buttons.length")) {
        return JSON.stringify({ buttonCount: behavior === "dropship-button-missing" ? 0 : 1, colorActive: true, sizeFound: true, actual: String(pendingQuantity) });
      }
      if (action === "eval" && args.includes("--frame") && script?.includes("buttons[0].click()")) {
        addClickCount += 1;
        addActions.push("弹层加采购车");
        const mode = behavior === "wrong-cart" ? "wholesale" : "dropship";
        if (behavior === "success" || behavior === "wrong-cart" || behavior === "grouped-fill-race" || behavior === "react-input-desync") {
          for (const [pendingSkuId, quantity] of pendingQuantities) {
            const key = `747713283348\u0000${pendingSkuId}`;
            cartQuantitiesByKey[mode].set(key, (cartQuantitiesByKey[mode].get(key) ?? 0) + quantity);
            cartQuantities[mode] += quantity;
          }
        }
        return JSON.stringify({ clicked: true, count: 1 });
      }
      if (action === "eval" && script?.includes("const target=") && script?.includes("sku-filter-button")) return JSON.stringify({ found: true });
      if (action === "eval" && script?.includes("const desiredSkuId=") && script.includes("const expectedSize=") && script.includes("inputIndex")) {
        selectedSkuId = script.match(/const desiredSkuId="([^"]+)"/u)?.[1] ?? skuId;
        return JSON.stringify({ sizeFound: true, visibleSizes: ["M", "L", "XL", "XXL"], inputIndex: selectedSkuId === skuId ? 3 : 1, skuId: selectedSkuId });
      }
      if (action === "eval" && script?.includes("aria-label=\"plus\"") && script.includes("targetQuantity")) {
        const targetQuantity = Number(script.match(/const targetQuantity=(\d+)/u)?.[1] ?? 0);
        selectedSkuId = script.match(/const expectedSkuId="([^"]+)"/u)?.[1] ?? selectedSkuId;
        if (behavior !== "pre-click-failure") pendingQuantities.set(selectedSkuId, targetQuantity);
        return JSON.stringify({
          sizeFound: true,
          visibleSizes: ["M", "L", "XL", "XXL"],
          inputFound: true,
          actual: behavior === "pre-click-failure" ? 0 : targetQuantity,
          verified: behavior !== "pre-click-failure",
        });
      }
      if (action === "eval" && script?.includes("expectedColor")) return JSON.stringify({ url: "https://detail.1688.com/offer/747713283348.html", color: "蓝底叶子", size: "XXL", skuId, inputIndex: 3 });
      if (action === "eval" && script?.includes("button.scrollIntoView")) return JSON.stringify({ buttonCount: 1, visible: true });
      if (action === "eval" && !args.includes("--frame") && script?.includes("buttons[0].click()") && script.includes("加采购车")) {
        addClickCount += 1;
        addActions.push("加采购车");
        const mode = behavior === "wrong-cart" ? "dropship" : "wholesale";
        if (behavior === "success" || behavior === "wrong-cart" || behavior === "grouped-fill-race" || behavior === "react-input-desync") {
          for (const [pendingSkuId, quantity] of pendingQuantities) {
            const key = `747713283348\u0000${pendingSkuId}`;
            cartQuantitiesByKey[mode].set(key, (cartQuantitiesByKey[mode].get(key) ?? 0) + quantity);
            cartQuantities[mode] += quantity;
          }
        }
        return JSON.stringify({ clicked: true, count: 1 });
      }
      if (action === "fill") {
        pendingQuantity = Number(args.at(-1));
        // 复现同页连续填写时，最后一个输入尚未进入 1688 提交状态的竞态。
        if (behavior !== "react-input-desync" && (behavior !== "grouped-fill-race" || pendingQuantities.size === 0)) pendingQuantities.set(selectedSkuId, pendingQuantity);
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
  if (autoApprove) service.approveRiskOrder(storeId, "10000002");
  return { database, service, metrics: { cartOpenCount: () => cartOpenCount, detailOpenCount: () => detailOpenCount, addClickCount: () => addClickCount, selectedModes, addActions, cartQuantities } };
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
  it.each([
    { layout: "legacy", dropship: false, tab: "批发", quantity: 2 },
    { layout: "legacy", dropship: true, tab: "代发", quantity: 3 },
    { layout: "modern", dropship: false, tab: "现货(4)", quantity: 4 },
    { layout: "modern", dropship: true, tab: "分销(5)", quantity: 5 },
  ])("reads $layout $tab cart quantities by offer ID and SKU ID", ({ layout, dropship, tab, quantity }) => {
    const item = layout === "legacy"
      ? `<div id="cartV2Header"></div><div class="groupRoot-test"><a href="${offerUrl}"></a><div class="item--container-test"><div class="quantityWrapper-test"><input value="${quantity}"></div><span class="fiber-anchor"></span></div></div>`
      : `<div class="cart--container-test"><div class="header-bar--container-test"></div><div role="tab" aria-selected="true">${tab}</div><div class="item--container--test"><div class="numberPicker-test"><input value="${quantity}"></div><span class="fiber-anchor"></span></div></div>`;
    const path = dropship ? "daixiao_cart.htm" : "cart.htm";
    const dom = new JSDOM(item, { runScripts: "outside-only", url: `https://cart.1688.com/${path}` });
    const anchor = dom.window.document.querySelector(".fiber-anchor") as HTMLElement & Record<string, unknown>;
    anchor.__reactFiber$test = { memoizedProps: { fields: { offerId: "747713283348", skuId, quantity } }, return: null };

    const result = dom.window.eval(buildCartQuantityReaderScript([{ key: "target", productId: "747713283348", skuId }], dropship)) as { loaded: boolean; quantities: Record<string, number> };
    expect(result).toEqual({ loaded: true, quantities: { target: quantity } });
    dom.window.close();
  });

  it("reads SKU mappings beyond the first 100 Feishu records", async () => {
    const mappings = Array.from({ length: 120 }, (_, index) => [`UNUSED-${index}`, offerUrl, skuId] as unknown[]);
    mappings.push(["UNMAPPED", offerUrl, skuId]);
    const { service } = fixture(mappings);

    const scan = await service.scan(storeId);
    const matched = scan.groups.find((group) => group.offerId === "UNMAPPED");

    expect(matched).toMatchObject({ skuId, status: "pending", error: null });
  });

  it("lists fully added awaiting-packaging postings first and counts distinct SKUs", () => {
    const { database, service } = fixture();
    database.prepare("INSERT INTO posting_items (posting_id,offer_id,name,quantity) VALUES (?,?,?,?)")
      .run("p2", "1645-2-XXL", "Duplicate line", 1);
    database.prepare("INSERT INTO stock_prep_order_states (store_id,posting_number,offer_id,state,updated_at_ms) VALUES (?,?,?,?,?)")
      .run(storeId, "10000002-part-1", "1645-2-XXL", "added", Date.now());
    database.prepare("UPDATE postings SET status='awaiting_registration' WHERE id='p4'").run();

    const postings = service.listFulfillmentPostings(storeId);

    const postingNumbers = postings.map((posting) => posting.posting_number);
    expect(postingNumbers.indexOf("10000002-part-1")).toBeLessThan(postingNumbers.indexOf("10000001-part-1"));
    expect(postingNumbers.indexOf("10000001-part-1")).toBeLessThan(postingNumbers.indexOf("10000004-part-1"));
    expect(postings[0]).toMatchObject({ sku_count: 1, added_sku_count: 1 });
    expect(postings.find((posting) => posting.posting_number === "10000004-part-1")).toMatchObject({
      status: "awaiting_registration",
      can_prepare: false,
      prepare_block_reason: "已提交备货，等待 Ozon 登记",
    });
  });

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
    expect(mapped.orders.map((order) => order.postingNumber)).toEqual(["10000001-part-1", "10000002-part-1"]);
    expect(mapped.quantity).toBe(3);
    expect(mapped.orders.every((order) => order.state === "pending" && order.selectedByDefault)).toBe(true);
    expect(result.groups.find((group) => group.offerId === "DUPLICATE")?.status).toBe("unmatched");
    expect(result.groups.find((group) => group.offerId === "BAD-SKU")?.status).toBe("unmatched");
    expect(result.groups.find((group) => group.offerId === "UNMAPPED")?.orders[0]?.error).toBe("飞书未找到该货号");
    expect(result.groups.find((group) => group.offerId === "DUPLICATE")?.orders[0]?.error).toBe("飞书货号重复");
    expect(result.groups.find((group) => group.offerId === "BAD-SKU")?.orders[0]?.error).toBe("1688 SKU ID 无效");
    expect(result.groups.some((group) => group.offerId === "UNMAPPED")).toBe(true);
    expect(result.groups.some((group) => group.orders.some((order) => order.postingNumber === "10000003-part-1" || order.postingNumber === "10000004-part-1" || order.postingNumber === "10000005-part-1"))).toBe(false);
  });

  it("reconciles stale unmatched states with the current unique Feishu mapping", async () => {
    const { database, service } = fixture();
    database.prepare("INSERT INTO stock_prep_order_states (store_id,posting_number,offer_id,state,error,updated_at_ms) VALUES (?,?,?,?,?,?)")
      .run(storeId, "10000001-part-1", "1645-2-XXL", "unmatched", "飞书映射缺失、重复或无效", Date.now());
    const result = await service.scan(storeId);
    const mapped = result.groups.find((group) => group.offerId === "1645-2-XXL")!;
    expect(mapped.orders.map((order) => order.state)).toEqual(["pending", "pending"]);
    expect(mapped.orders.every((order) => order.error === null)).toBe(true);
  });

  it("blocks every mapped SKU in a posting while one sibling has no mapping, then accepts manual procurement", async () => {
    const { database, service } = fixture();
    database.prepare("INSERT INTO posting_items (posting_id,offer_id,name,quantity) VALUES (?,?,?,?)")
      .run("p1", "UNMAPPED", "Missing sibling", 1);
    service.approveRiskOrder(storeId, "10000001");

    const before = await service.scan(storeId);
    const mapped = before.groups.find((group) => group.offerId === "1645-2-XXL")!.orders.find((order) => order.postingNumber === "10000001-part-1")!;
    const unmatched = before.groups.find((group) => group.offerId === "UNMAPPED")!.orders[0]!;
    expect(mapped).toMatchObject({ postingSkuCount: 2, postingPieceCount: 2, postingCanAdd: false, selectedByDefault: false });
    expect(mapped.postingBlockReason).toContain("UNMAPPED");
    await expect(service.createBatch(storeId, [{ postingNumber: mapped.postingNumber, offerId: mapped.offerId }])).rejects.toThrow("暂停加购");

    await expect(service.markOrdersAdded(storeId, [{ postingNumber: unmatched.postingNumber, offerId: unmatched.offerId }])).rejects.toThrow("不能人工标记已加购");
    await expect(service.markUnmatchedOrdersAdded(storeId, [{ postingNumber: unmatched.postingNumber, offerId: unmatched.offerId }], "1688手动采购")).resolves.toBe(1);
    expect(database.prepare("SELECT state,error,completion_method,completion_note FROM stock_prep_order_states WHERE store_id=? AND posting_number=? AND offer_id=?").get(storeId, unmatched.postingNumber, unmatched.offerId))
      .toMatchObject({ state: "added", error: "人工确认已采购（无飞书映射）", completion_method: "manual_unmapped", completion_note: "1688手动采购" });
    const after = await service.scan(storeId);
    expect(after.groups.find((group) => group.offerId === "1645-2-XXL")!.orders.find((order) => order.postingNumber === "10000001-part-1"))
      .toMatchObject({ postingCanAdd: true, postingBlockReason: null });
  });

  it("rejects a partially selected posting even when every SKU has a valid mapping", async () => {
    const secondSkuId = "6103279203999";
    const { database, service } = fixture([
      ["1645-2-XXL", offerUrl, skuId],
      ["UNMAPPED", offerUrl, secondSkuId],
    ]);
    database.prepare("INSERT INTO posting_items (posting_id,offer_id,name,quantity) VALUES (?,?,?,?)")
      .run("p1", "UNMAPPED", "Mapped sibling", 1);
    service.approveRiskOrder(storeId, "10000001");
    const scan = await service.scan(storeId);
    const postingOrders = scan.groups.flatMap((group) => group.orders).filter((order) => order.postingNumber === "10000001-part-1");
    expect(postingOrders).toHaveLength(2);
    expect(postingOrders.every((order) => order.postingCanAdd)).toBe(true);

    await expect(service.createBatch(storeId, [{ postingNumber: postingOrders[0]!.postingNumber, offerId: postingOrders[0]!.offerId }]))
      .rejects.toThrow("必须整单加购");
  });

  it("requires manual confirmation for every order with multiple pieces", async () => {
    const { database, service } = fixture(undefined, "success", false);
    database.prepare("UPDATE postings SET posting_number=CASE posting_number WHEN '10000001-part-1' THEN '12345678-part1-1' WHEN '10000002-part-1' THEN '12345678-part2-1' ELSE posting_number END,order_number='order-shared',buyer_key_hash='buyer-a' WHERE posting_number IN ('10000001-part-1','10000002-part-1')").run();
    database.prepare(`INSERT INTO postings (id,store_id,posting_number,order_number,fulfillment_mode,status,cancelled_at_ms,order_at_ms,buyer_key_hash,cancellation_initiator)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run("history-1", storeId, "history-post", "history-order", "FBS", "cancelled", Date.now(), Date.now() - 86400000, "buyer-a", "Клиент");
    const beforeApproval = await service.scan(storeId);
    const riskyOrders = beforeApproval.groups.find((group) => group.offerId === "1645-2-XXL")!.orders;
    expect(riskyOrders.every((order) => order.orderQuantity === 3 && order.riskLevel === "review" && !order.selectedByDefault)).toBe(true);
    await expect(service.createBatch(storeId, riskyOrders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))).rejects.toThrow("人工风险确认");
    service.approveRiskOrder(storeId, "12345678");
    expect((await service.scan(storeId)).groups.find((group) => group.offerId === "1645-2-XXL")!.orders.every((order) => order.approved && order.selectedByDefault)).toBe(true);
    database.prepare("UPDATE posting_items SET quantity=3 WHERE posting_id='p2'").run();
    expect((await service.scan(storeId)).groups.find((group) => group.offerId === "1645-2-XXL")!.orders.some((order) => !order.approved && !order.selectedByDefault)).toBe(true);
  });

  it("blocks an active blacklisted buyer independently of the multi-piece review", async () => {
    const { database, service } = fixture(undefined, "success", false);
    database.prepare("UPDATE postings SET posting_number=CASE posting_number WHEN '10000001-part-1' THEN '12345678-part1-1' WHEN '10000002-part-1' THEN '12345678-part2-1' ELSE posting_number END WHERE posting_number IN ('10000001-part-1','10000002-part-1')").run();
    const buyerPrefixHash = createHmac("sha256", "a".repeat(64)).update(`${storeId}\u000012345678`).digest("hex");
    database.prepare(`INSERT INTO stock_prep_buyer_blacklist (id,store_id,buyer_key_hash,status,source,reason_code,created_at_ms,updated_at_ms)
      VALUES ('blacklist-entry',?,?,'active','manual','manual',?,?)`).run(storeId, buyerPrefixHash, Date.now(), Date.now());

    const orders = (await service.scan(storeId)).groups.find((group) => group.offerId === "1645-2-XXL")!.orders;

    expect(orders.find((order) => order.postingNumber === "12345678-part1-1")).toMatchObject({ riskLevel: "blacklist", selectedByDefault: false });
    expect(orders.find((order) => order.postingNumber === "12345678-part2-1")).toMatchObject({ riskLevel: "blacklist", selectedByDefault: false });
    await expect(service.createBatch(storeId, [{ postingNumber: "12345678-part1-1", offerId: "1645-2-XXL" }])).rejects.toThrow("黑名单");
  });

  it("groups open orders by buyer prefix and excludes current orders from synced history", async () => {
    const { database, service } = fixture(undefined, "success", false);
    const now = Date.now();
    database.prepare(`UPDATE postings SET posting_number=CASE id WHEN 'p1' THEN '12345678-part1-1' WHEN 'p2' THEN '12345678-part2-1' ELSE posting_number END,
      order_number=CASE id WHEN 'p1' THEN 'order-a' WHEN 'p2' THEN 'order-b' ELSE order_number END,
      order_at_ms=CASE id WHEN 'p1' THEN ? ELSE ? END WHERE id IN ('p1','p2')`).run(now - 1000, now);
    database.prepare(`INSERT INTO postings (id,store_id,posting_number,order_number,fulfillment_mode,status,cancelled_at_ms,order_at_ms)
      VALUES ('history-1',?,'12345678-old-1','history-order','FBS','delivered',NULL,?)`).run(storeId, now - 30 * 86400000);
    database.prepare(`INSERT INTO stock_prep_buyer_returns (store_id,return_id,posting_number,order_number,quantity,return_type,returned_at_ms,return_reason,visual_status)
      VALUES (?, 'return-1','12345678-old-1','history-order',1,'PartialReturn',?,'Покупатель отказался при вручении: не подошел','Получен')`).run(storeId, now - 29 * 86400000);

    const before = (await service.scan(storeId)).groups.find((group) => group.offerId === "1645-2-XXL")!.orders;
    expect(before.map((order) => order.riskLevel)).toEqual(["review", "review"]);
    expect(before.every((order) => order.currentOrderCount === 2 && !order.selectedByDefault)).toBe(true);
    expect(before.map((order) => order.currentOrderIndex)).toEqual([1, 2]);
    expect(before[0]!.buyerHistory).toMatchObject({ ordersInYear: 1, deliveredOrders: 1, returnCount: 1, refusalOrders: 1, returnedPieces: 1 });
    expect(before[0]!.buyerHistory.recentOrders.map((order) => order.postingNumber)).toEqual(["12345678-old-1"]);
    expect(before[0]!.buyerHistory.recentOrders.some((order) => order.postingNumber.includes("part"))).toBe(false);
    expect(before[0]!.buyerHistory.orderSequenceByPostingNumber).toMatchObject({ "12345678-part1-1": 2, "12345678-part2-1": 3 });

    service.approveRiskOrder(storeId, "12345678");
    const after = (await service.scan(storeId)).groups.find((group) => group.offerId === "1645-2-XXL")!.orders;
    expect(after.every((order) => order.approved && order.selectedByDefault)).toBe(true);
  });

  it("keeps manual blacklist entries active when an Agent submits the same buyer as a candidate", () => {
    const { database, service } = fixture(undefined, "success", false);
    const buyerPrefix = "12345678";
    service.upsertBuyerBlacklist(storeId, { buyerPrefix, status: "active", source: "manual", reasonCode: "manual", summary: "人工确认" });
    service.upsertBuyerBlacklist(storeId, { buyerPrefix, status: "candidate", source: "agent", reasonCode: "agent_signal", summary: "Agent 命中" });

    expect(service.listBuyerBlacklist(storeId)).toMatchObject([{ buyerPrefix, status: "active", source: "manual", summary: "人工确认" }]);
  });

  it("adds the selected quantities once, verifies the cart delta, and supports manual state rollback", async () => {
    const { database, service, metrics } = fixture();
    const scan = await service.scan(storeId);
    const orders = scan.groups.find((group) => group.offerId === "1645-2-XXL")!.orders;
    const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));
    const result = await waitForBatch(service, batch.id);
    expect(result.status).toBe("completed");
    expect((result.items as Array<{ quantity: number; cart_before: number; cart_after: number; supplier_name: string; cart_mode: string }>)[0]).toMatchObject({ quantity: 3, cart_before: 2, cart_after: 5, supplier_name: "安丘市鑫达尔服装厂", cart_mode: "wholesale" });
    expect(metrics.cartOpenCount()).toBe(2);
    expect(metrics.addClickCount()).toBe(1);
    expect(metrics.addActions).toEqual(["加采购车"]);
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
    expect(metrics.addActions).toEqual(["弹层加采购车"]);
    expect(metrics.addClickCount()).toBe(1);
    expect(metrics.cartQuantities).toEqual({ wholesale: 2, dropship: 3 });
    expect(result.items).toEqual([expect.objectContaining({ status: "added", quantity: 3, cart_before: 0, cart_after: 3, supplier_name: "安丘市鑫达尔服装厂", cart_mode: "dropship" })]);
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
    expect(result.items).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("加购按钮定位失败") })]);
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
      expect(service.resetOrders(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })))).toBe(2);
      expect(database.prepare("SELECT COUNT(*) AS count FROM stock_prep_order_states WHERE state='pending'").get()).toMatchObject({ count: 2 });
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
    expect(metrics.cartOpenCount()).toBe(2);
    expect(metrics.addClickCount()).toBe(1);
  });

  it("submits each SKU independently when the same product contains multiple target SKU IDs", async () => {
    const secondSkuId = "6103279203999";
    const { service, metrics } = fixture([
      ["1645-2-XXL", `[${offerUrl}](${offerUrl})`, skuId],
      ["UNMAPPED", `[${offerUrl}](${offerUrl})`, secondSkuId],
    ], "grouped-fill-race");
    const scan = await service.scan(storeId);
    const orders = scan.groups.flatMap((group) => group.orders).filter((order) => order.state === "pending");
    const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));

    const result = await waitForBatch(service, batch.id);

    expect(result.status).toBe("completed");
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sku_id: skuId, quantity: 3, status: "added", cart_before: 2, cart_after: 5 }),
      expect.objectContaining({ sku_id: secondSkuId, quantity: 1, status: "added", cart_before: 0, cart_after: 1 }),
    ]));
    expect(metrics.detailOpenCount()).toBe(2);
    expect(metrics.addClickCount()).toBe(2);
    expect(metrics.addActions).toEqual(["加采购车", "加采购车"]);
  });

  it("uses the page quantity controls when a filled input value does not update React state", async () => {
    const { service, metrics } = fixture(undefined, "react-input-desync");
    const scan = await service.scan(storeId);
    const orders = scan.groups.find((group) => group.offerId === "1645-2-XXL")!.orders;

    const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));
    const result = await waitForBatch(service, batch.id);

    expect(result.status).toBe("completed");
    expect(result.items).toEqual([expect.objectContaining({ status: "added", quantity: 3, cart_before: 2, cart_after: 5 })]);
    expect(metrics.addClickCount()).toBe(1);
  });

  it("keeps valid SKUs addable when another SKU is missing or out of stock", async () => {
    const { service, metrics } = fixture([
      ["1645-2-XXL", offerUrl, skuId],
      ["UNMAPPED", offerUrl, missingSkuId],
      ["DUPLICATE", offerUrl, outOfStockSkuId],
    ]);
    const scan = await service.scan(storeId);
    const orders = scan.groups.flatMap((group) => group.orders).filter((order) => order.state === "pending");
    const batch = await service.createBatch(storeId, orders.map(({ postingNumber, offerId }) => ({ postingNumber, offerId })));

    const result = await waitForBatch(service, batch.id);
    const items = result.items as Array<{ sku_id: string; status: string; error: string | null }>;

    expect(result.status).toBe("completed_with_errors");
    expect(items.find((item) => item.sku_id === skuId)).toMatchObject({ status: "added", error: null });
    expect(items.find((item) => item.sku_id === missingSkuId)).toMatchObject({ status: "failed", error: expect.stringContaining("未匹配到 SKU") });
    expect(items.find((item) => item.sku_id === outOfStockSkuId)).toMatchObject({ status: "failed", error: expect.stringContaining("库存不足") });
    expect(metrics.detailOpenCount()).toBe(1);
    expect(metrics.addClickCount()).toBe(1);
  });
});
