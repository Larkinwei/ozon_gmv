import { randomUUID } from "node:crypto";

import type { AppDatabase } from "./database";

export interface PricingScenarioRecord {
  id: string;
  name: string;
  sku: string | null;
  mode: "target-price" | "existing-price";
  inputs: unknown;
  feeRates: unknown;
  exchangeRate: string;
  exchangeSource: string | null;
  exchangeEffectiveDate: string | null;
  ruleVersion: string;
  result: unknown;
  risk: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PricingScenarioCreateRecord {
  name: string;
  sku: string | null;
  mode: "target-price" | "existing-price";
  inputs: unknown;
  feeRates: unknown;
  exchangeRate: string;
  exchangeSource: string | null;
  exchangeEffectiveDate: string | null;
  ruleVersion: string;
  result: unknown;
  risk: unknown;
}

interface ScenarioRow {
  id: string;
  name: string;
  sku: string | null;
  mode: "target-price" | "existing-price";
  inputs_json: string;
  fee_rates_json: string;
  exchange_rate: string;
  exchange_source: string | null;
  exchange_effective_date: string | null;
  rule_version: string;
  result_json: string;
  risk_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}

function toScenario(row: ScenarioRow): PricingScenarioRecord {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    mode: row.mode,
    inputs: parseJson(row.inputs_json),
    feeRates: parseJson(row.fee_rates_json),
    exchangeRate: row.exchange_rate,
    exchangeSource: row.exchange_source,
    exchangeEffectiveDate: row.exchange_effective_date,
    ruleVersion: row.rule_version,
    result: parseJson(row.result_json),
    risk: parseJson(row.risk_json),
    createdAt: toIso(row.created_at_ms),
    updatedAt: toIso(row.updated_at_ms),
  };
}

/** Stores immutable browser-calculation snapshots on the current machine. */
export class PricingScenariosRepository {
  public constructor(private readonly database: AppDatabase) {}

  public list(query?: string, limit = 50): PricingScenarioRecord[] {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const normalizedQuery = query?.trim() ?? "";
    const rows = normalizedQuery
      ? this.database.prepare(
        `SELECT * FROM pricing_scenarios
         WHERE name LIKE ? OR sku LIKE ?
         ORDER BY created_at_ms DESC LIMIT ?`,
      ).all(`%${normalizedQuery}%`, `%${normalizedQuery}%`, normalizedLimit) as ScenarioRow[]
      : this.database.prepare(
        "SELECT * FROM pricing_scenarios ORDER BY created_at_ms DESC LIMIT ?",
      ).all(normalizedLimit) as ScenarioRow[];
    return rows.map(toScenario);
  }

  public get(id: string): PricingScenarioRecord | null {
    const row = this.database.prepare("SELECT * FROM pricing_scenarios WHERE id = ?").get(id) as ScenarioRow | undefined;
    return row ? toScenario(row) : null;
  }

  public create(input: PricingScenarioCreateRecord): PricingScenarioRecord {
    const id = randomUUID();
    const now = Date.now();
    this.database.prepare(
      `INSERT INTO pricing_scenarios (
        id, name, sku, mode, inputs_json, fee_rates_json, exchange_rate,
        exchange_source, exchange_effective_date, rule_version, result_json,
        risk_json, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.sku,
      input.mode,
      JSON.stringify(input.inputs),
      JSON.stringify(input.feeRates),
      input.exchangeRate,
      input.exchangeSource,
      input.exchangeEffectiveDate,
      input.ruleVersion,
      JSON.stringify(input.result),
      JSON.stringify(input.risk),
      now,
      now,
    );
    return this.get(id) as PricingScenarioRecord;
  }

  public delete(id: string): boolean {
    return this.database.prepare("DELETE FROM pricing_scenarios WHERE id = ?").run(id).changes > 0;
  }
}
