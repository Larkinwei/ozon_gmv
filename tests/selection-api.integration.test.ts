import { describe, expect, it } from "vitest";

import { buildAdminApp, buildWallboardApp } from "../src/server/app";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { SelectionModule } from "../src/server/selection/selection-module";
import { ProductImageService } from "../src/server/services/product-image-service";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { SyncService } from "../src/server/services/sync-service";
import { UpdateService } from "../src/server/services/update-service";
import { marketProductWorkbook } from "./selection-fixtures";
import { createTestDatabase } from "./test-context";

function multipartBody(fields: Record<string, string>, file: { name: string; content: Buffer }): {
  boundary: string;
  body: Buffer;
} {
  const boundary = "----ozon-selection-test-boundary";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
    + "Content-Type: text/csv\r\n\r\n",
  ));
  chunks.push(file.content, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { boundary, body: Buffer.concat(chunks) };
}

describe("product selection admin API", () => {
  it("protects selection data and keeps it off the LAN wallboard", async () => {
    const context = createTestDatabase();
    const events = new DashboardEventBus();
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxySettings = new ProxySettingsService(context.config, settings);
    const syncService = new SyncService(
      context.config,
      new StoresRepository(context.database),
      new PostingsRepository(context.database),
      new SyncCheckpointsRepository(context.database),
      events,
      proxySettings,
      new ProductImageService(new ProductImagesRepository(context.database)),
    );
    const selection = new SelectionModule(context.config, context.database);
    await selection.commitImport({
      fileName: "queries.csv",
      content: Buffer.from([
        "关键词,搜索次数,加购率,下单率,均价",
        ...Array.from({ length: 10 }, (_, index) => `词${index + 1},${index + 1}00,${index + 1}%,${index + 1}%,1000`),
      ].join("\n")),
      snapshotDate: "2026-08-11",
      mapping: {
        phrase: "关键词",
        searchCount: "搜索次数",
        cartRate: "加购率",
        cartRateUnit: "percent",
        orderRate: "下单率",
        orderRateUnit: "percent",
        averagePrice: "均价",
      },
    });
    await selection.commitImport({
      fileName: "analytics_report_2026-08-11_17_07.xlsx",
      content: await marketProductWorkbook(),
      snapshotDate: "2026-08-11",
    });
    const dependencies = {
      config: context.config,
      database: context.database,
      events,
      syncService,
      proxySettings,
      updates: new UpdateService(context.config, proxySettings),
      selection,
    };
    const adminApp = await buildAdminApp(dependencies);
    const wallboardApp = await buildWallboardApp(dependencies);

    try {
      expect((await adminApp.inject({ method: "GET", url: "/api/selection/overview" })).statusCode).toBe(401);
      expect((await adminApp.inject({ method: "GET", url: "/api/selection/products" })).statusCode).toBe(401);
      expect((await adminApp.inject({ method: "GET", url: "/api/selection/categories" })).statusCode).toBe(401);
      expect((await adminApp.inject({ method: "GET", url: "/api/selection/rankings/products" })).statusCode).toBe(401);
      expect((await adminApp.inject({ method: "GET", url: "/api/selection/rankings/queries" })).statusCode).toBe(401);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/selection/overview" })).statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/selection/products" })).statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/selection/categories" })).statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/selection/rankings/products" })).statusCode).toBe(404);
      expect((await wallboardApp.inject({ method: "GET", url: "/api/selection/rankings/queries" })).statusCode).toBe(404);
      const setup = await adminApp.inject({
        method: "POST",
        url: "/api/setup/initialize",
        payload: { username: "admin", password: "correct-horse-battery-staple" },
      });
      const cookie = setup.cookies.find((item) => item.name === "ozon_session")?.value ?? "";
      const overview = await adminApp.inject({
        method: "GET",
        url: "/api/selection/overview",
        cookies: { ozon_session: cookie },
      });
      expect(overview.json()).toMatchObject({ keywordCount: 10, scoredKeywordCount: 10, marketProductCount: 1 });
      const products = await adminApp.inject({
        method: "GET",
        url: "/api/selection/products?page=1&pageSize=20&sort=orderedAmount&search=%E6%B0%B4",
        cookies: { ozon_session: cookie },
      });
      expect(products.statusCode).toBe(200);
      expect(products.json()).toMatchObject({ total: 1, items: [{ categoryLevel3: "洗发水" }] });
      const uploadFile = {
        name: "new-queries.csv",
        content: Buffer.from("词,搜索,加购,下单\n新增词,88,8%,4%"),
      };
      const previewUpload = multipartBody({}, uploadFile);
      const preview = await adminApp.inject({
        method: "POST",
        url: "/api/selection/imports/preview",
        headers: { "content-type": `multipart/form-data; boundary=${previewUpload.boundary}` },
        cookies: { ozon_session: cookie },
        payload: previewUpload.body,
      });
      expect(preview.json()).toMatchObject({ headers: ["词", "搜索", "加购", "下单"], totalDataRows: 1 });
      const importUpload = multipartBody({
        snapshotDate: "2026-08-12",
        mapping: JSON.stringify({
          phrase: "词",
          searchCount: "搜索",
          cartRate: "加购",
          cartRateUnit: "percent",
          orderRate: "下单",
          orderRateUnit: "percent",
        }),
      }, uploadFile);
      const imported = await adminApp.inject({
        method: "POST",
        url: "/api/selection/imports",
        headers: { "content-type": `multipart/form-data; boundary=${importUpload.boundary}` },
        cookies: { ozon_session: cookie },
        payload: importUpload.body,
      });
      expect(imported.statusCode).toBe(201);
      const duplicate = await adminApp.inject({
        method: "POST",
        url: "/api/selection/imports",
        headers: { "content-type": `multipart/form-data; boundary=${importUpload.boundary}` },
        cookies: { ozon_session: cookie },
        payload: importUpload.body,
      });
      expect(duplicate.statusCode).toBe(409);
      const keywords = await adminApp.inject({
        method: "GET",
        url: "/api/selection/keywords?page=1&pageSize=20&sort=demandScore",
        cookies: { ozon_session: cookie },
      });
      const keywordId = keywords.json<{ items: Array<{ id: string }> }>().items[0]!.id;
      const unconfiguredWordstat = await adminApp.inject({
        method: "POST",
        url: "/api/selection/wordstat/jobs",
        cookies: { ozon_session: cookie },
        payload: { keywordIds: [keywordId], force: false },
      });
      expect(unconfiguredWordstat.statusCode).toBe(409);
      expect(unconfiguredWordstat.json()).toMatchObject({ message: "请先配置 Wordstat Folder ID 和 API Key" });
      const candidate = await adminApp.inject({
        method: "POST",
        url: "/api/selection/candidates",
        cookies: { ozon_session: cookie },
        payload: { keywordId, name: "测试候选品" },
      });
      expect(candidate.statusCode).toBe(201);
      expect(candidate.json()).toMatchObject({ status: "watching", keyword: { id: keywordId } });
    } finally {
      await Promise.all([adminApp.close(), wallboardApp.close()]);
      context.cleanup();
    }
  });
});
