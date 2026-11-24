import { createHash, createHmac, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import QRCode from "qrcode";

import type { AppDatabase } from "../db/database";
import type { SettingsRepository } from "../db/settings-repository";
import type { AppConfig } from "../config";
import { decryptSecret, encryptSecret } from "../security/encryption";
import { runOpenCli, defaultOpenCliPath } from "./opencli-runtime";

export type StockPrepState = "pending" | "adding" | "added" | "failed" | "uncertain" | "unmatched";
export type BuyerRiskLevel = "none" | "review" | "blacklist";

export interface StockPrepOrderView {
  postingNumber: string; orderNumber: string; buyerPrefix: string | null; offerId: string; productName: string; imageUrl: string | null;
  quantity: number; orderQuantity: number; riskLevel: BuyerRiskLevel; blacklistStatus: string | null;
  currentOrderCount: number; currentOrderIndex: number | null; buyerHistory: BuyerHistorySummary;
  approved: boolean; state: StockPrepState; error: string | null; selectedByDefault: boolean;
}
export interface StockPrepGroupView { offerUrl: string | null; offerId: string; skuId: string | null; imageUrl: string | null; status: StockPrepState; quantity: number; orders: StockPrepOrderView[]; error: string | null }
export interface BuyerHistorySummary {
  syncState: "queued" | "running" | "complete" | "failed" | "not_started";
  syncError: string | null;
  ordersInYear: number; deliveredOrders: number; cancelledOrders: number; refusalOrders: number; returnCount: number; returnedPieces: number;
  latestOutcome: string | null; latestAt: number | null;
  orderSequenceByPostingNumber: Record<string, number>;
  recentOrders: Array<{ postingNumber: string; status: string; orderAt: number; cancellationInitiator: string | null; cancellationType: string | null; returns: Array<{ type: string; reason: string | null; status: string | null; quantity: number }> }>;
}
export interface StockPrepScanView { storeId: string; groups: StockPrepGroupView[]; buyerHistorySync: Record<string, unknown> | null; lastOrderSyncAt: number | null }

interface OrderRow {
  store_id: string;
  store_name: string;
  posting_number: string;
  order_number: string;
  order_at_ms: number;
  offer_id: string;
  name: string;
  quantity: number;
  image_url: string | null;
  state: StockPrepState | null;
  error: string | null;
}

interface Mapping {
  offerId: string;
  url: string;
  skuId: string;
}

interface StockPrepBatchItemRow {
  id: string;
  offer_url: string;
  offer_id: string;
  sku_id: string;
  quantity: number;
  order_keys_json: string;
}

interface ResolvedSkuTarget extends StockPrepBatchItemRow {
  productId: string;
  attributes: string[];
  cartKey: string;
  supplierName: string;
  dropship: boolean;
}

type CartModeQuantities = { wholesale: number; dropship: number };

interface BrowserFrame {
  index: number;
  url: string;
  name: string;
}

interface StockPrepStoreRow {
  source_url: string;
  base_token: string;
  table_id: string;
}

interface StockPrepRuntime {
  platform?: NodeJS.Platform;
  feishu?: (args: string[], profile: string | null, stdinSecret?: string) => Promise<string>;
  openCli?: (session: string, args: string[]) => Promise<string>;
  browserHealth?: () => Promise<{ ready: boolean; message: string }>;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface CliEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: { message?: string; hint?: string };
}

const APP_ID_KEY = "stock-prep.feishu.app_id";
const APP_SECRET_KEY = "stock-prep.feishu.app_secret";
const PROFILE_KEY = "stock-prep.feishu.profile";
const DROPSHIP_SUPPLIERS_KEY = "stock-prep.dropship-suppliers";
const ORDER_SYNC_CACHE_KEY_PREFIX = "stock-prep.order-sync-at.";
const ORDER_SYNC_CACHE_TTL_MS = 60 * 60 * 1000;
const require = createRequire(import.meta.url);

function buyerPrefixFromPostingNumber(postingNumber: string): string | null {
  const match = postingNumber.match(/^(\d+)-[^-]+-\d+$/u);
  return match?.[1] ?? null;
}

function buyerPrefixHash(storeId: string, buyerPrefix: string, encryptionKey: string): string {
  return createHmac("sha256", encryptionKey).update(`${storeId}\u0000${buyerPrefix}`).digest("hex");
}

function buyerSnapshotHash(database: AppDatabase, storeId: string, buyerPrefix: string): string | null {
  const items = database.prepare(`SELECT p.posting_number,pi.offer_id,pi.quantity FROM postings p
    JOIN posting_items pi ON pi.posting_id=p.id WHERE p.store_id=? AND p.posting_number LIKE ? AND p.status='awaiting_packaging'
    AND p.cancelled_at_ms IS NULL ORDER BY p.posting_number,pi.offer_id`).all(storeId, `${buyerPrefix}-%`);
  return items.length ? createHash("sha256").update(JSON.stringify(items)).digest("hex") : null;
}

function emptyBuyerHistory(): BuyerHistorySummary {
  return { syncState: "not_started", syncError: null, ordersInYear: 0, deliveredOrders: 0, cancelledOrders: 0, refusalOrders: 0, returnCount: 0, returnedPieces: 0, latestOutcome: null, latestAt: null, orderSequenceByPostingNumber: {}, recentOrders: [] };
}

function parseCli<T>(output: string): T {
  const unwrap = (parsed: CliEnvelope<T> | T): T => {
    const envelope = parsed as CliEnvelope<T>;
    if (envelope.ok === false) throw new Error(envelope.error?.message ?? envelope.error?.hint ?? "飞书请求失败");
    return envelope.ok === true ? envelope.data as T : parsed as T;
  };
  try { return unwrap(JSON.parse(output) as CliEnvelope<T> | T); }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return unwrap(JSON.parse(lines[index]!) as CliEnvelope<T> | T); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  throw new Error("飞书 CLI 未返回可解析结果");
}

function valid1688Url(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "detail.1688.com" && /^\/offer\/\d+\.html$/u.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizeMappingUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/u)?.[2] ?? text;
}

function extractOfferId(value: string): string | null {
  try { return new URL(value).pathname.match(/^\/offer\/(\d+)\.html$/u)?.[1] ?? null; } catch { return null; }
}

function parseRecords(output: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of output.split(/\r?\n/u)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const fields = parsed.fields;
      if (fields && typeof fields === "object" && !Array.isArray(fields)) rows.push(fields as Record<string, unknown>);
    } catch { /* CLI diagnostics and artifact summaries are not record rows. */ }
  }
  if (rows.length) return rows;
  try {
    const envelope = JSON.parse(output) as CliEnvelope<{ data?: unknown[][]; fields?: string[]; record_id_list?: string[] }>;
    const result = envelope.data && !Array.isArray(envelope.data) ? envelope.data as { data?: unknown[][]; fields?: string[]; record_id_list?: string[] } : envelope as unknown as { data?: unknown[][]; fields?: string[]; record_id_list?: string[] };
    if (Array.isArray(result.data) && Array.isArray(result.fields)) {
      return result.data.map((cells, index) => ({ ...Object.fromEntries(result.fields!.map((field, cellIndex) => [field, cells[cellIndex]])), record_id: result.record_id_list?.[index] }));
    }
  } catch { /* Fall through to the human-readable table parser. */ }
  const tableRows = output.split(/\r?\n/u).filter((line) => line.startsWith("|"));
  if (tableRows.length < 3) return rows;
  const headers = tableRows[0]!.split("|").slice(1, -1).map((cell) => cell.trim());
  for (const line of tableRows.slice(2)) {
    const values = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (values.length === headers.length) rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])));
  }
  return rows;
}

/** Reads a configured Feishu Base and correlates awaiting FBS/realFBS postings by offer_id. */
export class StockPrepService {
  private batchRunning = false;
  private authorization: { state: "pending" | "complete" | "failed"; message?: string; url?: string; qrCode?: string } | null = null;

  public constructor(private readonly database: AppDatabase, private readonly settings: SettingsRepository, private readonly config: AppConfig, private readonly runtime: StockPrepRuntime = {}) {
    const now = Date.now();
    this.database.prepare("UPDATE stock_prep_order_states SET state='uncertain',error='服务重启时加购结果尚未确认',updated_at_ms=? WHERE state='adding'").run(now);
    this.database.prepare("UPDATE stock_prep_batch_items SET status='uncertain',error='服务重启时加购结果尚未确认',updated_at_ms=? WHERE status IN ('queued','running')").run(now);
    this.database.prepare("UPDATE stock_prep_batches SET status='completed_with_errors',completed_count=(SELECT COUNT(*) FROM stock_prep_batch_items WHERE batch_id=stock_prep_batches.id),finished_at_ms=? WHERE status IN ('queued','running')").run(now);
  }

  /** Reports verified Feishu OAuth and Browser Bridge health without exposing credentials. */
  public async getConnectionState(): Promise<Record<string, unknown>> {
    let profile = this.getFeishuProfile();
    if ((this.runtime.platform ?? process.platform) === "win32") {
      profile = await this.resolveWindowsFeishuProfile() ?? profile;
    }
    let feishu: Record<string, unknown> = { connected: false, profile, userName: null, message: "尚未完成飞书授权" };
    if (profile) {
      try {
        const status = parseCli<Record<string, unknown>>(await this.feishu(["auth", "status", "--json", "--verify"], profile));
        const identities = status.identities as { user?: { status?: string; userName?: string; tokenStatus?: string } } | undefined;
        const connected = identities?.user?.status === "ready" && identities.user.tokenStatus === "valid";
        feishu = { connected, profile, userName: identities?.user?.userName ?? null, message: connected ? "飞书用户授权有效" : "飞书用户授权不可用" };
      } catch (error) { feishu = { connected: false, profile, userName: null, message: error instanceof Error ? error.message : "飞书连接失败" }; }
    }
    const sourceCount = this.database.prepare("SELECT COUNT(*) AS count FROM store_sku_sources").get() as { count: number };
    const bridge = this.runtime.browserHealth ? await this.runtime.browserHealth() : await (await import("./opencli-runtime")).diagnoseOpenCliBridge(defaultOpenCliPath());
    return {
      platform: process.platform,
      feishu: { ...feishu, appIdConfigured: Boolean(this.settings.get(APP_ID_KEY)), appSecretConfigured: Boolean(this.settings.get(APP_SECRET_KEY)), authorization: this.authorization },
      configuredStoreCount: sourceCount.count,
      browserBridge: bridge,
      dropshipSuppliers: this.getDropshipSuppliers(),
    };
  }

  /** Stores Feishu app credentials encrypted for a Windows service account. */
  public configureFeishuApp(appId: string, appSecret: string): void {
    const cleanAppId = appId.trim(); const cleanSecret = appSecret.trim();
    if (!/^cli_[A-Za-z0-9]+$/u.test(cleanAppId) || cleanSecret.length < 8) throw new Error("请检查飞书 App ID 和 App Secret");
    const profile = `ozon-stock-prep-${randomUUID().slice(0, 8)}`;
    this.settings.set(APP_ID_KEY, cleanAppId);
    this.settings.set(APP_SECRET_KEY, encryptSecret(cleanSecret, this.config.ENCRYPTION_KEY));
    this.settings.set(PROFILE_KEY, profile);
  }

  /** Starts Feishu's device authorization and continues polling in the server process. */
  public async beginFeishuAuthorization(): Promise<{ verificationUrl: string; qrCode: string }> {
    let profile = this.getFeishuProfile();
    if ((this.runtime.platform ?? process.platform) === "win32") profile = await this.resolveWindowsFeishuProfile(true);
    if (!profile) throw new Error("请先配置飞书 App ID 与 App Secret");
    const started = parseCli<{ verification_url: string; device_code: string }>(await this.feishu(["auth", "login", "--domain", "base", "--no-wait", "--json"], profile));
    if (!started.verification_url || !started.device_code) throw new Error("飞书没有返回设备授权链接");
    const qrCode = await QRCode.toDataURL(started.verification_url, { margin: 1, width: 220 });
    this.authorization = { state: "pending", url: started.verification_url, qrCode };
    void this.finishFeishuAuthorization(profile, started.device_code);
    return { verificationUrl: started.verification_url, qrCode };
  }

  private async finishFeishuAuthorization(profile: string, deviceCode: string): Promise<void> {
    try { await this.feishu(["auth", "login", "--device-code", deviceCode], profile); this.authorization = { state: "complete", message: "飞书用户授权完成" }; }
    catch (error) { this.authorization = { state: "failed", message: error instanceof Error ? error.message : "飞书授权失败" }; }
  }

  public getSource(storeId: string): { url: string } | null {
    const row = this.database.prepare("SELECT source_url FROM store_sku_sources WHERE store_id=?").get(storeId) as { source_url: string } | undefined;
    return row ? { url: row.source_url } : null;
  }

  /** Returns whether Ozon order data was synchronized for this store within the last hour. */
  public hasFreshOrderSyncCache(storeId: string, now = Date.now()): boolean {
    const refreshedAt = Number(this.settings.get(`${ORDER_SYNC_CACHE_KEY_PREFIX}${storeId}`));
    return Number.isSafeInteger(refreshedAt) && refreshedAt > 0 && refreshedAt <= now && now - refreshedAt < ORDER_SYNC_CACHE_TTL_MS;
  }

  /** Returns the last successful Ozon order-sync timestamp for the store. */
  public getLastOrderSyncAt(storeId: string): number | null {
    const refreshedAt = Number(this.settings.get(`${ORDER_SYNC_CACHE_KEY_PREFIX}${storeId}`));
    return Number.isSafeInteger(refreshedAt) && refreshedAt > 0 ? refreshedAt : null;
  }

  /** Persists the successful order synchronization time across page visits and service restarts. */
  public markOrderSyncCacheFresh(storeId: string, refreshedAt = Date.now()): void {
    this.settings.set(`${ORDER_SYNC_CACHE_KEY_PREFIX}${storeId}`, String(refreshedAt));
  }

  /** Returns buyer-prefix blacklist entries without exposing any Ozon customer identifier. */
  public listBuyerBlacklist(storeId: string): Record<string, unknown>[] {
    const rows = this.database.prepare("SELECT id,buyer_prefix_ciphertext,status,source,reason_code,summary,evidence_orders_json,rule_version,notes,created_at_ms,updated_at_ms FROM stock_prep_buyer_blacklist WHERE store_id=? ORDER BY updated_at_ms DESC")
      .all(storeId) as Array<Record<string, unknown> & { buyer_prefix_ciphertext: string | null }>;
    return rows.map(({ buyer_prefix_ciphertext, ...row }) => ({
      ...row,
      buyerPrefix: buyer_prefix_ciphertext ? decryptSecret(buyer_prefix_ciphertext, this.config.ENCRYPTION_KEY) : null,
      evidenceOrders: JSON.parse(String(row.evidence_orders_json ?? "[]")) as string[],
    }));
  }

  /** Adds or updates one buyer-prefix record while keeping Agent submissions as candidates. */
  public upsertBuyerBlacklist(storeId: string, input: { buyerPrefix: string; status: "candidate" | "active"; source: "manual" | "agent" | "order"; reasonCode: string; summary?: string; evidenceOrders?: string[]; ruleVersion?: string; notes?: string }): void {
    const now = Date.now();
    const buyerPrefix = input.buyerPrefix.trim();
    if (!/^\d{3,30}$/u.test(buyerPrefix)) throw new Error("买家编号必须是 posting_number 的第一段数字");
    const hash = buyerPrefixHash(storeId, buyerPrefix, this.config.ENCRYPTION_KEY);
    const existing = this.database.prepare("SELECT id,status FROM stock_prep_buyer_blacklist WHERE store_id=? AND buyer_key_hash=?").get(storeId, hash) as { id: string; status: string } | undefined;
    if (input.source === "agent" && existing && existing.status !== "candidate") {
      this.database.prepare("INSERT INTO stock_prep_buyer_blacklist_events (id,entry_id,actor,action,details_json,created_at_ms) VALUES (?,?,?,?,?,?)")
        .run(randomUUID(), existing.id, "agent", "candidate-submission-ignored", JSON.stringify({ reasonCode: input.reasonCode }), Date.now());
      return;
    }
    const id = existing?.id ?? randomUUID();
    const status = input.status;
    this.database.prepare(`INSERT INTO stock_prep_buyer_blacklist (id,store_id,buyer_key_hash,buyer_prefix_ciphertext,status,source,reason_code,summary,evidence_orders_json,rule_version,notes,created_at_ms,updated_at_ms)
      VALUES (?,?,?, ?,?,?,?,?,?,?,?,?,?) ON CONFLICT(store_id,buyer_key_hash) DO UPDATE SET buyer_prefix_ciphertext=excluded.buyer_prefix_ciphertext,status=excluded.status,source=excluded.source,reason_code=excluded.reason_code,summary=excluded.summary,evidence_orders_json=excluded.evidence_orders_json,rule_version=excluded.rule_version,notes=excluded.notes,updated_at_ms=excluded.updated_at_ms`)
      .run(id, storeId, hash, encryptSecret(buyerPrefix, this.config.ENCRYPTION_KEY), status, input.source, input.reasonCode, input.summary ?? null, JSON.stringify(input.evidenceOrders ?? []), input.ruleVersion ?? null, input.notes ?? null, now, now);
    this.database.prepare("INSERT INTO stock_prep_buyer_blacklist_events (id,entry_id,actor,action,details_json,created_at_ms) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), id, input.source, existing ? "updated" : "created", JSON.stringify({ reasonCode: input.reasonCode }), now);
  }

  /** Adds the buyer prefix parsed from a three-part posting number to the active blacklist. */
  public addOrderBuyerToBlacklist(storeId: string, postingNumber: string, reason: string): void {
    const buyerPrefix = buyerPrefixFromPostingNumber(postingNumber);
    if (!buyerPrefix) throw new Error("发货单号格式无效，无法读取买家编号");
    const hash = buyerPrefixHash(storeId, buyerPrefix, this.config.ENCRYPTION_KEY);
    const existing = this.database.prepare("SELECT id FROM stock_prep_buyer_blacklist WHERE store_id=? AND buyer_key_hash=?").get(storeId, hash) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();
    const now = Date.now();
    this.database.prepare(`INSERT INTO stock_prep_buyer_blacklist
      (id,store_id,buyer_key_hash,buyer_prefix_ciphertext,status,source,reason_code,summary,evidence_orders_json,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,'active','order','manual_order',?,?,?,?)
      ON CONFLICT(store_id,buyer_key_hash) DO UPDATE SET buyer_prefix_ciphertext=excluded.buyer_prefix_ciphertext,status='active',source='order',reason_code='manual_order',summary=excluded.summary,updated_at_ms=excluded.updated_at_ms`)
      .run(id, storeId, hash, encryptSecret(buyerPrefix, this.config.ENCRYPTION_KEY), reason.trim(), JSON.stringify([postingNumber]), now, now);
    this.database.prepare("INSERT INTO stock_prep_buyer_blacklist_events (id,entry_id,actor,action,details_json,created_at_ms) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), id, "manual", existing ? "activated" : "created", JSON.stringify({ postingNumber, buyerPrefix }), now);
  }

  /** Changes a candidate or active entry without allowing an Agent to perform this transition. */
  public updateBuyerBlacklist(storeId: string, id: string, status: "active" | "inactive", actor: string): void {
    const result = this.database.prepare("UPDATE stock_prep_buyer_blacklist SET status=?,updated_at_ms=? WHERE store_id=? AND id=?")
      .run(status, Date.now(), storeId, id);
    if (!result.changes) throw new Error("黑名单记录不存在");
    this.database.prepare("INSERT INTO stock_prep_buyer_blacklist_events (id,entry_id,actor,action,details_json,created_at_ms) VALUES (?,?,?,?,?,?)")
      .run(randomUUID(), id, actor, status, "{}", Date.now());
  }

  /** Returns the supplier names routed to the 1688 dropship cart. */
  public getDropshipSuppliers(): string[] {
    try {
      const value: unknown = JSON.parse(this.settings.get(DROPSHIP_SUPPLIERS_KEY) ?? "[]");
      return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))] : [];
    } catch { return []; }
  }

  /** Stores the local 1688 supplier-name allowlist. */
  public saveDropshipSupplierNames(names: string[]): string[] {
    const normalized = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    if (normalized.length > 100 || normalized.some((name) => name.length > 120)) throw new Error("供应商名单最多 100 家，每个名称不超过 120 个字符");
    this.settings.set(DROPSHIP_SUPPLIERS_KEY, JSON.stringify(normalized));
    return normalized;
  }

  public async saveStoreSource(storeId: string, url: string): Promise<{ url: string; tableId: string }> {
    const profile = this.getFeishuProfile();
    if (!profile) throw new Error("尚未连接飞书 CLI，请先在本机完成飞书授权");
    const resolved = parseCli<Record<string, unknown>>(await this.feishu(["base", "+url-resolve", "--url", url, "--as", "user"]));
    if (resolved.resource_type !== "bitable" || typeof resolved.base_token !== "string") throw new Error("链接不是飞书多维表格");
    const blocks = parseCli<{ blocks?: Array<{ id: string; type: string; name: string }> }>(await this.feishu(["base", "+base-block-list", "--base-token", resolved.base_token, "--type", "table", "--format", "json", "--as", "user"]));
    const targetId = typeof resolved.table_id === "string" ? resolved.table_id : typeof resolved.block_id === "string" ? resolved.block_id : null;
    const table = blocks.blocks?.find((item) => item.id === targetId) ?? blocks.blocks?.find((item) => item.name === "SKU映射") ?? (blocks.blocks?.length === 1 ? blocks.blocks[0] : undefined);
    if (!table?.id) throw new Error("多维表格中未找到唯一的 SKU映射数据表");
    const fields = parseCli<{ fields?: Array<{ name: string; type: string }> }>(await this.feishu(["base", "+field-list", "--base-token", resolved.base_token, "--table-id", table.id, "--as", "user"]));
    for (const name of ["货号", "1688商品链接", "1688 SKU ID"]) {
      if (!fields.fields?.some((field) => field.name === name && field.type === "text")) throw new Error(`SKU映射表缺少文本字段：${name}`);
    }
    this.database.prepare(`INSERT INTO store_sku_sources (store_id, source_url, base_token, table_id, updated_at_ms)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(store_id) DO UPDATE SET source_url=excluded.source_url,
      base_token=excluded.base_token, table_id=excluded.table_id, updated_at_ms=excluded.updated_at_ms`)
      .run(storeId, url, resolved.base_token, table.id, Date.now());
    return { url, tableId: table.id };
  }

  public async scan(storeId: string): Promise<StockPrepScanView> {
    const source = this.database.prepare("SELECT source_url,base_token,table_id FROM store_sku_sources WHERE store_id=?").get(storeId) as StockPrepStoreRow | undefined;
    if (!source) throw new Error("请先为该店铺配置飞书 SKU 映射表");
    const rows = this.database.prepare(`SELECT p.store_id,s.name AS store_name,p.posting_number,p.order_number,p.order_at_ms,pi.offer_id,pi.name,pi.quantity,
        image.primary_image_url AS image_url,states.state,states.error
      FROM postings p JOIN stores s ON s.id=p.store_id JOIN posting_items pi ON pi.posting_id=p.id
      LEFT JOIN product_images image ON image.store_id=p.store_id AND image.sku=pi.sku
      LEFT JOIN stock_prep_order_states states ON states.store_id=p.store_id AND states.posting_number=p.posting_number AND states.offer_id=pi.offer_id
      WHERE p.store_id=? AND s.platform='ozon' AND p.fulfillment_mode IN ('FBS','RFBS')
        AND p.status='awaiting_packaging' AND p.cancelled_at_ms IS NULL
      ORDER BY pi.offer_id,p.posting_number`).all(storeId) as OrderRow[];
    const mappings = await this.readMappings(source);
    const mappingCounts = new Map<string, number>();
    for (const mapping of mappings) mappingCounts.set(mapping.offerId, (mappingCounts.get(mapping.offerId) ?? 0) + 1);
    const mappingByOffer = new Map(mappings.map((mapping) => [mapping.offerId, mapping]));
    const orderTotals = new Map<string, number>();
    for (const row of rows) orderTotals.set(row.order_number, (orderTotals.get(row.order_number) ?? 0) + row.quantity);
    const buyerOrders = new Map<string, Map<string, number>>();
    const currentOrdersByBuyer = new Map<string, OrderRow[]>();
    for (const row of rows) {
      const prefix = buyerPrefixFromPostingNumber(row.posting_number);
      if (!prefix) continue;
      const orders = buyerOrders.get(prefix) ?? new Map<string, number>();
      orders.set(row.order_number, Math.min(orders.get(row.order_number) ?? Number.MAX_SAFE_INTEGER, row.order_at_ms));
      buyerOrders.set(prefix, orders);
      const buyerRows = currentOrdersByBuyer.get(prefix) ?? [];
      buyerRows.push(row);
      currentOrdersByBuyer.set(prefix, buyerRows);
    }
    const currentOrderIndexes = new Map<string, number>();
    for (const [prefix, orderNumbers] of buyerOrders) {
      [...orderNumbers].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0])).forEach(([orderNumber], index) => currentOrderIndexes.set(`${prefix}\u0000${orderNumber}`, index + 1));
    }
    const historyByBuyer = new Map<string, BuyerHistorySummary>();
    const riskByBuyerOrder = new Map<string, { level: BuyerRiskLevel; blacklistStatus: string | null; approved: boolean; currentOrderCount: number; currentOrderIndex: number | null }>();
    for (const row of rows) {
      const prefix = buyerPrefixFromPostingNumber(row.posting_number);
      const riskKey = prefix ?? `@${row.posting_number}`;
      const currentOrderCount = prefix ? buyerOrders.get(prefix)?.size ?? 1 : 1;
      const currentOrderIndex = prefix ? currentOrderIndexes.get(`${prefix}\u0000${row.order_number}`) ?? null : null;
      if (prefix && !historyByBuyer.has(prefix)) historyByBuyer.set(prefix, this.getBuyerHistorySummary(storeId, prefix, currentOrdersByBuyer.get(prefix) ?? []));
      const hash = prefix ? buyerSnapshotHash(this.database, storeId, prefix) : null;
      const approval = prefix ? this.database.prepare("SELECT snapshot_hash FROM stock_prep_risk_approvals WHERE store_id=? AND order_number=?").get(storeId, prefix) as { snapshot_hash: string } | undefined : undefined;
      const blacklistKey = prefix ? buyerPrefixHash(storeId, prefix, this.config.ENCRYPTION_KEY) : null;
      const blacklist = blacklistKey ? this.database.prepare("SELECT status FROM stock_prep_buyer_blacklist WHERE store_id=? AND buyer_key_hash=?").get(storeId, blacklistKey) as { status: string } | undefined : undefined;
      const previous = riskByBuyerOrder.get(riskKey);
      const active = previous?.level === "blacklist" || blacklist?.status === "active";
      let level: BuyerRiskLevel = "none";
      if (active) level = "blacklist";
      else if (orderTotals.get(row.order_number)! >= 2 || currentOrderCount > 1) level = "review";
      riskByBuyerOrder.set(riskKey, { level, blacklistStatus: active ? "active" : blacklist?.status ?? previous?.blacklistStatus ?? null, approved: Boolean(hash) && approval?.snapshot_hash === hash, currentOrderCount, currentOrderIndex });
    }
    const groups = new Map<string, StockPrepGroupView>();
    for (const row of rows) {
      const mapping = mappingByOffer.get(row.offer_id);
      const mappingError = !mapping ? "飞书未找到该货号" : mappingCounts.get(row.offer_id) !== 1 ? "飞书货号重复" : !valid1688Url(mapping.url) ? "1688 商品链接无效" : !/^\d+$/u.test(mapping.skuId) ? "1688 SKU ID 无效" : null;
      const validMapping = mapping && !mappingError ? mapping : null;
      const mapped = validMapping !== null;
      const orderState = row.state;
      const state: StockPrepState = mapped ? (orderState === "unmatched" ? "pending" : orderState ?? "pending") : orderState === "added" || orderState === "adding" || orderState === "failed" || orderState === "uncertain" ? orderState : "unmatched";
      if (!orderState) {
        this.database.prepare(`INSERT INTO stock_prep_order_states (store_id,posting_number,offer_id,state,error,updated_at_ms) VALUES (?,?,?,?,?,?)`)
          .run(storeId, row.posting_number, row.offer_id, state, mapped ? null : mappingError, Date.now());
      } else if (orderState === "pending" || orderState === "unmatched") {
        this.database.prepare("UPDATE stock_prep_order_states SET state=?,error=?,updated_at_ms=? WHERE store_id=? AND posting_number=? AND offer_id=?")
          .run(state, mapped ? null : mappingError, Date.now(), storeId, row.posting_number, row.offer_id);
      }
      const groupKey = validMapping ? `${validMapping.url}\u0000${validMapping.skuId}` : `unmatched:${row.offer_id}`;
      const currentError = mapped ? (state === "pending" ? null : row.error) : mappingError;
      const prefix = buyerPrefixFromPostingNumber(row.posting_number);
      const risk = riskByBuyerOrder.get(prefix ?? `@${row.posting_number}`)!;
      const risky = orderTotals.get(row.order_number)! >= 2;
      const group = groups.get(groupKey) ?? { offerUrl: validMapping?.url ?? null, offerId: row.offer_id, skuId: validMapping?.skuId ?? null, imageUrl: row.image_url, status: state, quantity: 0, orders: [], error: currentError };
      group.imageUrl ??= row.image_url;
      group.quantity += row.quantity;
      group.orders.push({ postingNumber: row.posting_number, orderNumber: row.order_number, buyerPrefix: prefix, offerId: row.offer_id, productName: row.name, imageUrl: row.image_url, quantity: row.quantity, orderQuantity: orderTotals.get(row.order_number)!, riskLevel: risk.level, blacklistStatus: risk.blacklistStatus, currentOrderCount: risk.currentOrderCount, currentOrderIndex: risk.currentOrderIndex, buyerHistory: prefix ? historyByBuyer.get(prefix)! : emptyBuyerHistory(), approved: risk.approved, state, error: currentError, selectedByDefault: state === "pending" && risk.level !== "blacklist" && (!risky && risk.currentOrderCount <= 1 || risk.approved) });
      if (group.status !== state) group.status = group.status === "unmatched" || state === "unmatched" ? "unmatched" : "pending";
      groups.set(groupKey, group);
    }
    const buyerHistorySync = this.database.prepare("SELECT state,from_at_ms,to_at_ms,processed_count,return_count,error,updated_at_ms FROM stock_prep_risk_sync WHERE store_id=?").get(storeId) as Record<string, unknown> | undefined;
    return { storeId, groups: [...groups.values()], buyerHistorySync: buyerHistorySync ?? null, lastOrderSyncAt: this.getLastOrderSyncAt(storeId) };
  }

  private getBuyerHistorySummary(storeId: string, buyerPrefix: string, currentOrders: OrderRow[]): BuyerHistorySummary {
    const since = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const posts = this.database.prepare(`SELECT posting_number,order_number,status,order_at_ms,cancellation_initiator,cancellation_type
      FROM postings WHERE store_id=? AND posting_number LIKE ? AND fulfillment_mode IN ('FBS','RFBS') AND order_at_ms>=?
      ORDER BY order_at_ms DESC,posting_number DESC`).all(storeId, `${buyerPrefix}-%`, since) as Array<{ posting_number: string; order_number: string; status: string; order_at_ms: number; cancellation_initiator: string | null; cancellation_type: string | null }>;
    const currentPostingNumbers = new Set(currentOrders.map((order) => order.posting_number));
    const currentOrderNumbers = new Set(currentOrders.map((order) => order.order_number));
    const historicalPosts = posts.filter((post) => !currentPostingNumbers.has(post.posting_number) && !currentOrderNumbers.has(post.order_number));
    const orderMap = new Map<string, (typeof posts)[number]>();
    for (const post of historicalPosts) if (!orderMap.has(post.order_number)) orderMap.set(post.order_number, post);
    const returns = this.database.prepare(`SELECT r.return_id,r.posting_number,r.order_number,r.quantity,r.return_type,r.returned_at_ms,r.return_reason,r.visual_status
      FROM stock_prep_buyer_returns r JOIN postings p ON p.store_id=r.store_id AND (p.posting_number=r.posting_number OR (r.order_number IS NOT NULL AND p.order_number=r.order_number))
      WHERE r.store_id=? AND p.posting_number LIKE ? AND p.order_at_ms>=?`).all(storeId, `${buyerPrefix}-%`, since) as Array<{ return_id: string; posting_number: string; order_number: string | null; quantity: number; return_type: string; returned_at_ms: number | null; return_reason: string | null; visual_status: string | null }>;
    const historicalReturns = returns.filter((item) => !currentPostingNumbers.has(item.posting_number) && !(item.order_number && currentOrderNumbers.has(item.order_number)));
    const returnsByOrder = new Map<string, typeof returns>();
    const historicalOrderByPosting = new Map(historicalPosts.map((post) => [post.posting_number, post.order_number]));
    for (const item of historicalReturns) {
      const key = item.order_number ?? historicalOrderByPosting.get(item.posting_number) ?? item.posting_number;
      const list = returnsByOrder.get(key) ?? [];
      if (!list.some((existing) => existing.return_id === item.return_id)) list.push(item);
      returnsByOrder.set(key, list);
    }
    const recentOrders = [...orderMap.values()].slice(0, 3).map((post) => {
      const orderReturns = returnsByOrder.get(post.order_number) ?? [];
      return {
        postingNumber: post.posting_number,
        status: post.status,
        orderAt: post.order_at_ms,
        cancellationInitiator: post.cancellation_initiator,
        cancellationType: post.cancellation_type,
        returns: orderReturns.map((item) => ({ type: item.return_type, reason: item.return_reason, status: item.visual_status, quantity: item.quantity })),
      };
    });
    const cancelledOrders = [...orderMap.values()].filter((post) => /cancel/iu.test(post.status)).length;
    const deliveredOrders = [...orderMap.values()].filter((post) => /deliver/iu.test(post.status) && !/cancel/iu.test(post.status)).length;
    const refusalOrderNumbers = new Set(historicalReturns.filter((item) => item.return_type === "PartialReturn" || /отказ|refus/iu.test(item.return_reason ?? "")).map((item) => item.order_number ?? item.posting_number));
    const latest = recentOrders[0];
    const latestReturn = latest?.returns[0];
    const latestOutcome = latestReturn ? `退货：${latestReturn.reason ?? latestReturn.type}` : latest ? latest.status : null;
    const orderSequenceByPostingNumber = Object.fromEntries(historicalPosts.map((post) => [post.posting_number, [...orderMap.values()].filter((order) => order.order_at_ms < post.order_at_ms || (order.order_at_ms === post.order_at_ms && order.order_number.localeCompare(post.order_number) <= 0)).length]));
    const currentOrderDates = new Map<string, number>();
    for (const order of currentOrders) currentOrderDates.set(order.order_number, Math.min(currentOrderDates.get(order.order_number) ?? Number.MAX_SAFE_INTEGER, order.order_at_ms));
    const orderedCurrentOrders = [...currentOrderDates].sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]));
    for (const [index, [orderNumber, orderAt]] of orderedCurrentOrders.entries()) {
      const historyBeforeOrder = [...orderMap.values()].filter((order) => order.order_at_ms < orderAt || (order.order_at_ms === orderAt && order.order_number.localeCompare(orderNumber) < 0)).length;
      const sequence = historyBeforeOrder + index + 1;
      for (const order of currentOrders) if (order.order_number === orderNumber) orderSequenceByPostingNumber[order.posting_number] = sequence;
    }
    const syncRow = this.database.prepare("SELECT state,error FROM stock_prep_risk_sync WHERE store_id=?").get(storeId) as { state: BuyerHistorySummary["syncState"]; error: string | null } | undefined;
    return {
      syncState: syncRow?.state ?? "not_started", syncError: syncRow?.error ?? null, ordersInYear: orderMap.size, deliveredOrders, cancelledOrders,
      refusalOrders: refusalOrderNumbers.size, returnCount: new Set(historicalReturns.map((item) => item.return_id)).size,
      returnedPieces: historicalReturns.reduce((sum, item) => sum + item.quantity, 0), latestOutcome, latestAt: latest?.orderAt ?? null,
      orderSequenceByPostingNumber, recentOrders,
    };
  }

  public async createBatch(storeId: string, keys: Array<{ postingNumber: string; offerId: string }>): Promise<{ id: string; status: string }> {
    if (this.batchRunning) throw new Error("已有加购批次正在执行");
    this.batchRunning = true;
    try {
    const uniqueKeys = [...new Map(keys.map((key) => [`${key.postingNumber}\u0000${key.offerId}`, key])).values()];
    if (!uniqueKeys.length) throw new Error("请至少选择一笔待采购订单");
    const placeholders = uniqueKeys.map(() => "(?, ?)").join(",");
    const parameters = uniqueKeys.flatMap((key) => [key.postingNumber, key.offerId]);
    const selected = this.database.prepare(`SELECT p.store_id,p.posting_number,pi.offer_id,pi.quantity FROM postings p JOIN posting_items pi ON pi.posting_id=p.id
      WHERE p.store_id=? AND p.status='awaiting_packaging' AND p.cancelled_at_ms IS NULL AND p.fulfillment_mode IN ('FBS','RFBS')
        AND (p.posting_number,pi.offer_id) IN (${placeholders})`).all(storeId, ...parameters) as Array<{ posting_number: string; offer_id: string; quantity: number }>;
    if (selected.length !== uniqueKeys.length) throw new Error("部分订单已不符合待采购条件，请重新扫描");
    const scan = await this.scan(storeId);
    const orderMap = new Map<string, { group: { offerUrl: string | null; skuId: string | null; offerId: string }; order: StockPrepOrderView }>();
    for (const group of scan.groups) for (const order of group.orders) orderMap.set(`${order.postingNumber}\u0000${order.offerId}`, { group, order });
    const itemGroups = new Map<string, { url: string; skuId: string; offerId: string; quantity: number; keys: string[] }>();
    for (const key of uniqueKeys) {
      const match = orderMap.get(`${key.postingNumber}\u0000${key.offerId}`);
      if (!match || !match.group.offerUrl || !match.group.skuId || !["pending", "failed"].includes(match.order.state)) throw new Error(`订单 ${key.postingNumber} 当前不能加购`);
      if (match.order.riskLevel === "blacklist") throw new Error(`订单 ${match.order.orderNumber} 的买家在黑名单中，禁止加购`);
      if (match.order.riskLevel === "review" && !match.order.approved) throw new Error(`发货单 ${match.order.postingNumber} 属于买家风险待确认组，请先人工确认`);
      const id = `${match.group.offerUrl}\u0000${match.group.skuId}`;
      const group = itemGroups.get(id) ?? { url: match.group.offerUrl, skuId: match.group.skuId, offerId: key.offerId, quantity: 0, keys: [] };
      group.quantity += match.order.quantity;
      group.keys.push(`${key.postingNumber}\u0000${key.offerId}`);
      itemGroups.set(id, group);
    }
    const batchId = randomUUID();
    const now = Date.now();
    this.database.transaction(() => {
      this.database.prepare("INSERT INTO stock_prep_batches (id,store_id,status,total_count,created_at_ms) VALUES (?,?,'queued',?,?)")
        .run(batchId, storeId, itemGroups.size, now);
      const insert = this.database.prepare(`INSERT INTO stock_prep_batch_items (id,batch_id,offer_url,offer_id,sku_id,quantity,order_keys_json,status,created_at_ms,updated_at_ms)
        VALUES (?,?,?,?,?,?,?,'queued',?,?)`);
      const update = this.database.prepare("UPDATE stock_prep_order_states SET state='adding',batch_id=?,error=NULL,updated_at_ms=? WHERE store_id=? AND posting_number=? AND offer_id=? AND state IN ('pending','failed')");
      for (const item of itemGroups.values()) {
        insert.run(randomUUID(), batchId, item.url, item.offerId, item.skuId, item.quantity, JSON.stringify(item.keys), now, now);
        for (const key of item.keys) {
          const [postingNumber, offerId] = key.split("\u0000") as [string, string];
          if (update.run(batchId, now, storeId, postingNumber, offerId).changes !== 1) throw new Error(`订单 ${postingNumber} 的采购状态已变化，请重新扫描`);
        }
      }
    })();
    void this.processBatch(batchId, storeId);
    return { id: batchId, status: "queued" };
    } catch (error) {
      this.batchRunning = false;
      throw error;
    }
  }

  /** Approves the current pending-item snapshot for every order sharing one buyer prefix. */
  public approveRiskOrder(storeId: string, buyerPrefix: string): void {
    if (!/^\d{3,30}$/u.test(buyerPrefix)) throw new Error("买家编号格式无效");
    const snapshotHash = buyerSnapshotHash(this.database, storeId, buyerPrefix);
    if (!snapshotHash) throw new Error("该买家已没有待打包订单");
    this.database.prepare(`INSERT INTO stock_prep_risk_approvals (store_id,order_number,snapshot_hash,approved_at_ms)
      VALUES (?,?,?,?) ON CONFLICT(store_id,order_number) DO UPDATE SET snapshot_hash=excluded.snapshot_hash,approved_at_ms=excluded.approved_at_ms`)
      .run(storeId, buyerPrefix, snapshotHash, Date.now());
  }

  /** Revokes approval for all current orders sharing the buyer prefix. */
  public revokeRiskOrderApproval(storeId: string, buyerPrefix: string): void {
    if (!/^\d{3,30}$/u.test(buyerPrefix)) throw new Error("买家编号格式无效");
    const result = this.database.prepare("DELETE FROM stock_prep_risk_approvals WHERE store_id=? AND order_number=?")
      .run(storeId, buyerPrefix);
    if (!result.changes) throw new Error("订单当前没有人工放行状态");
  }

  public getBatch(id: string): Record<string, unknown> | null {
    const batch = this.database.prepare("SELECT * FROM stock_prep_batches WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!batch) return null;
    const items = this.database.prepare("SELECT * FROM stock_prep_batch_items WHERE batch_id=? ORDER BY created_at_ms").all(id);
    return { ...batch, items };
  }

  public getLatestBatch(storeId: string): Record<string, unknown> | null {
    const batch = this.database.prepare("SELECT id FROM stock_prep_batches WHERE store_id=? ORDER BY created_at_ms DESC LIMIT 1").get(storeId) as { id: string } | undefined;
    return batch ? this.getBatch(batch.id) : null;
  }

  public resetOrders(storeId: string, keys: Array<{ postingNumber: string; offerId: string }>): number {
    const update = this.database.prepare(`UPDATE stock_prep_order_states SET state='pending',batch_id=NULL,error=NULL,updated_at_ms=?
      WHERE store_id=? AND posting_number=? AND offer_id=? AND state IN ('added','failed')`);
    let count = 0;
    this.database.transaction(() => { for (const key of keys) count += update.run(Date.now(), storeId, key.postingNumber, key.offerId).changes; })();
    return count;
  }

  /** Marks selected mapped orders as manually confirmed in the 1688 cart. */
  public async markOrdersAdded(storeId: string, keys: Array<{ postingNumber: string; offerId: string }>): Promise<number> {
    const snapshot = await this.scan(storeId);
    const orders = new Map(snapshot.groups.flatMap((group) => group.orders.map((order) => [`${order.postingNumber}\u0000${order.offerId}`, order] as const)));
    for (const key of keys) {
      const order = orders.get(`${key.postingNumber}\u0000${key.offerId}`);
      if (!order || !["pending", "failed", "uncertain"].includes(order.state)) throw new Error(`订单 ${key.postingNumber} 当前不能人工标记已加购`);
      if (order.riskLevel === "blacklist") throw new Error(`订单 ${key.postingNumber} 命中买家黑名单，不能标记`);
      if (order.riskLevel === "review" && !order.approved) throw new Error(`发货单 ${key.postingNumber} 需先完成人工风险确认`);
    }
    const update = this.database.prepare(`UPDATE stock_prep_order_states SET state='added',batch_id=NULL,error='人工确认已加入1688购物车',updated_at_ms=?
      WHERE store_id=? AND posting_number=? AND offer_id=? AND state IN ('pending','failed','uncertain')`);
    let count = 0;
    this.database.transaction(() => { for (const key of keys) count += update.run(Date.now(), storeId, key.postingNumber, key.offerId).changes; })();
    return count;
  }

  /** Returns current shipping units with the number of mapped SKUs in each posting. */
  public listFulfillmentPostings(storeId: string): Array<Record<string, unknown>> {
    const rows = this.database.prepare(`SELECT p.posting_number, p.status, p.fulfillment_mode, p.shipment_deadline_at_ms,
      COUNT(DISTINCT pi.offer_id) AS sku_count, SUM(pi.quantity) AS piece_count,
      COUNT(DISTINCT CASE WHEN states.state='added' THEN pi.offer_id END) AS added_sku_count,
      GROUP_CONCAT(pi.offer_id, '、') AS offer_ids
      FROM postings p JOIN posting_items pi ON pi.posting_id=p.id
      LEFT JOIN stock_prep_order_states states ON states.store_id=p.store_id AND states.posting_number=p.posting_number AND states.offer_id=pi.offer_id
      WHERE p.store_id=? AND p.fulfillment_mode IN ('FBS','RFBS') AND p.cancelled_at_ms IS NULL
        AND p.status IN ('awaiting_packaging','awaiting_deliver')
      GROUP BY p.posting_number ORDER BY CASE
        WHEN p.status='awaiting_packaging' AND COUNT(DISTINCT CASE WHEN states.state='added' THEN pi.offer_id END)=COUNT(DISTINCT pi.offer_id) THEN 0
      WHEN p.status='awaiting_packaging' THEN 1 ELSE 2 END,p.shipment_deadline_at_ms`).all(storeId) as Array<Record<string, unknown>>;
    return rows.map((posting) => {
      let prepare_block_reason: string | null = null;
      if (posting.status !== "awaiting_packaging") prepare_block_reason = "Ozon状态已变化，请刷新订单";
      else if (Number(posting.sku_count) !== 1) prepare_block_reason = "多SKU订单，请到Ozon后台人工备货";
      else if (Number(posting.piece_count) !== 1) prepare_block_reason = "多件订单，请到Ozon后台人工备货";
      else if (Number(posting.added_sku_count) !== 1) prepare_block_reason = "商品尚未标记已加购";
      return { ...posting, can_prepare: prepare_block_reason === null, prepare_block_reason };
    });
  }

  /** Releases uncertain orders only after a separate cart check confirmed no quantity was added. */
  public resolveUncertainAsFailed(storeId: string, keys: Array<{ postingNumber: string; offerId: string }>): number {
    const update = this.database.prepare(`UPDATE stock_prep_order_states SET state='failed',error='人工核对购物车后确认未增加数量',updated_at_ms=?
      WHERE store_id=? AND posting_number=? AND offer_id=? AND state='uncertain'`);
    let count = 0;
    this.database.transaction(() => { for (const key of keys) count += update.run(Date.now(), storeId, key.postingNumber, key.offerId).changes; })();
    return count;
  }

  private async readMappings(source: StockPrepStoreRow): Promise<Mapping[]> {
    const pageSize = 200;
    const records: Array<Record<string, unknown>> = [];
    for (let offset = 0; ; offset += pageSize) {
      const output = await this.feishu(["base", "+record-list", "--base-token", source.base_token, "--table-id", source.table_id,
        "--field-id", "货号", "--field-id", "1688商品链接", "--field-id", "1688 SKU ID", "--limit", String(pageSize), "--offset", String(offset), "--format", "json", "--as", "user"]);
      const page = parseRecords(output);
      records.push(...page);
      if (page.length < pageSize) break;
    }
    return records.map((row) => ({ offerId: String(row["货号"] ?? "").trim(), url: normalizeMappingUrl(row["1688商品链接"]), skuId: String(row["1688 SKU ID"] ?? "").trim() })).filter((row) => row.offerId);
  }

  private getFeishuProfile(): string | null {
    if ((this.runtime.platform ?? process.platform) === "win32") return this.settings.get(PROFILE_KEY);
    return "ozon-team-wiki";
  }

  /** Reuses an existing Lark CLI profile for this App ID, avoiding duplicate App ID registration. */
  private async resolveWindowsFeishuProfile(createIfMissing = false): Promise<string | null> {
    const appId = this.settings.get(APP_ID_KEY);
    const secretValue = this.settings.get(APP_SECRET_KEY);
    if (!appId || !secretValue) return null;
    try {
      const profiles = JSON.parse(await this.feishu(["profile", "list"], undefined, undefined, false)) as Array<{ name?: string; appId?: string }>;
      const existing = profiles.find((item) => item.appId === appId && item.name);
      if (existing?.name) {
        this.settings.set(PROFILE_KEY, existing.name);
        return existing.name;
      }
    } catch { /* A new profile may not exist yet; create it below only when requested. */ }
    if (!createIfMissing) return null;
    const profile = `ozon-stock-prep-${randomUUID().slice(0, 8)}`;
    const secret = decryptSecret(secretValue, this.config.ENCRYPTION_KEY);
    await this.feishu(["profile", "add", "--name", profile, "--app-id", appId, "--app-secret-stdin"], undefined, secret, false);
    this.settings.set(PROFILE_KEY, profile);
    return profile;
  }

  private getFeishuCliPath(): string {
    const packageJson = require.resolve("@larksuite/cli/package.json");
    return join(dirname(packageJson), "bin", (this.runtime.platform ?? process.platform) === "win32" ? "lark-cli.exe" : "lark-cli");
  }

  private async feishu(args: string[], explicitProfile?: string, stdinSecret?: string, includeProfile = true): Promise<string> {
    const profile = explicitProfile ?? this.getFeishuProfile();
    if (includeProfile && !profile) throw new Error("飞书尚未授权");
    if (this.runtime.feishu) return this.runtime.feishu(args, includeProfile ? profile : null, stdinSecret);
    const executable = this.getFeishuCliPath();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, includeProfile ? [...args, "--profile", profile!] : args, { shell: false, windowsHide: true, stdio: [stdinSecret ? "pipe" : "ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = []; const stderr: Buffer[] = [];
      child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
      if (stdinSecret) { child.stdin!.write(`${stdinSecret}\n`); child.stdin!.end(); }
      child.once("error", () => reject(new Error("未找到飞书 CLI，请重启工具后重试")));
      child.once("close", (code) => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8")) : reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `飞书 CLI 退出码 ${code}`)));
    });
  }

  private runBrowser(session: string, args: string[]): Promise<string> {
    return this.runtime.openCli ? this.runtime.openCli(session, args) : runOpenCli(defaultOpenCliPath(), ["browser", session, ...args]);
  }

  private async processBatch(batchId: string, storeId: string): Promise<void> {
    const now = Date.now();
    this.database.prepare("UPDATE stock_prep_batches SET status='running',started_at_ms=? WHERE id=?").run(now, batchId);
    const session = `stock-prep-${batchId.slice(0, 8)}`;
    let cartMutationStarted = false;
    try {
      const items = this.database.prepare("SELECT * FROM stock_prep_batch_items WHERE batch_id=? ORDER BY created_at_ms").all(batchId) as StockPrepBatchItemRow[];
      const targets: ResolvedSkuTarget[] = [];
      for (const item of items) {
        try {
          targets.push(await this.resolveSkuTarget(session, item));
        } catch (error) {
          this.finishBatchItem(batchId, storeId, item, "failed", error instanceof Error ? error.message : "1688 SKU 解析失败");
        }
      }

      const before = targets.length ? await this.cartQuantitiesByMode(session, targets) : new Map<string, CartModeQuantities>();
      const attempted: ResolvedSkuTarget[] = [];
      for (const target of targets) {
        try {
          await this.addResolvedSku(session, target);
          attempted.push(target);
          cartMutationStarted = true;
        } catch (error) {
          const uncertain = error instanceof Error && error.message.startsWith("UNCERTAIN:");
          const message = error instanceof Error ? error.message.replace(/^UNCERTAIN:/u, "") : "1688 加购失败";
          if (uncertain) {
            attempted.push(target);
            cartMutationStarted = true;
          }
          else this.finishBatchItem(batchId, storeId, target, "failed", message);
        }
      }

      const attemptedByCartKey = new Map<string, ResolvedSkuTarget[]>();
      for (const target of attempted) {
        const group = attemptedByCartKey.get(target.cartKey) ?? [];
        group.push(target);
        attemptedByCartKey.set(target.cartKey, group);
      }
      const expectedMinimums = new Map([...attemptedByCartKey].map(([cartKey, group]) => [
        cartKey,
        (before.get(cartKey)?.[group[0]!.dropship ? "dropship" : "wholesale"] ?? 0) + group.reduce((sum, target) => sum + target.quantity, 0),
      ]));
      const after: Map<string, CartModeQuantities> = attempted.length ? await this.cartQuantitiesByMode(session, attempted, expectedMinimums) : new Map();
      for (const [cartKey, group] of attemptedByCartKey) {
        const dropship = group[0]!.dropship;
        const mode = dropship ? "dropship" : "wholesale";
        const otherMode = dropship ? "wholesale" : "dropship";
        const beforeQuantity = before.get(cartKey)?.[mode] ?? 0;
        const afterQuantity = after.get(cartKey)?.[mode] ?? 0;
        const otherCartUnchanged = (after.get(cartKey)?.[otherMode] ?? 0) === (before.get(cartKey)?.[otherMode] ?? 0);
        const expectedDelta = group.reduce((sum, target) => sum + target.quantity, 0);
        for (const target of group) {
          if (afterQuantity - beforeQuantity === expectedDelta && otherCartUnchanged) {
            this.finishBatchItem(batchId, storeId, target, "added", null, beforeQuantity, afterQuantity);
          } else {
            const otherBefore = before.get(cartKey)?.[otherMode] ?? 0;
            const otherAfter = after.get(cartKey)?.[otherMode] ?? 0;
            this.finishBatchItem(batchId, storeId, target, "uncertain", `目标购物车数量从 ${beforeQuantity} 变为 ${afterQuantity}，预期增加 ${expectedDelta}；另一购物车从 ${otherBefore} 变为 ${otherAfter}`, beforeQuantity, afterQuantity);
          }
        }
      }
      const failed = this.database.prepare("SELECT COUNT(*) AS count FROM stock_prep_batch_items WHERE batch_id=? AND status<>'added'").get(batchId) as { count: number };
      this.database.prepare("UPDATE stock_prep_batches SET status=?,finished_at_ms=? WHERE id=?").run(failed.count ? "completed_with_errors" : "completed", Date.now(), batchId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "1688 购物车校验失败";
      const unfinished = this.database.prepare("SELECT * FROM stock_prep_batch_items WHERE batch_id=? AND status IN ('queued','running')").all(batchId) as StockPrepBatchItemRow[];
      for (const item of unfinished) this.finishBatchItem(batchId, storeId, item, cartMutationStarted ? "uncertain" : "failed", message);
      this.database.prepare("UPDATE stock_prep_batches SET status='completed_with_errors',finished_at_ms=? WHERE id=?").run(Date.now(), batchId);
    } finally {
      await this.runBrowser(session, ["close"]).catch(() => undefined);
      this.batchRunning = false;
    }
  }

  private async resolveSkuTarget(session: string, item: StockPrepBatchItemRow): Promise<ResolvedSkuTarget> {
    const productId = extractOfferId(item.offer_url);
    if (!productId) throw new Error("1688 商品链接格式无效");
    const pageUrl = `https://detail.1688.com/offer/${productId}.html`;
    await this.runBrowser(session, ["open", pageUrl]);
    const detail = parseCli<{ url: string; skuId: string | null; attributes: string[]; supplierName: string }>(await this.runBrowser(session, ["eval", String.raw`(() => {
      const desiredSkuId=${JSON.stringify(item.sku_id)};
      const decode=(value)=>{const node=document.createElement('textarea');node.innerHTML=String(value??'');return node.value.trim()};
      const scripts=[...document.scripts].map((node)=>node.textContent||'').join('\n');
      const matches=scripts.match(/\{[^{}]*"skuId"\s*:\s*"?\d+"?[^{}]*\}/g)||[];
      const sku=matches.map((text)=>{try{return JSON.parse(text)}catch{return null}}).find((value)=>value&&String(value.skuId)===desiredSkuId);
      const normalizedScripts=scripts.replaceAll(String.fromCharCode(92)+'"','"');
      const supplierNames=[...new Set([...normalizedScripts.matchAll(/"companyName"\s*:\s*"([^"]+)"/gu)].map((match)=>match[1]?.trim()).filter(Boolean))];
      const supplierName=supplierNames.length===1?supplierNames[0]:'';
      if(!sku)return {url:location.href,skuId:null,attributes:[],supplierName};
      const explicit=[sku.sku1,sku.sku2].map(decode).filter(Boolean);
      const specAttrs=decode(sku.specAttrs).split(/\s*>\s*/u).map((value)=>value.trim()).filter(Boolean);
      return {url:location.href,skuId:String(sku.skuId),attributes:explicit.length>=2?explicit:specAttrs,supplierName};
    })()`]));
    if (detail.url !== pageUrl) throw new Error(`1688 商品页地址不匹配，目标商品 ${productId} 未能打开`);
    if (detail.skuId !== item.sku_id) throw new Error(`未匹配到 SKU：商品页不存在 SKU ID ${item.sku_id}，请检查飞书映射`);
    if (!detail.supplierName) throw new Error("无法识别 1688 供应商名称，已阻止加购");
    if (detail.attributes.length < 2 || detail.attributes.some((value) => !value.trim())) throw new Error(`SKU ${item.sku_id} 的颜色或尺码规格信息不完整，请检查商品页面`);
    const attributes = detail.attributes.map((value) => value.trim());
    const dropship = this.getDropshipSuppliers().some((name) => name.localeCompare(detail.supplierName, undefined, { sensitivity: "base" }) === 0);
    return { ...item, productId, attributes, supplierName: detail.supplierName, dropship, cartKey: `${productId}\u0000${attributes.join("\u0000")}` };
  }

  private async addResolvedSku(session: string, target: ResolvedSkuTarget): Promise<void> {
    const pageUrl = `https://detail.1688.com/offer/${target.productId}.html`;
    const [color, size] = target.attributes;
    let clickStarted = false;
    try {
      this.database.prepare("UPDATE stock_prep_batch_items SET status='running',updated_at_ms=? WHERE id=? AND status='queued'").run(Date.now(), target.id);
      await this.runBrowser(session, ["open", pageUrl]);
      if (target.dropship) {
        const opened = parseCli<{ clicked: boolean; count: number }>(await this.runBrowser(session, ["eval", String.raw`(() => {
          const buttons=[...document.querySelectorAll('button[data-click="DX_ORDER"]')].filter((button)=>button.innerText?.trim()==='代发下单'&&!button.disabled&&(button.offsetWidth||button.offsetHeight||button.getClientRects().length));
          if(buttons.length!==1)return {clicked:false,count:buttons.length};buttons[0].click();return {clicked:true,count:1};
        })()`]));
        if (!opened.clicked || opened.count !== 1) throw new Error(`“代发下单”入口无法唯一确认（匹配 ${opened.count} 个）`);
        const frameIndex = await this.findDropshipSkuFrame(session);
        const frameArgs = (script: string): string[] => ["eval", script, "--frame", String(frameIndex)];
        const colorResult = parseCli<{ found: boolean; active: boolean }>(await this.runBrowser(session, frameArgs(String.raw`(() => {
          const target=${JSON.stringify(color)};const button=[...document.querySelectorAll('button.sku-filter-button')].find((node)=>(node.querySelector('.label-name')||node).textContent?.trim()===target);
          if(!button)return {found:false,active:false};if(!button.classList.contains('active'))button.click();return {found:true,active:button.classList.contains('active')};
        })()`)));
        if (!colorResult.found) throw new Error(`未匹配到颜色规格：代发弹层中不存在“${color}”`);
        if (!colorResult.active) throw new Error(`颜色规格选择失败：代发弹层未能选中“${color}”`);
        await (this.runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(250);
        const filled = parseCli<{ color: string | null; size: string; visibleSizes: string[]; filled: boolean; actual: string }>(await this.runBrowser(session, frameArgs(String.raw`(() => {
          const expectedColor=${JSON.stringify(color)};const expectedSize=${JSON.stringify(size)};const quantity=${target.quantity};
          const active=[...document.querySelectorAll('button.sku-filter-button')].find((node)=>node.classList.contains('active'));
          const activeColor=(active?.querySelector('.label-name')||active)?.textContent?.trim()||null;
          const normalizeSize=(value)=>String(value??'').trim().split(/体重/u)[0].trim();
          const rows=[...document.querySelectorAll('.expand-view-item')];
          const row=rows.find((node)=>normalizeSize((node.querySelector('.item-label')||node).textContent)===expectedSize);
          const input=row?.querySelector('input.ant-input-number-input');if(!input)return {color:activeColor,size:'',visibleSizes:rows.map((node)=>normalizeSize((node.querySelector('.item-label')||node).textContent)),filled:false,actual:''};
          const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;if(!setter)return {color:activeColor,size:expectedSize,visibleSizes:rows.map((node)=>normalizeSize((node.querySelector('.item-label')||node).textContent)),filled:false,actual:input.value};
          setter.call(input,String(quantity));input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:String(quantity)}));input.dispatchEvent(new Event('change',{bubbles:true}));input.dispatchEvent(new FocusEvent('blur',{bubbles:true}));
          return {color:activeColor,size:expectedSize,visibleSizes:rows.map((node)=>normalizeSize((node.querySelector('.item-label')||node).textContent)),filled:true,actual:input.value};
        })()`)));
        if (filled.color !== color) throw new Error(`颜色规格校验失败：预期“${color}”，页面当前为“${filled.color ?? "未选择"}”`);
        if (filled.size !== size) throw new Error(`未匹配到可购买尺码“${size}”；页面可选尺码：${filled.visibleSizes?.join("、") || "无"}`);
        if (!filled.filled) throw new Error(`数量输入失败：尺码“${size}”没有可用数量输入框`);
        if (Number(filled.actual) !== target.quantity) throw new Error(`数量校验失败：目标 SKU ${target.sku_id} 需要 ${target.quantity} 件，页面实际为 ${filled.actual || "空"}`);
        await (this.runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(750);
        const prepared = parseCli<{ buttonCount: number; colorActive: boolean; sizeFound: boolean; actual: string }>(await this.runBrowser(session, frameArgs(String.raw`(() => {
          const expectedColor=${JSON.stringify(color)};const expectedSize=${JSON.stringify(size)};
          const colorButton=[...document.querySelectorAll('button.sku-filter-button')].find((node)=>(node.querySelector('.label-name')||node).textContent?.trim()===expectedColor);
          const normalizeSize=(value)=>String(value??'').trim().split(/体重/u)[0].trim();
          const row=[...document.querySelectorAll('.expand-view-item')].find((node)=>normalizeSize((node.querySelector('.item-label')||node).textContent)===expectedSize);
          const buttons=[...document.querySelectorAll('button')].filter((button)=>button.innerText?.trim()==='加采购车'&&!button.disabled&&(button.offsetWidth||button.offsetHeight||button.getClientRects().length));
          return {buttonCount:buttons.length,colorActive:Boolean(colorButton?.classList.contains('active')),sizeFound:Boolean(row),actual:row?.querySelector('input.ant-input-number-input')?.value??''};
        })()`)));
        if (prepared.buttonCount !== 1) throw new Error(`加购按钮定位失败：代发弹层中找到 ${prepared.buttonCount} 个“加采购车”按钮`);
        if (!prepared.colorActive) throw new Error(`颜色规格校验失败：提交前“${color}”未处于选中状态`);
        if (!prepared.sizeFound) throw new Error(`尺码规格校验失败：提交前未找到“${size}”`);
        if (Number(prepared.actual) !== target.quantity) throw new Error(`数量校验失败：目标 SKU ${target.sku_id} 需要 ${target.quantity} 件，页面实际为 ${prepared.actual || "空"}`);
        clickStarted = true;
        const click = parseCli<{ clicked: boolean; count: number }>(await this.runBrowser(session, frameArgs(String.raw`(() => {
          const buttons=[...document.querySelectorAll('button')].filter((button)=>button.innerText?.trim()==='加采购车'&&!button.disabled&&(button.offsetWidth||button.offsetHeight||button.getClientRects().length));
          if(buttons.length!==1)return {clicked:false,count:buttons.length};buttons[0].click();return {clicked:true,count:1};
        })()`)));
        if (!click.clicked || click.count !== 1) throw new Error(`代发弹层“加采购车”按钮无法唯一确认（匹配 ${click.count} 个）`);
        return;
      }
      const colorResult = parseCli<{ found: boolean }>(await this.runBrowser(session, ["eval", String.raw`(() => {
        const target=${JSON.stringify(color)};const exact=(value)=>value?.textContent?.trim()===target;
        const button=[...document.querySelectorAll('.sku-filter-button')].find((node)=>exact(node.querySelector('.label-name')||node));
        if(!button)return {found:false};if(!button.classList.contains('active'))button.click();return {found:true};
      })()`]));
      if (!colorResult.found) throw new Error(`未匹配到颜色规格：商品页没有“${color}”`);
      await (this.runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(250);
      const selected = parseCli<{ url: string; color: string | null; size: string; skuId: string | null; attributes: string[]; availableQuantity: number | null; visibleSizes: string[]; inputIndex: number }>(await this.runBrowser(session, ["eval", String.raw`(() => {
        const expectedColor=${JSON.stringify(color)};const expectedSize=${JSON.stringify(size)};
        const desiredSkuId=${JSON.stringify(target.sku_id)};
        const active=[...document.querySelectorAll('.sku-filter-button')].find((node)=>node.classList.contains('active'));
        const activeColor=(active?.querySelector('.label-name')||active)?.textContent?.trim()||null;
        const normalizeSize=(value)=>String(value??'').trim().split(/体重/u)[0].trim();
        const rows=[...document.querySelectorAll('.expand-view-item')];
        const row=rows.find((node)=>normalizeSize((node.querySelector('.item-label')||node).textContent)===expectedSize);
        const input=row?.querySelector('input.ant-input-number-input');
        const decode=(value)=>{const node=document.createElement('textarea');node.innerHTML=String(value??'');return node.value.trim()};
        const scripts=[...document.scripts].map((node)=>node.textContent||'').join('\n');
        const matches=scripts.match(/\{[^{}]*"skuId"\s*:\s*"?\d+"?[^{}]*\}/g)||[];
        const sku=matches.map((text)=>{try{return JSON.parse(text)}catch{return null}}).find((value)=>value&&String(value.skuId)===desiredSkuId);
        const explicit=sku?[sku.sku1,sku.sku2].map(decode).filter(Boolean):[];
        const attributes=explicit.length>=2?explicit:sku?decode(sku.specAttrs).split(/\s*>\s*/u).map((part)=>part.trim()).filter(Boolean):[];
        const available=sku?.canBookCount;
        const availableQuantity=available==null||available===''||!Number.isFinite(Number(available))?null:Number(available);
        return {url:location.href,color:activeColor,size:row?normalizeSize((row.querySelector('.item-label')||row).textContent):'',skuId:sku?String(sku.skuId):null,attributes,availableQuantity,visibleSizes:rows.map((node)=>normalizeSize((node.querySelector('.item-label')||node).textContent)),inputIndex:input?[...document.querySelectorAll('input.ant-input-number-input')].indexOf(input):-1};
      })()`]));
      if (selected.url !== pageUrl) throw new Error(`商品页校验失败：目标商品 ${target.productId} 未能打开`);
      if (selected.skuId !== target.sku_id) throw new Error(`未匹配到 SKU：商品页没有 SKU ID ${target.sku_id}，请检查飞书映射`);
      if (selected.attributes.length !== target.attributes.length || selected.attributes.some((value, index) => value !== target.attributes[index])) throw new Error(`SKU 规格映射不一致：SKU ${target.sku_id} 页面规格为“${selected.attributes.join(" / ") || "未知"}”，映射规格为“${target.attributes.join(" / ") || "未知"}”`);
      if (selected.availableQuantity !== null && selected.availableQuantity < target.quantity) throw new Error(`库存不足：SKU ${target.sku_id} 可订购 ${selected.availableQuantity} 件，需要 ${target.quantity} 件`);
      if (selected.color !== color) throw new Error(`颜色规格选择失败：预期“${color}”，页面当前为“${selected.color ?? "未选择"}”`);
      if (selected.size !== size) throw new Error(`未匹配到可购买尺码“${size}”；页面可选尺码：${selected.visibleSizes.join("、") || "无"}`);
      if (selected.inputIndex < 0) throw new Error(`数量输入框未找到：SKU ${target.sku_id} 的规格“${color} / ${size}”不可输入`);
      const filled = parseCli<{ filled: boolean; verified: boolean; actual: string }>(await this.runBrowser(session, ["fill", "--nth", String(selected.inputIndex), "input.ant-input-number-input", String(target.quantity)]));
      if (!filled.filled || !filled.verified) throw new Error(`数量输入失败：SKU ${target.sku_id} 的输入框未能写入`);
      if (Number(filled.actual) !== target.quantity) throw new Error(`数量校验失败：目标 SKU ${target.sku_id} 需要 ${target.quantity} 件，页面实际为 ${filled.actual || "空"}`);
      // The fixed footer button can sit below the OpenCLI viewport until it is scrolled into view.
      const prepared = parseCli<{ buttonCount: number; visible: boolean }>(await this.runBrowser(session, ["eval", String.raw`(() => {
        const buttons=[...document.querySelectorAll('button')].filter((button)=>button.innerText?.trim()==='加采购车'&&!button.disabled&&(button.offsetWidth||button.offsetHeight||button.getClientRects().length));
        if(buttons.length!==1)return {buttonCount:buttons.length,visible:false};
        const button=buttons[0];button.scrollIntoView({block:'center',behavior:'instant'});
        const rect=button.getBoundingClientRect();
        return {buttonCount:1,visible:rect.width>0&&rect.height>0&&rect.top>=0&&rect.bottom<=window.innerHeight&&rect.left>=0&&rect.right<=window.innerWidth};
      })()`]));
      if (prepared.buttonCount !== 1) throw new Error(`加购按钮定位失败：商品页中找到 ${prepared.buttonCount} 个“加采购车”按钮`);
      if (!prepared.visible) throw new Error("加购按钮不可见：已尝试滚动，按钮仍未进入可视区域");
      await (this.runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(150);
      clickStarted = true;
      const click = parseCli<{ clicked: boolean }>(await this.runBrowser(session, ["click", "--role", "button", "--name", "加采购车"]));
      if (!click.clicked) { clickStarted = false; throw new Error("加采购车按钮未匹配或未执行"); }
    } catch (error) {
      if (error instanceof Error && clickStarted && !error.message.startsWith("UNCERTAIN:")) throw new Error(`UNCERTAIN:${error.message}`);
      throw error;
    }
  }

  /** Waits for the cross-origin 1688 dropship SKU drawer created by the product page. */
  private async findDropshipSkuFrame(session: string): Promise<number> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const frames = parseCli<BrowserFrame[]>(await this.runBrowser(session, ["frames"]));
      const frame = frames.find(({ url, name }) => name === "fullscreen-drawer-iframe" && url.includes("/od-panel/sku-panel.html") && url.includes("actionType=dxOrder"));
      if (frame) return frame.index;
      if (attempt < 11) await (this.runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(250);
    }
    throw new Error("1688 代发规格 iframe 未打开");
  }

  private async cartQuantitiesByMode(session: string, targets: ResolvedSkuTarget[], minimums = new Map<string, number>()): Promise<Map<string, CartModeQuantities>> {
    const result = new Map(targets.map((target) => [target.cartKey, { wholesale: 0, dropship: 0 }]));
    const modes = new Set(targets.flatMap((target) => target.dropship ? [false, true] : [false]));
    for (const dropship of modes) {
      const mode = dropship ? "dropship" : "wholesale";
      const modeMinimums = new Map([...minimums].filter(([key]) => targets.some((target) => target.cartKey === key && target.dropship === dropship)));
      const quantities = await this.cartQuantities(session, targets, modeMinimums, dropship);
      for (const [key, quantity] of quantities) result.get(key)![mode] = quantity;
    }
    return result;
  }

  /** Reads matching SKU quantities from either the legacy or the current 1688 cart layout. */
  private async cartQuantities(session: string, targets: ResolvedSkuTarget[], minimums = new Map<string, number>(), dropship = false): Promise<Map<string, number>> {
    await this.runBrowser(session, ["open", dropship ? "https://cart.1688.com/daixiao_cart.htm" : "https://cart.1688.com/cart.htm"]);
    const scrollSelector = String.raw`(() => {
      const candidates=[document.scrollingElement,...document.querySelectorAll('main,section,div')].filter((node,index,all)=>{
        if(!(node instanceof HTMLElement)||all.indexOf(node)!==index||node.clientHeight<180||node.scrollHeight<=node.clientHeight+80)return false;
        if(node===document.scrollingElement)return true;
        const overflow=getComputedStyle(node).overflowY;
        return overflow==='auto'||overflow==='scroll';
      });
      let moved=false;
      for(const node of candidates){
        const maximum=Math.max(0,node.scrollHeight-node.clientHeight);
        const next=Math.min(maximum,node.scrollTop+Math.max(500,Math.floor(node.clientHeight*0.8)));
        if(next>node.scrollTop+2){node.scrollTop=next;node.dispatchEvent(new Event('scroll',{bubbles:true}));moved=true;}
      }
      window.dispatchEvent(new Event('scroll'));
      return {moved,scrollers:candidates.length};
    })()`;
    await this.runBrowser(session, ["eval", String.raw`(() => {
      for(const node of [document.scrollingElement,...document.querySelectorAll('main,section,div')]){
        if(node instanceof HTMLElement&&node.scrollHeight>node.clientHeight+80)node.scrollTop=0;
      }
      window.scrollTo(0,0);
      return {reset:true};
    })()`]);
    const serialized = targets.map((target) => ({ key: target.cartKey, productId: target.productId, attributes: target.attributes }));
    const selector = String.raw`(() => {
      const targets=${JSON.stringify(serialized)};
      const normalize=(value)=>String(value??'').split(/\s*(?:;|；|>)\s*/u).map((part)=>part.trim()).filter(Boolean);
      const expectedPath=${JSON.stringify(dropship ? "/daixiao_cart.htm" : "/cart.htm")};
      const isCartPage=location.hostname==='cart.1688.com'&&location.pathname===expectedPath;
      const oldRoot=document.querySelector('#cartV2Header');
      const modernRoot=document.querySelector('[class*=cart--container]');
      const modernHeader=modernRoot?.querySelector('[class*=header-bar--container]');
      const modernTabs=[...(modernRoot?.querySelectorAll('[role=tab]')??[])];
      const expectedTab=${JSON.stringify(dropship ? "分销" : "现货")};
      const activeModernTab=modernTabs.find((tab)=>tab.getAttribute('aria-selected')==='true'||tab.classList.contains('active'));
      const activeTabName=activeModernTab?.textContent?.trim().replace(/\s*\(\d+\)$/u,'')??'';
      const modernModeMatches=modernTabs.length===0||activeTabName===expectedTab;
      const modernLoaded=Boolean(modernRoot&&modernHeader&&modernModeMatches);
      const oldLoaded=Boolean(oldRoot);
      const readItemFields=(row)=>{
        const fiberKey=Object.keys(row).find((key)=>key.startsWith('__reactFiber$'));
        let fiber=fiberKey?row[fiberKey]:null;
        for(let depth=0;fiber&&depth<12;depth++,fiber=fiber.return){
          const fields=fiber.memoizedProps?.fields;
          if(fields&&typeof fields==='object'&&fields.offerId!=null&&fields.skuId!=null&&fields.skuTitle!=null)return fields;
        }
        return null;
      };
      const quantities={};
      if(isCartPage&&(oldLoaded||modernLoaded)){
        for(const target of targets){
          if(oldLoaded){
            const groups=[...document.querySelectorAll('[class*=groupRoot]')];
            const matchingGroups=groups.filter((group)=>[...group.querySelectorAll('a[href*="detail.1688.com/offer/"]')].some((link)=>new URL(link.href).pathname==='/offer/'+target.productId+'.html'));
            const rows=matchingGroups.flatMap((group)=>[...group.querySelectorAll('[class*=item--container]')]).filter((row)=>{const labels=normalize([...row.querySelectorAll('[class*=skuTitle]')].map((node)=>node.textContent?.trim()??'').join(';'));return labels.length===target.attributes.length&&labels.every((label,index)=>label===target.attributes[index])});
            quantities[target.key]=rows.map((row)=>Number(row.querySelector('[class*=quantityWrapper] input')?.value??NaN)).filter(Number.isFinite).reduce((sum,value)=>sum+value,0);
            continue;
          }
          const rows=[...modernRoot.querySelectorAll('[class*=item--container--]')].filter((row)=>String(row.className).split(' ').some((name)=>name.startsWith('item--container--')));
          const matchingRows=rows.filter((row)=>{
            // New cart rows omit offer links; read the rendered Item component fields attached to the row.
            const fields=readItemFields(row);
            if(!fields||String(fields.offerId)!==target.productId)return false;
            const labels=normalize(fields.skuTitle);
            return labels.length===target.attributes.length&&labels.every((label,index)=>label===target.attributes[index]);
          });
          quantities[target.key]=matchingRows.map((row)=>{
            const picker=row.querySelector('[class*=numberPicker]');
            const input=picker?.querySelector('input:not([type=checkbox])');
            const itemQuantity=Number(readItemFields(row)?.quantity??NaN);
            const value=input?.value??picker?.getAttribute('aria-valuenow')??itemQuantity;
            return Number(value);
          }).filter(Number.isFinite).reduce((sum,value)=>sum+value,0);
        }
      }
      return {loaded:isCartPage&&(oldLoaded||modernLoaded),quantities};
    })()`;
    let loaded = false;
    let quantities: Record<string, number> = {};
    let stableEndPasses = 0;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = parseCli<{ loaded: boolean; quantities: Record<string, number> }>(await this.runBrowser(session, ["eval", selector]));
      loaded = result.loaded;
      for (const [key, quantity] of Object.entries(result.quantities)) quantities[key] = Math.max(quantities[key] ?? 0, quantity);
      if (loaded && minimums.size > 0 && [...minimums].every(([key, minimum]) => (quantities[key] ?? 0) >= minimum)) break;
      const scroll = parseCli<{ moved: boolean }>(await this.runBrowser(session, ["eval", scrollSelector]));
      stableEndPasses = loaded ? (scroll.moved ? 0 : stableEndPasses + 1) : 0;
      if (loaded && stableEndPasses >= 2) break;
      if (attempt < 29) await (this.runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(500);
    }
    if (!loaded) throw new Error("1688 购物车页面未能加载");
    return new Map(Object.entries(quantities));
  }

  private finishBatchItem(batchId: string, storeId: string, item: StockPrepBatchItemRow, status: "added" | "failed" | "uncertain", error: string | null, cartBefore: number | null = null, cartAfter: number | null = null): void {
    const updated = this.database.prepare("UPDATE stock_prep_batch_items SET status=?,cart_before=?,cart_after=?,error=?,updated_at_ms=? WHERE id=? AND status IN ('queued','running')")
      .run(status, cartBefore, cartAfter, error, Date.now(), item.id);
    if (!updated.changes) return;
    const updateOrder = this.database.prepare("UPDATE stock_prep_order_states SET state=?,error=?,updated_at_ms=? WHERE store_id=? AND posting_number=? AND offer_id=? AND batch_id=?");
    for (const key of JSON.parse(item.order_keys_json) as string[]) {
      const [postingNumber, offerId] = key.split("\u0000") as [string, string];
      updateOrder.run(status, error, Date.now(), storeId, postingNumber, offerId, batchId);
    }
    this.database.prepare("UPDATE stock_prep_batches SET completed_count=completed_count+1 WHERE id=?").run(batchId);
  }

}
