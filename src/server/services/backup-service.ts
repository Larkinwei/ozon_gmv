import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { AppDatabase } from "../db/database";

const DAY_MS = 24 * 60 * 60 * 1000;

function backupTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/** Creates SQLite online backups and prunes only recognized backup files older than retention. */
export class BackupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly database: AppDatabase,
    private readonly backupDir: string,
    private readonly retentionDays = 30,
  ) {
    mkdirSync(backupDir, { recursive: true });
  }

  public async create(reason: "daily" | "upgrade" | "manual" = "manual"): Promise<string> {
    const target = join(this.backupDir, `ozon-gmv-${reason}-${backupTimestamp(new Date())}.db`);
    await this.database.backup(target);
    this.prune();
    return target;
  }

  public start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.create("daily").catch(() => undefined);
    }, DAY_MS);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.retentionDays * DAY_MS;
    for (const name of readdirSync(this.backupDir)) {
      if (!/^ozon-gmv-(daily|upgrade|manual)-.+\.db$/.test(name)) {
        continue;
      }
      const path = join(this.backupDir, name);
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path);
      }
    }
  }
}
