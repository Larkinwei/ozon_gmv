import type { AppDatabase } from "./database";

export interface AdministratorRecord {
  username: string;
  passwordHash: string;
}

interface AdministratorRow {
  username: string;
  password_hash: string;
}

/** Owns the single local administrator account created by the setup wizard. */
export class AdminRepository {
  public constructor(private readonly database: AppDatabase) {}

  public isInitialized(): boolean {
    return this.database.prepare("SELECT 1 FROM administrators LIMIT 1").get() !== undefined;
  }

  public find(): AdministratorRecord | null {
    const row = this.database
      .prepare("SELECT username, password_hash FROM administrators ORDER BY created_at_ms ASC LIMIT 1")
      .get() as AdministratorRow | undefined;
    return row ? { username: row.username, passwordHash: row.password_hash } : null;
  }

  /** Creates the only administrator and fails atomically if setup already ran. */
  public create(username: string, passwordHash: string): AdministratorRecord {
    this.database
      .prepare(
        "INSERT INTO administrators (id, username, password_hash, created_at_ms, updated_at_ms) VALUES (1, ?, ?, ?, ?)",
      )
      .run(username, passwordHash, Date.now(), Date.now());
    return { username, passwordHash };
  }
}
