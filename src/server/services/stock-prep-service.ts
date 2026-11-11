import { randomUUID } from "node:crypto";
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

export interface StockPrepOrderView { postingNumber: string; offerId: string; productName: string; quantity: number; state: StockPrepState; error: string | null; selectedByDefault: boolean }
export interface StockPrepGroupView { offerUrl: string | null; offerId: string; skuId: string | null; status: StockPrepState; quantity: number; orders: StockPrepOrderView[]; error: string | null }
export interface StockPrepScanView { storeId: string; groups: StockPrepGroupView[] }

interface OrderRow {
  store_id: string;
  store_name: string;
  posting_number: string;
  offer_id: string;
  name: string;
  quantity: number;
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
const require = createRequire(import.meta.url);

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
    const rows = this.database.prepare(`SELECT p.store_id,s.name AS store_name,p.posting_number,pi.offer_id,pi.name,pi.quantity,
        states.state,states.error
      FROM postings p JOIN stores s ON s.id=p.store_id JOIN posting_items pi ON pi.posting_id=p.id
      LEFT JOIN stock_prep_order_states states ON states.store_id=p.store_id AND states.posting_number=p.posting_number AND states.offer_id=pi.offer_id
      WHERE p.store_id=? AND s.platform='ozon' AND p.fulfillment_mode IN ('FBS','RFBS')
        AND p.status='awaiting_packaging' AND p.cancelled_at_ms IS NULL
      ORDER BY pi.offer_id,p.posting_number`).all(storeId) as OrderRow[];
    const mappings = await this.readMappings(source);
    const mappingCounts = new Map<string, number>();
    for (const mapping of mappings) mappingCounts.set(mapping.offerId, (mappingCounts.get(mapping.offerId) ?? 0) + 1);
    const mappingByOffer = new Map(mappings.map((mapping) => [mapping.offerId, mapping]));
    const groups = new Map<string, StockPrepGroupView>();
    for (const row of rows) {
      const mapping = mappingByOffer.get(row.offer_id);
      const mapped = mapping && mappingCounts.get(row.offer_id) === 1 && valid1688Url(mapping.url) && /^\d+$/u.test(mapping.skuId);
      let state = row.state ?? (mapped ? "pending" : "unmatched");
      const mappingError = "飞书映射缺失、重复或无效";
      if (!row.state) {
        this.database.prepare(`INSERT INTO stock_prep_order_states (store_id,posting_number,offer_id,state,error,updated_at_ms) VALUES (?,?,?,?,?,?)`)
          .run(storeId, row.posting_number, row.offer_id, state, mapped ? null : mappingError, Date.now());
      } else if (row.state === "unmatched" && mapped) {
        state = "pending";
        this.database.prepare("UPDATE stock_prep_order_states SET state='pending',error=NULL,updated_at_ms=? WHERE store_id=? AND posting_number=? AND offer_id=? AND state='unmatched'")
          .run(Date.now(), storeId, row.posting_number, row.offer_id);
      } else if (row.state === "pending" && !mapped) {
        state = "unmatched";
        this.database.prepare("UPDATE stock_prep_order_states SET state='unmatched',error=?,updated_at_ms=? WHERE store_id=? AND posting_number=? AND offer_id=? AND state='pending'")
          .run(mappingError, Date.now(), storeId, row.posting_number, row.offer_id);
      }
      const groupKey = mapped ? `${mapping.url}\u0000${mapping.skuId}` : `unmatched:${row.offer_id}`;
      const group = groups.get(groupKey) ?? { offerUrl: mapped ? mapping.url : null, offerId: row.offer_id, skuId: mapped ? mapping.skuId : null, status: state, quantity: 0, orders: [], error: mapped ? row.error : "飞书映射缺失、重复或无效" };
      group.quantity += row.quantity;
      group.orders.push({ postingNumber: row.posting_number, offerId: row.offer_id, productName: row.name, quantity: row.quantity, state, error: mapped ? row.error : mappingError, selectedByDefault: state === "pending" });
      if (group.status !== state) group.status = group.status === "unmatched" || state === "unmatched" ? "unmatched" : "pending";
      groups.set(groupKey, group);
    }
    return { storeId, groups: [...groups.values()] };
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
    const orderMap = new Map<string, { group: { offerUrl: string | null; skuId: string | null; offerId: string }; order: { postingNumber: string; offerId: string; quantity: number; state: StockPrepState } }>();
    for (const group of scan.groups) for (const order of group.orders) orderMap.set(`${order.postingNumber}\u0000${order.offerId}`, { group, order });
    const itemGroups = new Map<string, { url: string; skuId: string; offerId: string; quantity: number; keys: string[] }>();
    for (const key of uniqueKeys) {
      const match = orderMap.get(`${key.postingNumber}\u0000${key.offerId}`);
      if (!match || !match.group.offerUrl || !match.group.skuId || !["pending", "failed"].includes(match.order.state)) throw new Error(`订单 ${key.postingNumber} 当前不能加购`);
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

  /** Releases uncertain orders only after a separate cart check confirmed no quantity was added. */
  public resolveUncertainAsFailed(storeId: string, keys: Array<{ postingNumber: string; offerId: string }>): number {
    const update = this.database.prepare(`UPDATE stock_prep_order_states SET state='failed',error='人工核对购物车后确认未增加数量',updated_at_ms=?
      WHERE store_id=? AND posting_number=? AND offer_id=? AND state='uncertain'`);
    let count = 0;
    this.database.transaction(() => { for (const key of keys) count += update.run(Date.now(), storeId, key.postingNumber, key.offerId).changes; })();
    return count;
  }

  private async readMappings(source: StockPrepStoreRow): Promise<Mapping[]> {
    const output = await this.feishu(["base", "+record-list", "--base-token", source.base_token, "--table-id", source.table_id,
      "--field-id", "货号", "--field-id", "1688商品链接", "--field-id", "1688 SKU ID", "--format", "json", "--as", "user"]);
    return parseRecords(output).map((row) => ({ offerId: String(row["货号"] ?? "").trim(), url: normalizeMappingUrl(row["1688商品链接"]), skuId: String(row["1688 SKU ID"] ?? "").trim() })).filter((row) => row.offerId);
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

      const before = targets.length ? await this.cartQuantities(session, targets) : new Map<string, number>();
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
        (before.get(cartKey) ?? 0) + group.reduce((sum, target) => sum + target.quantity, 0),
      ]));
      const after = attempted.length ? await this.cartQuantities(session, attempted, expectedMinimums) : new Map<string, number>();
      for (const [cartKey, group] of attemptedByCartKey) {
        const beforeQuantity = before.get(cartKey) ?? 0;
        const afterQuantity = after.get(cartKey) ?? 0;
        const expectedDelta = group.reduce((sum, target) => sum + target.quantity, 0);
        for (const target of group) {
          if (afterQuantity - beforeQuantity === expectedDelta) {
            this.finishBatchItem(batchId, storeId, target, "added", null, beforeQuantity, afterQuantity);
          } else {
            this.finishBatchItem(batchId, storeId, target, "uncertain", `购物车目标规格数量从 ${beforeQuantity} 变为 ${afterQuantity}，整批增量预期 ${expectedDelta}`, beforeQuantity, afterQuantity);
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
    const detail = parseCli<{ url: string; skuId: string | null; attributes: string[] }>(await this.runBrowser(session, ["eval", String.raw`(() => {
      const desiredSkuId=${JSON.stringify(item.sku_id)};
      const decode=(value)=>{const node=document.createElement('textarea');node.innerHTML=String(value??'');return node.value.trim()};
      const scripts=[...document.scripts].map((node)=>node.textContent||'').join('\n');
      const matches=scripts.match(/\{[^{}]*"skuId"\s*:\s*"?\d+"?[^{}]*\}/g)||[];
      const sku=matches.map((text)=>{try{return JSON.parse(text)}catch{return null}}).find((value)=>value&&String(value.skuId)===desiredSkuId);
      if(!sku)return {url:location.href,skuId:null,attributes:[]};
      const explicit=[sku.sku1,sku.sku2].map(decode).filter(Boolean);
      const specAttrs=decode(sku.specAttrs).split(/\s*>\s*/u).map((value)=>value.trim()).filter(Boolean);
      return {url:location.href,skuId:String(sku.skuId),attributes:explicit.length>=2?explicit:specAttrs};
    })()`]));
    if (detail.url !== pageUrl || detail.skuId !== item.sku_id) throw new Error(`页面中未找到目标 SKU ID：${item.sku_id}`);
    if (detail.attributes.length < 2 || detail.attributes.some((value) => !value.trim())) throw new Error(`SKU ${item.sku_id} 的规格信息不完整，已阻止加购`);
    const attributes = detail.attributes.map((value) => value.trim());
    return { ...item, productId, attributes, cartKey: `${productId}\u0000${attributes.join("\u0000")}` };
  }

  private async addResolvedSku(session: string, target: ResolvedSkuTarget): Promise<void> {
    const pageUrl = `https://detail.1688.com/offer/${target.productId}.html`;
    const [color, size] = target.attributes;
    let clickStarted = false;
    try {
      this.database.prepare("UPDATE stock_prep_batch_items SET status='running',updated_at_ms=? WHERE id=? AND status='queued'").run(Date.now(), target.id);
      await this.runBrowser(session, ["open", pageUrl]);
      const colorResult = parseCli<{ found: boolean }>(await this.runBrowser(session, ["eval", String.raw`(() => {
        const target=${JSON.stringify(color)};const exact=(value)=>value?.textContent?.trim()===target;
        const button=[...document.querySelectorAll('.sku-filter-button')].find((node)=>exact(node.querySelector('.label-name')||node));
        if(!button)return {found:false};if(!button.classList.contains('active'))button.click();return {found:true};
      })()`]));
      if (!colorResult.found) throw new Error(`商品颜色规格不存在：${color}`);
      await (this.runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(250);
      const selected = parseCli<{ url: string; color: string | null; size: string; skuId: string | null; inputIndex: number }>(await this.runBrowser(session, ["eval", String.raw`(() => {
        const expectedColor=${JSON.stringify(color)};const expectedSize=${JSON.stringify(size)};
        const active=[...document.querySelectorAll('.sku-filter-button')].find((node)=>node.classList.contains('active'));
        const activeColor=(active?.querySelector('.label-name')||active)?.textContent?.trim()||null;
        const row=[...document.querySelectorAll('.expand-view-item')].find((node)=>(node.querySelector('.item-label')||node).textContent?.trim()===expectedSize);
        const input=row?.querySelector('input.ant-input-number-input');
        const decode=(value)=>{const node=document.createElement('textarea');node.innerHTML=String(value??'');return node.value.trim()};
        const scripts=[...document.scripts].map((node)=>node.textContent||'').join('\n');
        const matches=scripts.match(/\{[^{}]*"skuId"\s*:\s*"?\d+"?[^{}]*\}/g)||[];
        const sku=matches.map((text)=>{try{return JSON.parse(text)}catch{return null}}).find((value)=>{if(!value)return false;const explicit=[value.sku1,value.sku2].map(decode).filter(Boolean);const attrs=explicit.length>=2?explicit:decode(value.specAttrs).split(/\s*>\s*/u).map((part)=>part.trim()).filter(Boolean);return attrs[0]===expectedColor&&attrs[1]===expectedSize});
        return {url:location.href,color:activeColor,size:row?(row.querySelector('.item-label')||row).textContent?.trim()||'':'',skuId:sku?String(sku.skuId):null,inputIndex:input?[...document.querySelectorAll('input.ant-input-number-input')].indexOf(input):-1};
      })()`]));
      if (selected.url !== pageUrl || selected.color !== color || selected.size !== size || selected.skuId !== target.sku_id || selected.inputIndex < 0) {
        throw new Error(`目标规格校验失败，预期 SKU ${target.sku_id}，页面识别 SKU ${selected.skuId ?? "无"}`);
      }
      const filled = parseCli<{ filled: boolean; verified: boolean; actual: string }>(await this.runBrowser(session, ["fill", "--nth", String(selected.inputIndex), "input.ant-input-number-input", String(target.quantity)]));
      if (!filled.filled || !filled.verified || Number(filled.actual) !== target.quantity) throw new Error(`未能将加购数量输入目标 SKU ${target.sku_id}`);
      clickStarted = true;
      const click = parseCli<{ clicked: boolean }>(await this.runBrowser(session, ["click", "--role", "button", "--name", "加采购车"]));
      if (!click.clicked) { clickStarted = false; throw new Error("加采购车按钮未匹配或未执行"); }
    } catch (error) {
      if (error instanceof Error && clickStarted && !error.message.startsWith("UNCERTAIN:")) throw new Error(`UNCERTAIN:${error.message}`);
      throw error;
    }
  }

  private async cartQuantities(session: string, targets: ResolvedSkuTarget[], minimums = new Map<string, number>()): Promise<Map<string, number>> {
    await this.runBrowser(session, ["open", "https://cart.1688.com/cart.htm"]);
    const serialized = targets.map((target) => ({ key: target.cartKey, productId: target.productId, attributes: target.attributes }));
    const selector = String.raw`(() => {
      const targets=${JSON.stringify(serialized)};
      const normalize=(value)=>String(value??'').split(/\s*(?:;|；|>)\s*/u).map((part)=>part.trim()).filter(Boolean);
      const isCartPage=location.hostname==='cart.1688.com'&&location.pathname==='/cart.htm';
      const groups=[...document.querySelectorAll('[class*=groupRoot]')];const quantities={};
      for(const target of targets){
        const matchingGroups=groups.filter((group)=>[...group.querySelectorAll('a[href*="detail.1688.com/offer/"]')].some((link)=>new URL(link.href).pathname==='/offer/'+target.productId+'.html'));
        const rows=matchingGroups.flatMap((group)=>[...group.querySelectorAll('[class*=item--container]')]).filter((row)=>{const labels=normalize([...row.querySelectorAll('[class*=skuTitle]')].map((node)=>node.textContent?.trim()??'').join(';'));return labels.length===target.attributes.length&&labels.every((label,index)=>label===target.attributes[index])});
        quantities[target.key]=rows.map((row)=>Number(row.querySelector('[class*=quantityWrapper] input')?.value??NaN)).filter(Number.isFinite).reduce((sum,value)=>sum+value,0);
      }
      return {loaded:isCartPage&&Boolean(document.querySelector('#cartV2Header')),quantities};
    })()`;
    let loaded = false;
    let quantities: Record<string, number> = {};
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = parseCli<{ loaded: boolean; quantities: Record<string, number> }>(await this.runBrowser(session, ["eval", selector]));
      loaded = result.loaded;
      quantities = result.quantities;
      if (loaded && [...minimums].every(([key, minimum]) => (quantities[key] ?? 0) >= minimum)) break;
      if (attempt < 11) await (this.runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(500);
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
