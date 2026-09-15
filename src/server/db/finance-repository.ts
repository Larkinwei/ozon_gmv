import { randomUUID } from "node:crypto";

import type { FinanceCategory, FinanceSyncState } from "../../shared/contracts";
import type { NormalizedFinanceLine } from "../finance/accrual-normalize";
import type { AppDatabase } from "./database";

export interface FinanceLineRecord {
  id: string;
  storeId: string;
  sourceDate: string;
  accrualDate: string;
  sourceKind: string;
  accruedCategory: string;
  unitNumber: string;
  postingNumber: string | null;
  sku: string | null;
  typeId: string | null;
  typeName: string | null;
  category: FinanceCategory;
  amount: string;
  currency: string;
  quantity: number | null;
  sellerPrice: string | null;
}

export interface FinancePostingRecord {
  id: string;
  storeId: string;
  storeName: string;
  storeColor: string;
  postingNumber: string;
  orderNumber: string;
  shipmentAtMs: number | null;
  shipmentTimeSource: string;
  currency: string;
  status: string;
  items: Array<{ sku: string; offerId: string; name: string; quantity: number; currency: string }>;
}

export interface FinanceSyncRunRecord {
  id: string;
  fromDate: string;
  toDate: string;
  state: FinanceSyncState;
  totalDays: number;
  completedDays: number;
  failedDays: number;
  error: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  storeIds: string[];
  mode: "ensure" | "rebuild";
}

interface PostingRow extends Record<string, unknown> {
  id: string;
  store_id: string;
  store_name: string;
  store_color: string;
  posting_number: string;
  order_number: string;
  shipment_at_ms: number | null;
  shipment_time_source: string;
  currency: string;
  status: string;
  item_id: string | null;
  item_sku: string | null;
  item_offer_id: string | null;
  item_name: string | null;
  item_quantity: number | null;
  item_currency: string | null;
}

function placeholders(values: string[]): string {
  return values.map(() => "?").join(", ");
}

function toFinanceLine(row: Record<string, unknown>): FinanceLineRecord {
  return {
    id: String(row.id),
    storeId: String(row.store_id),
    sourceDate: String(row.source_date),
    accrualDate: String(row.accrual_date),
    sourceKind: String(row.source_kind),
    accruedCategory: String(row.accrued_category),
    unitNumber: String(row.unit_number),
    postingNumber: row.posting_number === null ? null : String(row.posting_number),
    sku: row.sku === null ? null : String(row.sku),
    typeId: row.type_id === null ? null : String(row.type_id),
    typeName: row.type_name === null ? null : String(row.type_name),
    category: String(row.category) as FinanceCategory,
    amount: String(row.amount),
    currency: String(row.currency),
    quantity: row.quantity === null ? null : Number(row.quantity),
    sellerPrice: row.seller_price === null ? null : String(row.seller_price),
  };
}

function toRun(row: Record<string, unknown>): FinanceSyncRunRecord {
  let storeIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.store_ids_json ?? "[]"));
    if (Array.isArray(parsed)) storeIds = parsed.map(String).sort();
  } catch {
    storeIds = [];
  }
  return {
    id: String(row.id),
    fromDate: String(row.from_date),
    toDate: String(row.to_date),
    state: String(row.state) as FinanceSyncState,
    totalDays: Number(row.total_days),
    completedDays: Number(row.completed_days),
    failedDays: Number(row.failed_days),
    error: row.error === null ? null : String(row.error),
    startedAtMs: row.started_at_ms === null ? null : Number(row.started_at_ms),
    finishedAtMs: row.finished_at_ms === null ? null : Number(row.finished_at_ms),
    storeIds,
    mode: row.sync_mode === "ensure" ? "ensure" : "rebuild",
  };
}

export class FinanceRepository {
  public constructor(private readonly database: AppDatabase) {}

  public saveAccrualTypes(storeId: string, types: Array<{ id: string; name: string; description: string }>): void {
    const statement = this.database.prepare(
      `INSERT INTO finance_accrual_types (store_id, type_id, name, description, fetched_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (store_id, type_id) DO UPDATE SET
         name = excluded.name, description = excluded.description, fetched_at_ms = excluded.fetched_at_ms`,
    );
    const now = Date.now();
    this.database.transaction(() => {
      for (const type of types) {
        statement.run(storeId, type.id, type.name, type.description, now);
      }
    })();
  }

  public getAccrualTypeNames(storeId: string): Map<string, string> {
    const rows = this.database.prepare("SELECT type_id, name FROM finance_accrual_types WHERE store_id = ?").all(storeId) as Array<{ type_id: string; name: string }>;
    return new Map(rows.map((row) => [row.type_id, row.name]));
  }

  /** Replaces one API calendar day's lines while keeping an interrupted cursor resumable. */
  public replaceDayLines(storeId: string, sourceDate: string, lines: NormalizedFinanceLine[], replaceExisting = true): void {
    const insert = this.database.prepare(
      `INSERT INTO finance_accrual_lines (
         id, store_id, source_key, source_date, accrual_date, source_kind, accrued_category,
         unit_number, posting_number, sku, type_id, type_name, category, amount, currency,
         quantity, seller_price, raw_json, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, 'by_day', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (store_id, source_key) DO UPDATE SET
         source_date = excluded.source_date, accrual_date = excluded.accrual_date,
         source_kind = excluded.source_kind, accrued_category = excluded.accrued_category,
         unit_number = excluded.unit_number, posting_number = excluded.posting_number,
         sku = excluded.sku, type_id = excluded.type_id, type_name = excluded.type_name,
         category = excluded.category, amount = excluded.amount, currency = excluded.currency,
         quantity = excluded.quantity, seller_price = excluded.seller_price,
         raw_json = excluded.raw_json, updated_at_ms = excluded.updated_at_ms`,
    );
    const now = Date.now();
    this.database.transaction(() => {
      if (replaceExisting) {
        this.database.prepare("DELETE FROM finance_accrual_lines WHERE store_id = ? AND source_date = ?").run(storeId, sourceDate);
      }
      for (const line of lines) {
        insert.run(
          randomUUID(), storeId, line.sourceKey, line.sourceDate, line.accrualDate, line.accruedCategory,
          line.unitNumber, line.postingNumber, line.sku, line.typeId, line.typeName, line.category,
          line.amount, line.currency, line.quantity, line.sellerPrice, line.rawJson, now, now,
        );
      }
    })();
  }

  public findDayCheckpoint(storeId: string, date: string): { cursor: string | null; state: string; error: string | null } | null {
    const row = this.database.prepare(
      "SELECT cursor, state, error FROM finance_sync_days WHERE store_id = ? AND accrual_date = ?",
    ).get(storeId, date) as { cursor: string | null; state: string; error: string | null } | undefined;
    return row ?? null;
  }

  public saveDayCheckpoint(storeId: string, date: string, cursor: string | null, state: "running" | "completed" | "failed", error: string | null = null): void {
    this.database.prepare(
      `INSERT INTO finance_sync_days (store_id, accrual_date, cursor, state, error, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (store_id, accrual_date) DO UPDATE SET
         cursor = excluded.cursor, state = excluded.state, error = excluded.error, updated_at_ms = excluded.updated_at_ms`,
    ).run(storeId, date, cursor, state, error, Date.now());
  }

  public listPostingsForMonth(storeIds: string[], fromMs: number, toMs: number): FinancePostingRecord[] {
    const filter = storeIds.length > 0 ? ` AND p.store_id IN (${placeholders(storeIds)})` : "";
    const rows = this.database.prepare(
      `SELECT p.id, p.store_id, s.name AS store_name, s.color AS store_color,
              p.posting_number, p.order_number, p.shipment_at_ms, p.shipment_time_source,
              p.currency, p.status, i.id AS item_id, i.sku AS item_sku, i.offer_id AS item_offer_id,
              i.name AS item_name, i.quantity AS item_quantity, i.currency AS item_currency
       FROM postings p
       JOIN stores s ON s.id = p.store_id
       LEFT JOIN posting_items i ON i.posting_id = p.id
       WHERE s.platform = 'ozon' AND p.shipment_at_ms >= ? AND p.shipment_at_ms < ?${filter}
       ORDER BY s.name ASC, p.posting_number ASC, i.sku ASC`,
    ).all(fromMs, toMs, ...storeIds) as PostingRow[];
    const postings = new Map<string, FinancePostingRecord>();
    for (const row of rows) {
      const current = postings.get(row.id) ?? {
        id: row.id,
        storeId: row.store_id,
        storeName: row.store_name,
        storeColor: row.store_color,
        postingNumber: row.posting_number,
        orderNumber: row.order_number,
        shipmentAtMs: row.shipment_at_ms,
        shipmentTimeSource: row.shipment_time_source,
        currency: row.currency,
        status: row.status,
        items: [],
      };
      if (row.item_id && row.item_sku && row.item_offer_id && row.item_name !== null && row.item_quantity && row.item_currency) {
        current.items.push({ sku: row.item_sku, offerId: row.item_offer_id, name: row.item_name, quantity: row.item_quantity, currency: row.item_currency });
      }
      postings.set(row.id, current);
    }
    return [...postings.values()];
  }

  /** Returns all Ozon postings so exception reports can include orders without shipment timestamps. */
  public listAllPostings(storeIds: string[]): FinancePostingRecord[] {
    return this.listPostingsForMonth(storeIds, 0, Number.MAX_SAFE_INTEGER);
  }

  public getPosting(id: string): FinancePostingRecord | null {
    return this.listPostingsByIds([id])[0] ?? null;
  }

  private listPostingsByIds(ids: string[]): FinancePostingRecord[] {
    if (ids.length === 0) return [];
    const rows = this.database.prepare(
      `SELECT p.id, p.store_id, s.name AS store_name, s.color AS store_color,
              p.posting_number, p.order_number, p.shipment_at_ms, p.shipment_time_source,
              p.currency, p.status, i.id AS item_id, i.sku AS item_sku, i.offer_id AS item_offer_id,
              i.name AS item_name, i.quantity AS item_quantity, i.currency AS item_currency
       FROM postings p JOIN stores s ON s.id = p.store_id
       LEFT JOIN posting_items i ON i.posting_id = p.id
       WHERE p.id IN (${placeholders(ids)})
       ORDER BY p.posting_number ASC, i.sku ASC`,
    ).all(...ids) as PostingRow[];
    const result = new Map<string, FinancePostingRecord>();
    for (const row of rows) {
      const current = result.get(row.id) ?? {
        id: row.id, storeId: row.store_id, storeName: row.store_name, storeColor: row.store_color,
        postingNumber: row.posting_number, orderNumber: row.order_number, shipmentAtMs: row.shipment_at_ms,
        shipmentTimeSource: row.shipment_time_source, currency: row.currency, status: row.status, items: [],
      };
      if (row.item_id && row.item_sku && row.item_offer_id && row.item_name !== null && row.item_quantity && row.item_currency) {
        current.items.push({ sku: row.item_sku, offerId: row.item_offer_id, name: row.item_name, quantity: row.item_quantity, currency: row.item_currency });
      }
      result.set(row.id, current);
    }
    return [...result.values()];
  }

  public listLines(storeIds: string[]): FinanceLineRecord[] {
    const filter = storeIds.length > 0 ? ` WHERE store_id IN (${placeholders(storeIds)})` : "";
    const rows = this.database.prepare(`SELECT * FROM finance_accrual_lines${filter} ORDER BY accrual_date ASC, id ASC`).all(...storeIds) as Array<Record<string, unknown>>;
    return rows.map(toFinanceLine);
  }

  public listLinesForPosting(postingNumber: string, storeId: string): FinanceLineRecord[] {
    const rows = this.database.prepare(
      "SELECT * FROM finance_accrual_lines WHERE store_id = ? AND posting_number = ? ORDER BY accrual_date ASC, id ASC",
    ).all(storeId, postingNumber) as Array<Record<string, unknown>>;
    return rows.map(toFinanceLine);
  }

  public listExceptions(storeIds: string[], fromDate: string, toDate: string): FinanceLineRecord[] {
    const filter = storeIds.length > 0 ? ` AND store_id IN (${placeholders(storeIds)})` : "";
    const rows = this.database.prepare(
      `SELECT * FROM finance_accrual_lines WHERE accrual_date >= ? AND accrual_date <= ?${filter} ORDER BY accrual_date DESC, id DESC`,
    ).all(fromDate, toDate, ...storeIds) as Array<Record<string, unknown>>;
    return rows.map(toFinanceLine);
  }

  public createRun(fromDate: string, toDate: string, totalDays: number, storeIds: string[], mode: "ensure" | "rebuild"): FinanceSyncRunRecord {
    const id = randomUUID();
    const now = Date.now();
    this.database.prepare(
      `INSERT INTO finance_sync_runs (id, from_date, to_date, state, total_days, store_ids_json, sync_mode, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).run(id, fromDate, toDate, totalDays, JSON.stringify([...storeIds].sort()), mode, now, now);
    return this.getRun(id) as FinanceSyncRunRecord;
  }

  public findActiveRun(fromDate: string, toDate: string, storeIds: string[]): FinanceSyncRunRecord | null {
    const rows = this.database.prepare(
      "SELECT * FROM finance_sync_runs WHERE from_date = ? AND to_date = ? AND state IN ('queued', 'running') ORDER BY created_at_ms DESC",
    ).all(fromDate, toDate) as Array<Record<string, unknown>>;
    const expected = JSON.stringify([...storeIds].sort());
    return rows.map(toRun).find((run) => JSON.stringify(run.storeIds) === expected) ?? null;
  }

  public getRun(id: string): FinanceSyncRunRecord | null {
    const row = this.database.prepare("SELECT * FROM finance_sync_runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toRun(row) : null;
  }

  public latestRun(): FinanceSyncRunRecord | null {
    const row = this.database.prepare("SELECT * FROM finance_sync_runs ORDER BY created_at_ms DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    return row ? toRun(row) : null;
  }

  public latestRunForScope(fromDate: string, toDate: string, storeIds: string[]): FinanceSyncRunRecord | null {
    const rows = this.database.prepare(
      "SELECT * FROM finance_sync_runs WHERE from_date = ? AND to_date = ? ORDER BY created_at_ms DESC",
    ).all(fromDate, toDate) as Array<Record<string, unknown>>;
    const expected = JSON.stringify([...storeIds].sort());
    return rows.map(toRun).find((run) => JSON.stringify(run.storeIds) === expected) ?? null;
  }

  public updateRun(id: string, patch: Partial<Pick<FinanceSyncRunRecord, "state" | "completedDays" | "failedDays" | "error" | "startedAtMs" | "finishedAtMs">>): void {
    const current = this.getRun(id);
    if (!current) return;
    this.database.prepare(
      `UPDATE finance_sync_runs SET state = ?, completed_days = ?, failed_days = ?, error = ?,
       started_at_ms = ?, finished_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
    ).run(
      patch.state ?? current.state,
      patch.completedDays ?? current.completedDays,
      patch.failedDays ?? current.failedDays,
      patch.error ?? current.error,
      patch.startedAtMs ?? current.startedAtMs,
      patch.finishedAtMs ?? current.finishedAtMs,
      Date.now(),
      id,
    );
  }

  public saveCashFlowReport(storeId: string, fromDate: string, toDate: string, raw: unknown): void {
    this.database.prepare(
      `INSERT INTO finance_cash_flow_reports (store_id, from_date, to_date, raw_json, fetched_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (store_id, from_date, to_date) DO UPDATE SET raw_json = excluded.raw_json, fetched_at_ms = excluded.fetched_at_ms`,
    ).run(storeId, fromDate, toDate, JSON.stringify(raw), Date.now());
  }

  /** Returns whether every calendar day in the requested range completed successfully. */
  public hasCompleteFinanceCoverage(storeId: string, fromDate: string, toDate: string): boolean {
    const fromMs = Date.parse(`${fromDate}T00:00:00.000Z`);
    const toMs = Date.parse(`${toDate}T00:00:00.000Z`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
      return false;
    }
    const expectedDays = Math.floor((toMs - fromMs) / 86_400_000) + 1;
    const row = this.database.prepare(
      `SELECT COUNT(DISTINCT accrual_date) AS completed_days
       FROM finance_sync_days
       WHERE store_id = ? AND accrual_date >= ? AND accrual_date <= ? AND state = 'completed'`,
    ).get(storeId, fromDate, toDate) as { completed_days: number };
    return Number(row.completed_days) === expectedDays;
  }

  public getFinanceCoverage(storeIds: string[], fromDate: string, toDate: string): Map<string, { completedDates: string[]; failedDates: string[]; lastSyncedAtMs: number | null }> {
    if (storeIds.length === 0) return new Map();
    const rows = this.database.prepare(
      `SELECT store_id, accrual_date, state, updated_at_ms
       FROM finance_sync_days
       WHERE store_id IN (${placeholders(storeIds)}) AND accrual_date >= ? AND accrual_date <= ?
       ORDER BY store_id ASC, accrual_date ASC`,
    ).all(...storeIds, fromDate, toDate) as Array<{ store_id: string; accrual_date: string; state: string; updated_at_ms: number }>;
    const result = new Map<string, { completedDates: string[]; failedDates: string[]; lastSyncedAtMs: number | null }>();
    for (const storeId of storeIds) result.set(storeId, { completedDates: [], failedDates: [], lastSyncedAtMs: null });
    for (const row of rows) {
      const current = result.get(row.store_id);
      if (!current) continue;
      if (row.state === "completed") current.completedDates.push(row.accrual_date);
      if (row.state === "failed") current.failedDates.push(row.accrual_date);
      current.lastSyncedAtMs = Math.max(current.lastSyncedAtMs ?? 0, Number(row.updated_at_ms));
    }
    return result;
  }
}
