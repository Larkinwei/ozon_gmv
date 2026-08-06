import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { AppConfig } from "../config";
import type { AdminRepository } from "../db/admin-repository";
import { safeStringEqual } from "../security/encryption";
import { clearSessionCookie, readSession, setSessionCookie } from "../security/session";

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(500),
});

/** Registers authentication against the administrator created during local setup. */
export function registerAuthRoutes(app: FastifyInstance, config: AppConfig, administrators: AdminRepository): void {
  app.get("/api/auth/session", async (request) => {
    const username = readSession(request);
    return username
      ? { authenticated: true, username, setupRequired: false }
      : { authenticated: false, setupRequired: !administrators.isInitialized() };
  });

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const administrator = administrators.find();
      if (!administrator) {
        return reply.code(409).send({ error: "SETUP_REQUIRED", message: "请先完成首次初始化" });
      }
      const usernameMatches = safeStringEqual(input.username, administrator.username);
      const passwordMatches = await argon2.verify(administrator.passwordHash, input.password);
      if (!usernameMatches || !passwordMatches) {
        return reply.code(401).send({ error: "INVALID_CREDENTIALS", message: "用户名或密码不正确" });
      }
      setSessionCookie(reply, administrator.username, config.COOKIE_SECURE);
      return { authenticated: true, username: administrator.username, setupRequired: false };
    },
  );

  app.post("/api/auth/logout", async (_request, reply) => {
    clearSessionCookie(reply, config.COOKIE_SECURE);
    return { authenticated: false, setupRequired: false };
  });
}
