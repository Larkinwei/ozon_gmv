import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { LOW_STOCK_THRESHOLD, type InventoryMonitorService } from "../services/inventory-monitor-service";
import { requireSession } from "../security/session";

const acknowledgeSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });
const snoozeSchema = z.object({ storeId: z.string().uuid(), sku: z.string().trim().min(1).max(200) });

/** Registers admin-only low-stock alert endpoints. */
export function registerInventoryRoutes(app: FastifyInstance, inventory: InventoryMonitorService): void {
  app.get("/api/inventory/alerts", { preHandler: requireSession }, async () => ({
    threshold: LOW_STOCK_THRESHOLD,
    items: inventory.listOpenAlerts(),
  }));

  app.post("/api/inventory/alerts/acknowledge", { preHandler: requireSession }, async (request, reply) => {
    inventory.acknowledge(acknowledgeSchema.parse(request.body).ids);
    return reply.code(204).send();
  });

  app.post("/api/inventory/alerts/snooze", { preHandler: requireSession }, async (request, reply) => {
    const { storeId, sku } = snoozeSchema.parse(request.body);
    inventory.snoozeSku(storeId, sku);
    return reply.code(204).send();
  });
}
