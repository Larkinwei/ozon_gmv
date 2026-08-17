import BetterSqlite3 from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../src/server/db/migrate";
import { MyDataModule } from "../src/server/selection/my-data-module";

const header = "SKU,商品名,当前价(₽),月销量,月销售额(₽),展示量,转化率(%),折扣(%),关键词,URL,主图,状态,采集时间";

function csv(rows: string[]): Buffer {
  return Buffer.from(`\uFEFF${header}\n${rows.join("\n")}\n`, "utf8");
}

describe("MyDataModule", () => {
  it("imports a folder, calculates snapshot metrics and skips the same file on repeat", () => {
    const database = new BetterSqlite3(":memory:");
    runMigrations(database, fileURLToPath(new URL("../migrations", import.meta.url)));
    const module = new MyDataModule(database);
    const file = { fileName: "MY采集_2026-08-17.csv", content: csv([
      "1001,商品 A,0,10,1234.500,1000,2.5,10,,https://ozon.ru/p/1001,https://cdn.test/a.jpg,local,2026-08-17T03:20:24Z",
    ]) };

    const preview = module.previewImport([file], "0817");
    expect(preview.validRows).toBe(1);
    expect(preview.captureDays).toEqual(["2026-08-17"]);

    const result = module.commitImport([file], "0817");
    expect(result.importedFiles).toBe(1);
    expect(module.commitImport([file], "0817").duplicateFiles).toBe(1);
    expect(module.getOverview("2026-08-17").monthlySales.amount).toBe("1234.5");
    expect(module.listProducts({ page: 1, pageSize: 20, sort: "averageOrderValue", captureDay: "2026-08-17" }).items[0]?.averageOrderValue?.amount).toBe("123.45");
    database.close();
  });

  it("keeps different days and keywords as separate snapshots, and rejects malformed rows without losing valid rows", () => {
    const database = new BetterSqlite3(":memory:");
    runMigrations(database, fileURLToPath(new URL("../migrations", import.meta.url)));
    const module = new MyDataModule(database);
    const files = [
      { fileName: "day-1.csv", content: csv(["1001,商品 A,0,10,100,1000,1,0,рюкзак,https://ozon.ru/p/1001,,local,2026-08-17T03:20:24Z", "bad,broken"]) },
      { fileName: "day-2.csv", content: csv(["1001,商品 A,0,20,300,1000,1,0,рюкзак,https://ozon.ru/p/1001,,local,2026-08-18T03:20:24Z", "1001,商品 A,0,30,600,1000,1,0,сумка,https://ozon.ru/p/1001,,local,2026-08-18T03:20:25Z"]) },
    ];
    const result = module.commitImport(files, "multi-day");
    expect(result.validRows).toBe(3);
    expect(result.invalidRows).toBe(1);
    expect(module.listProducts({ page: 1, pageSize: 20, sort: "monthlyUnits", from: "2026-08-17", to: "2026-08-18" }).total).toBe(3);
    expect(module.getOverview("2026-08-18").productCount).toBe(2);
    module.clearData();
    expect(module.getOverview().productCount).toBe(0);
    database.close();
  });
});
