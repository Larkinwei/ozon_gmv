import { describe, expect, it } from "vitest";

import { buildAdminApp } from "../src/server/app";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { ProductImageService } from "../src/server/services/product-image-service";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { SyncService } from "../src/server/services/sync-service";
import { UpdateService } from "../src/server/services/update-service";
import { createTestDatabase } from "./test-context";

const boundary = "----ozon-my-data-test-boundary";
const header = "SKU,商品名,当前价(₽),月销量,月销售额(₽),展示量,转化率(%),折扣(%),关键词,URL,主图,状态,采集时间";

function multipart(files: Array<{ name: string; content: string }>): Buffer {
  const chunks: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="folderName"\r\n\r\n0817\r\n`), ...files.flatMap((file) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n${file.content}\r\n`),
  ]), Buffer.from(`--${boundary}--\r\n`)];
  return Buffer.concat(chunks);
}

describe("MY data admin API", () => {
  it("imports multiple CSV files, filters snapshots and protects clear endpoint", async () => {
    const context = createTestDatabase();
    const events = new DashboardEventBus();
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxySettings = new ProxySettingsService(context.config, settings);
    const syncService = new SyncService(context.config, new StoresRepository(context.database), new PostingsRepository(context.database), new SyncCheckpointsRepository(context.database), events, proxySettings, new ProductImageService(new ProductImagesRepository(context.database)));
    const app = await buildAdminApp({ config: context.config, database: context.database, events, syncService, proxySettings, updates: new UpdateService(context.config, proxySettings) });
    try {
      const unauthorized = await app.inject({ method: "GET", url: "/api/selection/my/overview" });
      expect(unauthorized.statusCode).toBe(401);
      const setup = await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { username: "admin", password: "correct-horse-battery-staple" } });
      const cookie = setup.cookies.find((item) => item.name === "ozon_session")?.value ?? "";
      const body = multipart([
        { name: "one.csv", content: `\uFEFF${header}\n1001,商品 A,0,10,100,1000,1,0,рюкзак,https://ozon.ru/p/1001,,local,2026-08-17T03:20:24Z\n` },
        { name: "two.csv", content: `\uFEFF${header}\n1002,商品 B,0,20,600,1000,2,0,рюкзак,https://ozon.ru/p/1002,,local,2026-08-17T03:20:24Z\n` },
      ]);
      const imported = await app.inject({ method: "POST", url: "/api/selection/my/imports", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, cookies: { ozon_session: cookie }, payload: body });
      expect(imported.statusCode).toBe(201);
      expect(imported.json()).toMatchObject({ importedFiles: 2, validRows: 2 });
      const products = await app.inject({ method: "GET", url: "/api/selection/my/products?captureDay=2026-08-17&minAov=30", cookies: { ozon_session: cookie } });
      expect(products.statusCode).toBe(200);
      expect(products.json()).toMatchObject({ total: 1, items: [{ sku: "1002" }] });
      const clear = await app.inject({ method: "DELETE", url: "/api/selection/my/data", cookies: { ozon_session: cookie } });
      expect(clear.statusCode).toBe(204);
    } finally {
      await app.close();
      context.cleanup();
    }
  });
});
