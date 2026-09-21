import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { PricingScenariosRepository } from "../db/pricing-scenarios-repository";
import type { ExchangeRateService } from "../services/exchange-rate-service";
import { requireSession } from "../security/session";

const scenarioSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sku: z.string().trim().max(120).nullable().optional(),
  mode: z.enum(["target-price", "existing-price"]),
  inputs: z.unknown(),
  feeRates: z.unknown(),
  exchangeRate: z.string().min(1).max(40),
  exchangeSource: z.string().max(200).nullable().optional(),
  exchangeEffectiveDate: z.string().max(40).nullable().optional(),
  ruleVersion: z.string().min(1).max(120),
  result: z.unknown(),
  risk: z.unknown(),
});

/** Registers management-only calculation-tool APIs. */
export function registerToolsRoutes(app: FastifyInstance, exchangeRate: ExchangeRateService, scenarios: PricingScenariosRepository): void {
  app.get("/api/tools/exchange-rate", { preHandler: requireSession }, async () => exchangeRate.view());
  app.post("/api/tools/exchange-rate/refresh", { preHandler: requireSession }, async () => exchangeRate.refresh());
  app.get("/api/tools/pricing/scenarios", { preHandler: requireSession }, async (request) => {
    const query = request.query as { q?: string; limit?: string };
    return scenarios.list(query.q, query.limit ? Number(query.limit) : 50);
  });
  app.get("/api/tools/pricing/scenarios/:id", { preHandler: requireSession }, async (request, reply) => {
    const params = request.params as { id: string };
    const scenario = scenarios.get(params.id);
    if (!scenario) return reply.code(404).send({ error: "NOT_FOUND", message: "历史方案不存在" });
    return scenario;
  });
  app.post("/api/tools/pricing/scenarios", { preHandler: requireSession }, async (request) => {
    const input = scenarioSchema.parse(request.body);
    return scenarios.create({
      ...input,
      sku: input.sku ?? null,
      exchangeSource: input.exchangeSource ?? null,
      exchangeEffectiveDate: input.exchangeEffectiveDate ?? null,
    });
  });
  app.delete("/api/tools/pricing/scenarios/:id", { preHandler: requireSession }, async (request, reply) => {
    const params = request.params as { id: string };
    if (!scenarios.delete(params.id)) return reply.code(404).send({ error: "NOT_FOUND", message: "历史方案不存在" });
    return reply.code(204).send();
  });
}
