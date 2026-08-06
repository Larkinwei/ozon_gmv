import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";

import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { AppConfig } from "./config";
import { AdminRepository } from "./db/admin-repository";
import { DashboardRepository } from "./db/dashboard-repository";
import type { AppDatabase } from "./db/database";
import { StoresRepository } from "./db/stores-repository";
import { WallboardPairingsRepository } from "./db/wallboard-pairings-repository";
import type { DashboardEventBus } from "./realtime/event-bus";
import { registerAuthRoutes } from "./routes/auth";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerSettingsRoutes } from "./routes/settings";
import { registerSetupRoutes } from "./routes/setup";
import { registerStoreRoutes } from "./routes/stores";
import { registerWallboardManagementRoutes, registerWallboardPairingRoutes } from "./routes/wallboard";
import { wallboardAuthorization } from "./security/wallboard-session";
import type { ProxySettingsService } from "./services/proxy-settings-service";
import type { SyncService } from "./services/sync-service";

export interface AppDependencies {
  config: AppConfig;
  database: AppDatabase;
  events: DashboardEventBus;
  syncService: SyncService;
  proxySettings: ProxySettingsService;
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
      const result = database.pragma("quick_check", { simple: true });
      return result === "ok" ? { status: "ready" } : reply.code(503).send({ status: "not-ready" });
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
  const { config, database, events, syncService, proxySettings } = dependencies;
  const app = await createBaseApp(config);
  const administrators = new AdminRepository(database);
  const stores = new StoresRepository(database);
  const pairings = new WallboardPairingsRepository(database);

  registerSetupRoutes(app, config, administrators);
  registerAuthRoutes(app, config, administrators);
  registerStoreRoutes(app, config, stores, syncService);
  registerDashboardRoutes(app, new DashboardRepository(database), events);
  registerSettingsRoutes(app, proxySettings);
  registerWallboardManagementRoutes(app, config, pairings);
  app.get("/api/runtime", async () => ({ role: "admin" as const }));
  registerHealthRoutes(app, database);
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
