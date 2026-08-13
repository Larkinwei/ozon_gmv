import { join } from "node:path";

import { subHours } from "date-fns";

import { buildAdminApp, buildWallboardApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase, closeDatabase } from "./db/database";
import { runMigrations } from "./db/migrate";
import { PostingsRepository } from "./db/postings-repository";
import { ProductImagesRepository } from "./db/product-images-repository";
import { SettingsRepository } from "./db/settings-repository";
import { StoresRepository } from "./db/stores-repository";
import { SyncCheckpointsRepository } from "./db/sync-checkpoints-repository";
import { DashboardEventBus } from "./realtime/event-bus";
import { SelectionModule } from "./selection/selection-module";
import { CategoryAnalysisModule } from "./selection/category-analysis-module";
import { DiscoveryModule } from "./selection/discovery-module";
import { WordstatClient } from "./selection/wordstat-client";
import { BackupService } from "./services/backup-service";
import { ProxySettingsService } from "./services/proxy-settings-service";
import { ProductImageService } from "./services/product-image-service";
import { startScheduler } from "./services/scheduler";
import { SyncService } from "./services/sync-service";
import { UpdateService } from "./services/update-service";

const config = loadConfig();
const database = openDatabase(join(config.DATA_DIR, "data"));
runMigrations(database);

const events = new DashboardEventBus();
const stores = new StoresRepository(database);
const proxySettings = new ProxySettingsService(config, new SettingsRepository(database));
const productImages = new ProductImageService(new ProductImagesRepository(database));
const syncService = new SyncService(
  config,
  stores,
  new PostingsRepository(database),
  new SyncCheckpointsRepository(database),
  events,
  proxySettings,
  productImages,
);
const updates = new UpdateService(config, proxySettings);
const selection = new SelectionModule(config, database, {
  wordstatFactory: (folderId, apiKey) => new WordstatClient({
    folderId,
    apiKey,
    fetchImplementation: proxySettings.createFetch(),
  }),
});
selection.start();
const categories = new CategoryAnalysisModule(config, database, {
  fetchImplementation: proxySettings.createFetch(),
});
categories.start();
const discovery = new DiscoveryModule(config, database, {
  fetchImplementation: proxySettings.createFetch(),
});
const dependencies = { config, database, events, syncService, proxySettings, updates, selection, categories, discovery };
const adminApp = await buildAdminApp(dependencies);
const wallboardApp = await buildWallboardApp(dependencies);
const scheduler = startScheduler(syncService);
const backups = new BackupService(database, join(config.DATA_DIR, "backups"));
backups.start();

await adminApp.listen({ host: config.ADMIN_HOST, port: config.ADMIN_PORT });
await wallboardApp.listen({ host: config.WALLBOARD_HOST, port: config.WALLBOARD_PORT });
await updates.start();
void discovery.start().then((refreshed) => {
  if (refreshed) {
    adminApp.log.info("Latest shared market snapshot loaded into SQLite");
  }
}).catch((error: unknown) => {
  adminApp.log.warn({ err: error }, "Startup market snapshot refresh failed; retaining local cache");
});
adminApp.log.info(
  { adminPort: config.ADMIN_PORT, wallboardPort: config.WALLBOARD_PORT },
  "Ozon GMV local service is ready",
);

const now = new Date();
void syncService.syncActiveStores(subHours(now, 24), now, undefined, 5_000).catch((error: unknown) => {
  adminApp.log.warn({ err: error }, "Startup reconciliation will retry in the background");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  adminApp.log.info({ signal }, "Shutting down");
  scheduler.stop();
  backups.stop();
  updates.stop();
  await selection.stop();
  await categories.stop();
  await discovery.stop();
  await Promise.all([adminApp.close(), wallboardApp.close()]);
  closeDatabase(database);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
