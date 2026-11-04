import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireSession } from "../security/session";
import type { PerformanceAdsService } from "../services/performance-ads-service";

/** Registers local administrator endpoints for read-only Performance API monitoring. */
export function registerPerformanceAdsRoutes(app: FastifyInstance, service: PerformanceAdsService): void {
  app.get("/api/operations/ads/:storeId/config", { preHandler: requireSession }, async (request) => service.view((request.params as { storeId: string }).storeId));
  app.put("/api/operations/ads/:storeId/config", { preHandler: requireSession }, async (request) => {
    const input = z.object({ clientId: z.string().trim().max(200).optional(), clientSecret: z.string().trim().max(500).optional() }).parse(request.body);
    return service.save((request.params as { storeId: string }).storeId, {
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
    });
  });
  app.post("/api/operations/ads/:storeId/test", { preHandler: requireSession }, async (request) => service.test((request.params as { storeId: string }).storeId));
  app.post("/api/operations/ads/:storeId/backfill", { preHandler: requireSession }, async (request) => service.startInitialBackfill((request.params as { storeId: string }).storeId));
  app.post("/api/operations/ads/:storeId/sync", { preHandler: requireSession }, async (request) => {
    const { from, to } = z.object({ from: z.string().date(), to: z.string().date() }).parse(request.body);
    return service.sync((request.params as { storeId: string }).storeId, from, to);
  });
  app.get("/api/operations/ads/:storeId/data", { preHandler: requireSession }, async (request) => {
    const query = z.object({ from: z.string().date(), to: z.string().date(), state: z.string().optional(), campaignId: z.string().optional() }).parse(request.query);
    return service.list((request.params as { storeId: string }).storeId, query.from, query.to, query.state, query.campaignId);
  });
}
