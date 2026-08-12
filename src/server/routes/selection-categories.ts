import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { selectionCategoryPeriods, selectionCategorySorts } from "../../shared/contracts";
import { requireSession } from "../security/session";
import type { CategoryAnalysisModule } from "../selection/category-analysis-module";

const categoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  periodDays: z.coerce.number().pipe(z.union([z.literal(7), z.literal(28)])).default(28),
  sort: z.enum(selectionCategorySorts).default("gmv"),
  search: z.string().trim().max(300).optional(),
  categoryLevel1Id: z.string().trim().max(100).optional(),
  minimumPrice: z.coerce.number().nonnegative().optional(),
  maximumPrice: z.coerce.number().nonnegative().optional(),
  minimumGmv: z.coerce.number().nonnegative().optional(),
  maximumGmv: z.coerce.number().nonnegative().optional(),
  minimumGrowth: z.coerce.number().min(-10_000).max(10_000).optional(),
  maximumGrowth: z.coerce.number().min(-10_000).max(10_000).optional(),
  maximumSellerCount: z.coerce.number().int().nonnegative().optional(),
  minimumBuyoutRate: z.coerce.number().min(0).max(100).optional(),
  maximumLeaderShare: z.coerce.number().min(0).max(100).optional(),
});
const overviewQuerySchema = z.object({
  periodDays: z.coerce.number().pipe(z.union([z.literal(7), z.literal(28)])).default(28),
});
const categorySettingsSchema = z.object({
  collectorEnabled: z.boolean(),
  opencliPath: z.string().trim().min(1).max(1000),
  cloudBaseUrl: z.string().trim().url().max(2000).nullable().optional(),
  uploadToken: z.string().trim().min(1).max(4000).optional(),
});

/** Registers category analysis only on the loopback administrator listener. */
export function registerSelectionCategoryRoutes(app: FastifyInstance, categories: CategoryAnalysisModule): void {
  app.get("/api/selection/categories", { preHandler: requireSession }, async (request) => {
    return categories.list(categoryQuerySchema.parse(request.query));
  });
  app.get("/api/selection/categories/overview", { preHandler: requireSession }, async (request) => {
    return categories.overview(overviewQuerySchema.parse(request.query).periodDays);
  });
  app.get("/api/selection/categories/sync", { preHandler: requireSession }, async () => categories.getSync());
  app.post("/api/selection/categories/sync", { preHandler: requireSession }, async (_request, reply) => {
    try {
      return reply.code(202).send(categories.startSync());
    } catch (error) {
      return reply.code(409).send({
        error: "CATEGORY_SYNC_REJECTED",
        message: error instanceof Error ? error.message : "无法启动类目同步",
      });
    }
  });
  app.post("/api/selection/categories/cloud-refresh", { preHandler: requireSession }, async (_request, reply) => {
    try {
      return await categories.refreshCloud();
    } catch (error) {
      return reply.code(502).send({
        error: "CATEGORY_CLOUD_REFRESH_FAILED",
        message: error instanceof Error ? error.message : "云端类目数据刷新失败",
      });
    }
  });
  app.get("/api/selection/sources/categories", { preHandler: requireSession }, async () => categories.viewSettings());
  app.put("/api/selection/sources/categories", { preHandler: requireSession }, async (request) => {
    return categories.updateSettings(categorySettingsSchema.parse(request.body));
  });
}
