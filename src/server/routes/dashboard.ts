import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { dashboardRanges } from "../../shared/contracts";
import { DashboardRepository } from "../db/dashboard-repository";
import { resolveDashboardWindow } from "../domain/time-range";
import type { DashboardEventBus } from "../realtime/event-bus";
import { requireSession } from "../security/session";

const dashboardQuerySchema = z.object({
  range: z.enum(dashboardRanges).default("today"),
  storeIds: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
const orderParamsSchema = z.object({ id: z.string().uuid() });

function parseStoreIds(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((id) => z.string().uuid().parse(id.trim()))
    .filter(Boolean);
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  dashboard: DashboardRepository,
  events: DashboardEventBus,
  authorization: (request: FastifyRequest, reply: FastifyReply) => Promise<void> = requireSession,
  prefix = "/api/dashboard",
): void {
  app.get(`${prefix}/orders/:id`, { preHandler: authorization }, async (request, reply) => {
    const { id } = orderParamsSchema.parse(request.params);
    const order = await dashboard.getOrderDetail(id);
    if (!order) {
      return reply.code(404).send({ error: "ORDER_NOT_FOUND", message: "订单不存在" });
    }
    return order;
  });

  app.get(`${prefix}/overview`, { preHandler: authorization }, async (request) => {
    const query = dashboardQuerySchema.parse(request.query);
    const window = resolveDashboardWindow(query.range, new Date(), query.from, query.to);
    return dashboard.getSnapshot(query.range, window, parseStoreIds(query.storeIds));
  });

  app.get(`${prefix}/stream`, { preHandler: authorization }, async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (event: ReturnType<DashboardEventBus["publish"]>): void => {
      reply.raw.write(`id: ${event.id}\n`);
      reply.raw.write(`event: ${event.type}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const lastEventId = request.headers["last-event-id"];
    const eventId = Array.isArray(lastEventId) ? lastEventId[0] : lastEventId;
    for (const event of events.eventsAfter(eventId)) {
      sendEvent(event);
    }
    reply.raw.write(": connected\n\n");

    const unsubscribe = events.subscribe(sendEvent);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
