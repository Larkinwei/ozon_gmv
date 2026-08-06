import type { AppDatabase } from "./database";

interface SettingRow {
  value: string;
}

/** Provides the machine-local settings store without leaking SQL into services. */
export class SettingsRepository {
  public constructor(private readonly database: AppDatabase) {}

  public get(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as SettingRow | undefined;
    return row?.value ?? null;
  }

  public set(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(key, value, Date.now());
  }

  public delete(key: string): void {
    this.database.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
  }
}
