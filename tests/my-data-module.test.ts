import BetterSqlite3 from "better-sqlite3";
import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../src/server/db/migrate";
import { MyDataModule } from "../src/server/selection/my-data-module";

const header = "SKU,商品名,当前价(₽),月销量,月销售额(₽),展示量,转化率(%),折扣(%),关键词,URL,主图,状态,采集时间";

function csv(rows: string[]): Buffer {
  return Buffer.from(`\uFEFF${header}\n${rows.join("\n")}\n`, "utf8");
}

describe("MyDataModule", () => {
  it("imports a folder, calculates snapshot metrics and skips the same file on repeat", async () => {
    const database = new BetterSqlite3(":memory:");
    runMigrations(database, fileURLToPath(new URL("../migrations", import.meta.url)));
    const module = new MyDataModule(database);
    const file = { fileName: "MY采集_2026-08-17.csv", content: csv([
      "1001,商品 A,0,10,1234.500,1000,2.5,10,,https://ozon.ru/p/1001,https://cdn.test/a.jpg,local,2026-08-17T03:20:24Z",
    ]) };

    const preview = await module.previewImport([file], "0817");
    expect(preview.validRows).toBe(1);
    expect(preview.captureDays).toEqual(["2026-08-17"]);

    const result = await module.commitImport([file], "0817");
    expect(result.importedFiles).toBe(1);
    expect((await module.commitImport([file], "0817")).duplicateFiles).toBe(1);
    expect(module.getOverview("2026-08-17").monthlySales.amount).toBe("1234.5");
    expect(module.listProducts({ page: 1, pageSize: 20, sort: "averageOrderValue", captureDay: "2026-08-17" }).items[0]?.averageOrderValue?.amount).toBe("123.45");
    database.close();
  });

  it("keeps different days and keywords as separate snapshots, and rejects malformed rows without losing valid rows", async () => {
    const database = new BetterSqlite3(":memory:");
    runMigrations(database, fileURLToPath(new URL("../migrations", import.meta.url)));
    const module = new MyDataModule(database);
    const files = [
      { fileName: "day-1.csv", content: csv(["1001,商品 A,0,10,100,1000,1,0,рюкзак,https://ozon.ru/p/1001,,local,2026-08-17T03:20:24Z", "bad,broken"]) },
      { fileName: "day-2.csv", content: csv(["1001,商品 A,0,20,300,1000,1,0,рюкзак,https://ozon.ru/p/1001,,local,2026-08-18T03:20:24Z", "1001,商品 A,0,30,600,1000,1,0,сумка,https://ozon.ru/p/1001,,local,2026-08-18T03:20:25Z"]) },
    ];
    const result = await module.commitImport(files, "multi-day");
    expect(result.validRows).toBe(3);
    expect(result.invalidRows).toBe(1);
    expect(module.listProducts({ page: 1, pageSize: 20, sort: "monthlyUnits", from: "2026-08-17", to: "2026-08-18" }).total).toBe(3);
    expect(module.listProducts({ page: 1, pageSize: 20, sort: "monthlyUnits", allDates: true }).total).toBe(3);
    expect(module.getOverview("2026-08-18").productCount).toBe(2);
    module.clearData();
    expect(module.getOverview().productCount).toBe(0);
    database.close();
  });

  it("imports XLSX snapshots and recognizes an explicit fulfillment column", async () => {
    const database = new BetterSqlite3(":memory:");
    runMigrations(database, fileURLToPath(new URL("../migrations", import.meta.url)));
    const module = new MyDataModule(database);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("MY");
    worksheet.addRow([...header.split(","), "发货模式"]);
    worksheet.addRow(["2001", "商品 B", 0, 4, 100, 100, 1, 0, "", "https://ozon.ru/p/2001", "", "ok", "2026-08-18T03:20:24Z", "FBS"]);
    const content = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await module.commitImport([{ fileName: "day.xlsx", content }], "xlsx");
    expect(result.validRows).toBe(1);
    expect(module.listProducts({ page: 1, pageSize: 20, sort: "monthlyUnits", captureDay: "2026-08-18" }).items[0]?.fulfillmentMode).toBe("FBS");
    database.close();
  });

  it("imports an optional category column and keeps legacy files compatible", async () => {
    const database = new BetterSqlite3(":memory:");
    runMigrations(database, fileURLToPath(new URL("../migrations", import.meta.url)));
    const module = new MyDataModule(database);
    const content = Buffer.from(`\uFEFF${header},发货模式,类目\n3001,商品 C,0,3,90,100,1,0,,https://ozon.ru/p/3001,,local,2026-08-18T03:20:24Z,FBO,Дом и сад/Органайзеры`, "utf8");

    const result = await module.commitImport([{ fileName: "category.csv", content }], "category");
    expect(result.validRows).toBe(1);
    expect(module.listProducts({ page: 1, pageSize: 20, sort: "monthlyUnits", captureDay: "2026-08-18" }).items[0]?.category).toBe("Дом и сад/Органайзеры");
    database.close();
  });

  it("filters by category and fulfillment mode and keeps facet options stable", async () => {
    const database = new BetterSqlite3(":memory:");
    runMigrations(database, fileURLToPath(new URL("../migrations", import.meta.url)));
    const module = new MyDataModule(database);
    const content = Buffer.from(`\uFEFF${header},发货模式,类目\n4001,商品 D,0,8,80,100,1,0,,https://ozon.ru/p/4001,,local,2026-08-18T03:20:24Z,FBO,家居/收纳\n4002,商品 E,0,6,60,100,1,0,,https://ozon.ru/p/4002,,local,2026-08-18T03:20:25Z,FBS,宠物/玩具`, "utf8");

    await module.commitImport([{ fileName: "filters.csv", content }], "filters");
    const filtered = module.listProducts({ page: 1, pageSize: 20, sort: "monthlyUnits", allDates: true, category: "宠物/玩具", fulfillmentMode: "FBS" });
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]).toMatchObject({ sku: "4002", category: "宠物/玩具", fulfillmentMode: "FBS" });
    expect(filtered.facets.categories).toEqual(expect.arrayContaining(["家居/收纳", "宠物/玩具"]));
    expect(filtered.facets.fulfillmentModes).toEqual(["FBO", "FBS"]);
    database.close();
  });

  it("enriches a duplicate file without overwriting existing fields", async () => {
    const database = new BetterSqlite3(":memory:");
    runMigrations(database, fileURLToPath(new URL("../migrations", import.meta.url)));
    const module = new MyDataModule(database);
    const content = Buffer.from(`\uFEFF${header},发货模式,类目\n5001,商品 F,0,8,80,100,1,0,,https://ozon.ru/p/5001,,local,2026-08-18T03:20:24Z,FBS,家居/收纳`, "utf8");

    await module.commitImport([{ fileName: "enrich.csv", content }], "enrich");
    database.prepare("UPDATE my_product_snapshots SET fulfillment_mode = 'unknown' WHERE sku = '5001'").run();
    database.prepare("UPDATE my_product_snapshot_categories SET category = '' WHERE snapshot_id = (SELECT id FROM my_product_snapshots WHERE sku = '5001')").run();
    const result = await module.commitImport([{ fileName: "enrich.csv", content }], "enrich-again");
    expect(result.duplicateFiles).toBe(1);
    expect(module.listProducts({ page: 1, pageSize: 20, sort: "monthlyUnits", captureDay: "2026-08-18" }).items[0]).toMatchObject({ category: "家居/收纳", fulfillmentMode: "FBS" });

    database.prepare("UPDATE my_product_snapshots SET fulfillment_mode = 'FBO' WHERE sku = '5001'").run();
    database.prepare("UPDATE my_product_snapshot_categories SET category = '已确认类目' WHERE snapshot_id = (SELECT id FROM my_product_snapshots WHERE sku = '5001')").run();
    await module.commitImport([{ fileName: "enrich.csv", content }], "enrich-third");
    expect(module.listProducts({ page: 1, pageSize: 20, sort: "monthlyUnits", captureDay: "2026-08-18" }).items[0]).toMatchObject({ category: "已确认类目", fulfillmentMode: "FBO" });
    database.close();
  });
});
