import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { OrderNotificationEvent } from "../../shared/contracts";
import { requireSession } from "../security/session";
import type { OrderNotificationService } from "../services/order-notification-service";

const settingsSchema = z.object({ enabled: z.boolean() });
const statusSchema = z.object({
  deliveredAt: z.string().datetime().optional(),
  error: z.string().max(1000).nullable().optional(),
});

async function requireLoopback(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  if (!loopbackAddresses.has(request.ip) || request.headers.origin) {
    await reply.code(403).send({ error: "LOCAL_AGENT_ONLY", message: "仅允许本机通知助手访问" });
  }
}

/** Registers admin controls and the loopback-only desktop notification stream. */
export function registerNotificationRoutes(app: FastifyInstance, notifications: OrderNotificationService): void {
  app.get("/api/settings/notifications", { preHandler: requireSession }, async () => notifications.view());
  app.put("/api/settings/notifications", { preHandler: requireSession }, async (request) => {
    const input = settingsSchema.parse(request.body);
    return notifications.update(input.enabled);
  });
  app.post("/api/settings/notifications/test", { preHandler: requireSession }, async (_request, reply) => {
    const current = notifications.view();
    if (!current.supported || !current.enabled) {
      return reply.code(409).send({ error: "NOTIFICATIONS_DISABLED", message: "请先开启系统通知" });
    }
    notifications.publishTest();
    return reply.code(202).send({ accepted: true });
  });

  app.post("/api/internal/notifications/status", { preHandler: requireLoopback }, async (request) => {
    return notifications.reportAgent(statusSchema.parse(request.body));
  });
  app.get("/api/internal/notifications/stream", { preHandler: requireLoopback }, async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const sendEvent = (event: OrderNotificationEvent): void => {
      reply.raw.write(`id: ${event.id}\n`);
      reply.raw.write("event: order-notification\n");
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const lastEventId = request.headers["last-event-id"];
    const eventId = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
    for (const event of notifications.eventsAfter(eventId)) {
      sendEvent(event);
    }
    reply.raw.write(": connected\n\n");
    const unsubscribe = notifications.subscribe(sendEvent);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
