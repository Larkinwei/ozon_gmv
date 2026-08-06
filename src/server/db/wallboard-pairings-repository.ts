import { randomUUID } from "node:crypto";

import type { AppDatabase } from "./database";
import { SettingsRepository } from "./settings-repository";

const GENERATION_KEY = "wallboard.session_generation";

interface PairingRow {
  id: string;
  expires_at_ms: number;
}

export interface WallboardPairingRecord {
  id: string;
  expiresAt: number;
  usedAt: number | null;
}

/** Persists one-time LAN pairing tokens and the global session revocation generation. */
export class WallboardPairingsRepository {
  private readonly settings: SettingsRepository;

  public constructor(private readonly database: AppDatabase) {
    this.settings = new SettingsRepository(database);
  }

  public create(tokenHash: string, expiresAt: number): WallboardPairingRecord {
    const record = { id: randomUUID(), expiresAt, usedAt: null };
    this.database
      .prepare(
        `INSERT INTO wallboard_pairings (id, token_hash, expires_at_ms, used_at_ms, created_at_ms)
         VALUES (?, ?, ?, NULL, ?)`,
      )
      .run(record.id, tokenHash, expiresAt, Date.now());
    return record;
  }

  /** Consumes a valid token exactly once inside a write transaction. */
  public consume(tokenHash: string, now = Date.now()): WallboardPairingRecord | null {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT id, expires_at_ms
           FROM wallboard_pairings
           WHERE token_hash = ? AND used_at_ms IS NULL AND expires_at_ms > ?`,
        )
        .get(tokenHash, now) as PairingRow | undefined;
      if (!row) {
        return null;
      }
      const result = this.database
        .prepare("UPDATE wallboard_pairings SET used_at_ms = ? WHERE id = ? AND used_at_ms IS NULL")
        .run(now, row.id);
      if (result.changes !== 1) {
        return null;
      }
      return { id: row.id, expiresAt: row.expires_at_ms, usedAt: now };
    })();
  }

  public generation(): number {
    const stored = Number(this.settings.get(GENERATION_KEY) ?? "1");
    return Number.isSafeInteger(stored) && stored > 0 ? stored : 1;
  }

  /** Invalidates every issued read-only wallboard session. */
  public revokeAll(): number {
    const generation = this.generation() + 1;
    this.database.transaction(() => {
      this.settings.set(GENERATION_KEY, String(generation));
      this.database.prepare("DELETE FROM wallboard_pairings").run();
    })();
    return generation;
  }
}
