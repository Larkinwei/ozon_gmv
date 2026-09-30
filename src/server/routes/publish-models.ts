import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { SettingsRepository } from "../db/settings-repository";
import { requireSession } from "../security/session";

const SETTING_KEY = "publish-product-models";
const defaultModels = { textModel: "", imageModel: "" };

/** Exposes GMV-owned model preferences and the stable generation request contract. */
export function registerPublishModelRoutes(app: FastifyInstance, settings: SettingsRepository): void {
  app.get("/api/selection/publish/models", { preHandler: requireSession }, async () => {
    try {
      const saved: unknown = JSON.parse(settings.get(SETTING_KEY) || "null");
      const parsed = z.object({ textModel: z.string(), imageModel: z.string() }).safeParse(saved);
      return parsed.success ? parsed.data : defaultModels;
    } catch {
      return defaultModels;
    }
  });
  app.put("/api/selection/publish/models", { preHandler: requireSession }, async (request) => {
    const models = z.object({ textModel: z.string().trim().max(200), imageModel: z.string().trim().max(200) }).parse(request.body);
    settings.set(SETTING_KEY, JSON.stringify(models));
    return models;
  });
  app.post("/api/selection/publish/generation", { preHandler: requireSession }, async (request, reply) => {
    const input = z.object({ kind: z.enum(["copy", "image"]), draftId: z.string().uuid(), variantId: z.string().max(120).optional(), prompt: z.string().trim().max(20_000).optional() }).parse(request.body);
    return reply.code(503).send({ status: "provider_not_configured", message: "商品生成调用尚未接通；本期不会返回模拟生成内容。", request: input });
  });
}
