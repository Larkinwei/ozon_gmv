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
    const profile = this.getFeishuProfile();
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
    const profile = this.getFeishuProfile();
    if (!profile) throw new Error("请先配置飞书 App ID 与 App Secret");
    if (this.settings.get(PROFILE_KEY)) {
      const appId = this.settings.get(APP_ID_KEY)!;
      const secret = decryptSecret(this.settings.get(APP_SECRET_KEY)!, this.config.ENCRYPTION_KEY);
      await this.feishu(["profile", "add", "--name", profile, "--app-id", appId, "--app-secret-stdin"], undefined, secret, false);
    }
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
    try {
      const items = this.database.prepare("SELECT * FROM stock_prep_batch_items WHERE batch_id=? ORDER BY created_at_ms").all(batchId) as Array<{ id: string; offer_url: string; offer_id: string; sku_id: string; quantity: number; order_keys_json: string }>;
      for (const item of items) {
        try {
          const result = await this.addToCart(item.offer_url, item.sku_id, item.quantity);
          this.database.prepare("UPDATE stock_prep_batch_items SET status='added',cart_before=?,cart_after=?,updated_at_ms=? WHERE id=?").run(result.before, result.after, Date.now(), item.id);
          const update = this.database.prepare("UPDATE stock_prep_order_states SET state='added',error=NULL,updated_at_ms=? WHERE store_id=? AND posting_number=? AND offer_id=? AND batch_id=?");
          for (const key of JSON.parse(item.order_keys_json) as string[]) { const [postingNumber, offerId] = key.split("\u0000") as [string, string]; update.run(Date.now(), storeId, postingNumber, offerId, batchId); }
        } catch (error) {
          const uncertain = error instanceof Error && error.message.startsWith("UNCERTAIN:");
          const message = error instanceof Error ? error.message.replace(/^UNCERTAIN:/u, "") : "1688 加购失败";
          this.database.prepare("UPDATE stock_prep_batch_items SET status=?,error=?,updated_at_ms=? WHERE id=?").run(uncertain ? "uncertain" : "failed", message, Date.now(), item.id);
          const update = this.database.prepare("UPDATE stock_prep_order_states SET state=?,error=?,updated_at_ms=? WHERE store_id=? AND posting_number=? AND offer_id=? AND batch_id=?");
          for (const key of JSON.parse(item.order_keys_json) as string[]) { const [postingNumber, offerId] = key.split("\u0000") as [string, string]; update.run(uncertain ? "uncertain" : "failed", message, Date.now(), storeId, postingNumber, offerId, batchId); }
        }
        this.database.prepare("UPDATE stock_prep_batches SET completed_count=completed_count+1 WHERE id=?").run(batchId);
      }
      const failed = this.database.prepare("SELECT COUNT(*) AS count FROM stock_prep_batch_items WHERE batch_id=? AND status<>'added'").get(batchId) as { count: number };
      this.database.prepare("UPDATE stock_prep_batches SET status=?,finished_at_ms=? WHERE id=?").run(failed.count ? "completed_with_errors" : "completed", Date.now(), batchId);
    } finally { this.batchRunning = false; }
  }

  private async addToCart(url: string, skuId: string, quantity: number): Promise<{ before: number; after: number }> {
    const session = `stock-prep-${randomUUID().slice(0, 8)}`;
    const run = (args: string[]): Promise<string> => this.runBrowser(session, args);
    let clickStarted = false;
    try {
      const expectedOfferId = extractOfferId(url);
      if (!expectedOfferId) throw new Error("1688 商品链接格式无效");
      const pageUrl = `https://detail.1688.com/offer/${expectedOfferId}.html`;
      await run(["open", pageUrl]);
      const detail = parseCli<{ url: string; sku: { sku1?: string; sku2?: string }; title: string }>(await run(["eval", `(() => { const scripts=[...document.scripts].map(x=>x.textContent||'').join('\\n'); const match=scripts.match(/\\{[^{}]*"skuId"\\s*:\\s*${skuId}[^{}]*\\}/); if(!match) return {url:location.href,title:document.title,sku:null}; return {url:location.href,title:document.title,sku:JSON.parse(match[0])}; })()`]));
      if (detail.url !== pageUrl || !detail.sku || String((detail.sku as unknown as { skuId: number }).skuId) !== skuId) throw new Error("页面商品或 SKU ID 与飞书映射不一致");
      const sku = detail.sku;
      await run(["open", "https://cart.1688.com/cart.htm"]);
      const before = await this.cartQuantity(session, expectedOfferId, sku.sku1 ?? "", sku.sku2 ?? "");
      await run(["open", pageUrl]);
      const setup = `(() => { const exact=(e,t)=>e.textContent?.trim()===t; const color=${JSON.stringify(sku.sku1 ?? "")}; const size=${JSON.stringify(sku.sku2 ?? "")}; if(color){const button=[...document.querySelectorAll('.sku-filter-button')].find(e=>exact(e.querySelector('.label-name')||e,color)); if(!button)throw new Error('商品颜色规格不存在: '+color); if(!button.classList.contains('active'))button.click()} const rows=[...document.querySelectorAll('.expand-view-item')]; const row=size?rows.find(e=>exact(e.querySelector('.item-label')||e,size)):rows[0]; if(!row)throw new Error('商品尺码规格不存在: '+size); const input=row.querySelector('input.ant-input-number-input'); if(!input)throw new Error('目标规格数量框不存在'); return {url:location.href,color,size,inputIndex:[...document.querySelectorAll('input.ant-input-number-input')].indexOf(input)}; })()`;
      const selected = parseCli<{ url: string; color: string; size: string; inputIndex: number }>(await run(["eval", setup]));
      if (selected.url !== pageUrl || selected.color !== (sku.sku1 ?? "") || selected.size !== (sku.sku2 ?? "") || selected.inputIndex < 0) {
        throw new Error(`未能确认目标规格：${JSON.stringify({ selected, expectedColor: sku.sku1 ?? "", expectedSize: sku.sku2 ?? "" })}`);
      }
      const filled = parseCli<{ filled: boolean; verified: boolean; actual: string }>(await run(["fill", "--nth", String(selected.inputIndex), "input.ant-input-number-input", String(quantity)]));
      if (!filled.filled || !filled.verified || Number(filled.actual) !== quantity) throw new Error(`未能将加购数量输入目标规格：${JSON.stringify({ filled, expectedQuantity: quantity })}`);
      clickStarted = true;
      const click = parseCli<{ clicked: boolean }>(await run(["click", "--role", "button", "--name", "加采购车"]));
      if (!click.clicked) { clickStarted = false; throw new Error("加采购车按钮未匹配或未执行"); }
      await run(["open", "https://cart.1688.com/cart.htm"]);
      const after = await this.cartQuantity(session, expectedOfferId, sku.sku1 ?? "", sku.sku2 ?? "", before + quantity);
      if (after - before !== quantity) throw new Error(`UNCERTAIN:购物车数量从 ${before} 变为 ${after}，增量预期 ${quantity}`);
      return { before, after };
    } catch (error) {
      if (error instanceof Error && !error.message.startsWith("UNCERTAIN:") && clickStarted) throw new Error(`UNCERTAIN:${error.message}`);
      throw error;
    } finally {
      await this.runBrowser(session, ["close"]).catch(() => undefined);
    }
  }

  private async cartQuantity(session: string, offerId: string, color: string, size: string, minimumQuantity = 1): Promise<number> {
    const selector = `(() => {
      const offerId = ${JSON.stringify(offerId)};
      const color = ${JSON.stringify(color)};
      const size = ${JSON.stringify(size)};
      const isCartPage = location.hostname === "cart.1688.com" && location.pathname === "/cart.htm";
      const groups = [...document.querySelectorAll("[class*=groupRoot]")];
      const matchingGroups = groups.filter((group) => [...group.querySelectorAll('a[href*="detail.1688.com/offer/"]')]
        .some((link) => new URL(link.href).pathname === "/offer/" + offerId + ".html"));
      const rows = matchingGroups.flatMap((group) => [...group.querySelectorAll("[class*=item--container]")])
        .filter((row) => {
          const labels = [...row.querySelectorAll("[class*=skuTitle]")].map((item) => item.textContent?.trim() ?? "").join(" ");
          return (!color || labels.includes(color)) && (!size || labels.includes(size));
        });
      const quantity = rows.map((row) => {
        const input = row.querySelector("[class*=quantityWrapper] input");
        return input ? Number(input.value) : null;
      }).filter((value) => value !== null && Number.isFinite(value))
        .reduce((sum, value) => sum + value, 0);
      return { loaded: isCartPage && Boolean(document.querySelector("#cartV2Header")), quantity };
    })()`;

    let loaded = false;
    let quantity = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = parseCli<{ loaded: boolean; quantity: number }>(await this.runBrowser(session, ["eval", selector]));
      loaded = result.loaded;
      quantity = result.quantity;
      if (loaded && quantity >= minimumQuantity) return quantity;
      if (attempt < 11) await (this.runtime.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))))(500);
    }
    if (!loaded) throw new Error("1688 购物车页面未能加载");
    return quantity;
  }
}
