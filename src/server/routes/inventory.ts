import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { InventoryMonitorService } from "../services/inventory-monitor-service";
import { requireSession } from "../security/session";

const acknowledgeSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

/** Registers admin-only low-stock alert endpoints. */
export function registerInventoryRoutes(app: FastifyInstance, inventory: InventoryMonitorService): void {
  app.get("/api/inventory/alerts", { preHandler: requireSession }, async () => ({
    threshold: 50,
    items: inventory.listOpenAlerts(),
  }));

  app.post("/api/inventory/alerts/acknowledge", { preHandler: requireSession }, async (request, reply) => {
    inventory.acknowledge(acknowledgeSchema.parse(request.body).ids);
    return reply.code(204).send();
  });
}
