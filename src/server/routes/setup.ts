import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config";
import type { AdminRepository } from "../db/admin-repository";
import { setSessionCookie } from "../security/session";

const initializeSchema = z.object({
  username: z.string().trim().min(3, "用户名至少 3 个字符").max(100),
  password: z.string().min(10, "密码至少 10 个字符").max(500),
});

function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** Exposes the one-shot setup flow only through the loopback management listener. */
export function registerSetupRoutes(app: FastifyInstance, config: AppConfig, administrators: AdminRepository): void {
  app.get("/api/setup/status", async () => ({ initialized: administrators.isInitialized() }));

  app.post(
    "/api/setup/initialize",
    { config: { rateLimit: { max: 3, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!isLoopbackAddress(request.ip)) {
        return reply.code(403).send({ error: "LOOPBACK_ONLY", message: "首次初始化只能在安装电脑上进行" });
      }
      if (administrators.isInitialized()) {
        return reply.code(409).send({ error: "ALREADY_INITIALIZED", message: "系统已完成初始化" });
      }
      const input = initializeSchema.parse(request.body);
      const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
      const administrator = administrators.create(input.username, passwordHash);
      setSessionCookie(reply, administrator.username, config.COOKIE_SECURE);
      return reply.code(201).send({ authenticated: true, username: administrator.username, setupRequired: false });
    },
  );
}
