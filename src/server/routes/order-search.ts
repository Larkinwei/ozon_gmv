import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { DashboardRepository } from "../db/dashboard-repository";
import { requireSession } from "../security/session";

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const orderSearchQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).refine((value) => Boolean(value.from) === Boolean(value.to), {
  message: "开始和结束时间必须同时提供",
  path: ["to"],
});

export function registerOrderSearchRoutes(app: FastifyInstance, dashboard: DashboardRepository): void {
  app.get("/api/orders/search", { preHandler: requireSession }, async (request, reply) => {
    const query = orderSearchQuerySchema.parse(request.query);
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - NINETY_DAYS_MS);
    if (from >= to) {
      return reply.code(400).send({ error: "INVALID_ORDER_SEARCH_RANGE", message: "订单搜索时间范围无效" });
    }
    return dashboard.searchOzonOrders({
      ...(query.q ? { q: query.q } : {}),
      from,
      to,
      page: query.page,
      pageSize: query.pageSize,
    });
  });
}
