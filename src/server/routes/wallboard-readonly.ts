import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { storePlatforms } from "../../shared/contracts";
import { StoresRepository } from "../db/stores-repository";
import type { WallboardBalanceReader } from "../services/store-operations-service";

const balanceQuerySchema = z.object({
  storeIds: z.string().optional(),
  platform: z.enum(storePlatforms).optional(),
});

function parseStoreIds(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((id) => z.string().uuid().parse(id.trim()))
    .filter(Boolean);
}

/** Registers the non-management data needed by the read-only mobile wallboard. */
export function registerWallboardReadonlyRoutes(
  app: FastifyInstance,
  stores: StoresRepository,
  operations: WallboardBalanceReader,
  authorization: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  app.get("/api/wallboard/store-options", { preHandler: authorization }, async () => {
    const activeStores = await stores.listActive();
    return activeStores.map((store) => ({
      id: store.id,
      name: store.name,
      platform: store.platform,
      color: store.color,
    }));
  });

  app.get("/api/wallboard/store-balances/overview", { preHandler: authorization }, async (request) => {
    const query = balanceQuerySchema.parse(request.query);
    return operations.getBalanceOverview(parseStoreIds(query.storeIds), query.platform ?? "all");
  });
}
