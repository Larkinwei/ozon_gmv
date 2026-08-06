import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { ProxySettingsService } from "../services/proxy-settings-service";
import type { UpdateService } from "../services/update-service";
import { requireSession } from "../security/session";

const proxySettingsSchema = z.object({
  mode: z.enum(["auto", "manual", "direct"]),
  manualProxy: z.string().trim().min(1).max(2000).optional(),
});

/** Registers administrator-only local network settings. */
export function registerSettingsRoutes(
  app: FastifyInstance,
  proxySettings: ProxySettingsService,
  updates: UpdateService,
): void {
  app.get("/api/settings/network", { preHandler: requireSession }, async () => proxySettings.view());

  app.put("/api/settings/network", { preHandler: requireSession }, async (request, reply) => {
    const input = proxySettingsSchema.parse(request.body);
    try {
      return proxySettings.update(input.mode, input.manualProxy);
    } catch (error) {
      return reply.code(400).send({
        error: "INVALID_PROXY_SETTINGS",
        message: error instanceof Error ? error.message : "代理设置不正确",
      });
    }
  });

  app.post("/api/settings/network/test", { preHandler: requireSession }, async (_request, reply) => {
    try {
      return await proxySettings.test();
    } catch (error) {
      return reply.code(502).send({
        error: "OZON_CONNECTION_FAILED",
        message: error instanceof Error ? error.message : "无法连接 Ozon",
      });
    }
  });

  app.get("/api/settings/update", { preHandler: requireSession }, async () => updates.view());

  app.post("/api/settings/update/check", { preHandler: requireSession }, async () => updates.check());

  app.post("/api/settings/update/install", { preHandler: requireSession }, async (_request, reply) => {
    const current = updates.view();
    if (!current.supported) {
      return reply.code(409).send({ error: "UPDATE_UNSUPPORTED", message: "当前系统不支持在线更新" });
    }
    if (current.state !== "available") {
      return reply.code(409).send({ error: "UPDATE_NOT_AVAILABLE", message: "当前没有可安装的新版本" });
    }
    return reply.code(202).send(updates.beginInstall());
  });
}
