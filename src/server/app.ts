import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { AppConfig } from "./config";
import { AdminRepository } from "./db/admin-repository";
import { DashboardRepository } from "./db/dashboard-repository";
import type { AppDatabase } from "./db/database";
import { SettingsRepository } from "./db/settings-repository";
import { StoresRepository } from "./db/stores-repository";
import { WallboardPairingsRepository } from "./db/wallboard-pairings-repository";
import type { DashboardEventBus } from "./realtime/event-bus";
import { registerAuthRoutes } from "./routes/auth";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerNotificationRoutes } from "./routes/notifications";
import { registerSettingsRoutes } from "./routes/settings";
import { registerSelectionRoutes } from "./routes/selection";
import { registerSelectionCategoryRoutes } from "./routes/selection-categories";
import { registerSelectionDiscoveryRoutes } from "./routes/selection-discovery";
import { registerSetupRoutes } from "./routes/setup";
import { registerStoreRoutes } from "./routes/stores";
import { registerWallboardManagementRoutes, registerWallboardPairingRoutes } from "./routes/wallboard";
import { wallboardAuthorization } from "./security/wallboard-session";
import { SelectionModule } from "./selection/selection-module";
import { WordstatClient } from "./selection/wordstat-client";
import { OrderNotificationService } from "./services/order-notification-service";
import type { ProxySettingsService } from "./services/proxy-settings-service";
import type { SyncService } from "./services/sync-service";
import type { UpdateService } from "./services/update-service";
import { CategoryAnalysisModule } from "./selection/category-analysis-module";
import { DiscoveryModule } from "./selection/discovery-module";

export interface AppDependencies {
  config: AppConfig;
  database: AppDatabase;
  events: DashboardEventBus;
  syncService: SyncService;
  proxySettings: ProxySettingsService;
  updates: UpdateService;
  selection?: SelectionModule;
  categories?: CategoryAnalysisModule;
  discovery?: DiscoveryModule;
}

interface SqliteError extends Error {
  code?: string;
}

async function createBaseApp(config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.LOG_LEVEL === "silent" ? false : { level: config.LOG_LEVEL },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });
  await app.register(cookie, { secret: config.COOKIE_SECRET, hook: "onRequest" });
  await app.register(rateLimit, { global: false });
  return app;
}

function registerHealthRoutes(app: FastifyInstance, database: AppDatabase): void {
  app.get("/healthz", async () => ({ status: "ok", time: new Date().toISOString() }));
  app.get("/readyz", async (_request, reply) => {
    try {
      // 数据库打开时已执行完整 quick_check；运行期只确认连接仍可读，避免大库扫描阻塞请求。
      database.prepare("SELECT 1").get();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not-ready" });
    }
  });
}

async function registerWebAssets(app: FastifyInstance): Promise<void> {
  const webRoot = resolve(process.cwd(), "dist/web");
  if (!existsSync(webRoot)) {
    return;
  }
  await app.register(fastifyStatic, {
    root: webRoot,
    wildcard: true,
    index: false,
    maxAge: "1y",
    immutable: true,
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "NOT_FOUND", message: "接口不存在" });
    }
    const pathname = new URL(request.url, "http://localhost").pathname;
    const isPageRequest = (request.method === "GET" || request.method === "HEAD")
      && !pathname.startsWith("/assets/")
      && extname(pathname) === "";
    if (!isPageRequest) {
      return reply.code(404).send({ error: "ASSET_NOT_FOUND", message: "静态资源不存在" });
    }
    return reply.header("Cache-Control", "no-store").sendFile("index.html", { cacheControl: false });
  });
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: SqliteError, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message: "请求参数不正确",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    if (error.code?.startsWith("SQLITE_CONSTRAINT")) {
      return reply.code(409).send({ error: "CONFLICT", message: "数据已存在或不符合唯一性约束" });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "服务暂时不可用" });
  });
}

/** Builds the loopback-only management application. */
export async function buildAdminApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, database, events, syncService, proxySettings, updates } = dependencies;
  const app = await createBaseApp(config);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 } });
  const administrators = new AdminRepository(database);
  const stores = new StoresRepository(database);
  const pairings = new WallboardPairingsRepository(database);
  const notifications = new OrderNotificationService(new SettingsRepository(database), events);
  const selection = dependencies.selection ?? new SelectionModule(config, database, {
    wordstatFactory: (folderId, apiKey) => new WordstatClient({
      folderId,
      apiKey,
      fetchImplementation: proxySettings.createFetch(),
    }),
  });
  const categories = dependencies.categories ?? new CategoryAnalysisModule(config, database, {
    fetchImplementation: proxySettings.createFetch(),
  });
  const discovery = dependencies.discovery ?? new DiscoveryModule(config, database, {
    fetchImplementation: proxySettings.createFetch(),
  });

  registerSetupRoutes(app, config, administrators);
  registerAuthRoutes(app, config, administrators);
  registerStoreRoutes(app, config, stores, syncService);
  registerDashboardRoutes(app, new DashboardRepository(database), events);
  registerSelectionRoutes(app, selection);
  registerSelectionCategoryRoutes(app, categories);
  registerSelectionDiscoveryRoutes(app, discovery);
  registerSettingsRoutes(app, proxySettings, updates);
  registerNotificationRoutes(app, notifications);
  registerWallboardManagementRoutes(app, config, pairings);
  app.get("/api/runtime", async () => ({ role: "admin" as const }));
  registerHealthRoutes(app, database);
  app.addHook("onClose", async () => notifications.close());
  await registerWebAssets(app);
  registerErrorHandler(app);
  return app;
}

/** Builds a separate LAN listener containing only pairing and read-only wallboard APIs. */
export async function buildWallboardApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, database, events } = dependencies;
  const app = await createBaseApp(config);
  const pairings = new WallboardPairingsRepository(database);

  registerWallboardPairingRoutes(app, pairings);
  app.get("/api/runtime", async () => ({ role: "wallboard" as const }));
  registerDashboardRoutes(
    app,
    new DashboardRepository(database),
    events,
    wallboardAuthorization(pairings),
    "/api/wallboard",
  );
  registerHealthRoutes(app, database);
  await registerWebAssets(app);
  registerErrorHandler(app);
  return app;
}
