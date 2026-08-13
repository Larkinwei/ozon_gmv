import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  selectionMarketQuerySorts,
  selectionMarketRankingSorts,
} from "../../shared/contracts";
import { requireSession } from "../security/session";
import type { DiscoveryModule } from "../selection/discovery-module";

const idSchema = z.object({ id: z.string().uuid() });
const productQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  periodDays: z.coerce.number().pipe(z.union([z.literal(7), z.literal(28)])).default(28),
  sort: z.enum(selectionMarketRankingSorts).default("orderedAmount"),
  search: z.string().trim().max(300).optional(),
  categoryId: z.string().trim().max(100).optional(),
  minimumPrice: z.coerce.number().nonnegative().optional(),
  maximumPrice: z.coerce.number().nonnegative().optional(),
});
const marketQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(selectionMarketQuerySorts).default("searchCount"),
  search: z.string().trim().max(300).optional(),
  groupName: z.string().trim().max(300).optional(),
  categoryId: z.string().trim().max(100).optional(),
  minimumSearchCount: z.coerce.number().int().nonnegative().optional(),
  minimumCartRate: z.coerce.number().min(0).max(100).optional(),
  minimumOrderRate: z.coerce.number().min(0).max(100).optional(),
  maximumCompetition: z.coerce.number().int().nonnegative().optional(),
});
const settingsSchema = z.object({
  collectorEnabled: z.boolean(),
  opencliPath: z.string().trim().min(1).max(1000),
  cloudBaseUrl: z.string().trim().url().max(2000).nullable().optional(),
  uploadToken: z.string().trim().min(1).max(4000).optional(),
});

/** Registers market-discovery APIs only on the loopback administrator listener. */
export function registerSelectionDiscoveryRoutes(app: FastifyInstance, discovery: DiscoveryModule): void {
  app.get("/api/selection/discovery/sync", { preHandler: requireSession }, async () => discovery.getSync());
  app.post("/api/selection/discovery/sync", { preHandler: requireSession }, async (_request, reply) => {
    try {
      return reply.code(202).send(discovery.startSync());
    } catch (error) {
      return reply.code(409).send({
        error: "DISCOVERY_SYNC_REJECTED",
        message: error instanceof Error ? error.message : "无法启动市场数据同步",
      });
    }
  });
  app.post("/api/selection/discovery/cloud-refresh", { preHandler: requireSession }, async (_request, reply) => {
    try {
      return await discovery.refreshCloud();
    } catch (error) {
      return reply.code(502).send({
        error: "DISCOVERY_CLOUD_REFRESH_FAILED",
        message: error instanceof Error ? error.message : "云端市场数据刷新失败",
      });
    }
  });
  app.get("/api/selection/sources/discovery", { preHandler: requireSession }, async () => discovery.viewSettings());
  app.put("/api/selection/sources/discovery", { preHandler: requireSession }, async (request) => (
    discovery.updateSettings(settingsSchema.parse(request.body))
  ));
  app.get("/api/selection/rankings/products", { preHandler: requireSession }, async (request) => (
    discovery.listProducts(productQuerySchema.parse(request.query))
  ));
  app.get("/api/selection/rankings/products/:id", { preHandler: requireSession }, async (request, reply) => {
    const item = discovery.getProduct(idSchema.parse(request.params).id);
    return item ?? reply.code(404).send({ error: "PRODUCT_RANKING_NOT_FOUND", message: "官方热销商品不存在" });
  });
  app.get("/api/selection/rankings/queries", { preHandler: requireSession }, async (request) => (
    discovery.listQueries(marketQuerySchema.parse(request.query))
  ));
  app.get("/api/selection/rankings/queries/:id", { preHandler: requireSession }, async (request, reply) => {
    const item = discovery.getQuery(idSchema.parse(request.params).id);
    return item ?? reply.code(404).send({ error: "MARKET_QUERY_NOT_FOUND", message: "官方热搜词不存在" });
  });
}
