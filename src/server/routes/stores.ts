import { randomUUID } from "node:crypto";

import { subDays } from "date-fns";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { fulfillmentModes } from "../../shared/contracts";
import type { AppConfig } from "../config";
import { StoresRepository, toStoreView } from "../db/stores-repository";
import { decryptSecret, encryptSecret } from "../security/encryption";
import { requireSession } from "../security/session";
import type { SyncService } from "../services/sync-service";

const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const createStoreSchema = z.object({
  name: z.string().trim().min(1).max(100),
  clientId: z.string().trim().min(1).max(100),
  apiKey: z.string().trim().min(10).max(1000),
  color: colorSchema,
  fulfillmentModes: z.array(z.enum(fulfillmentModes)).min(1),
});
const updateStoreSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    apiKey: z.string().trim().min(10).max(1000).optional(),
    color: colorSchema.optional(),
    enabled: z.boolean().optional(),
    fulfillmentModes: z.array(z.enum(fulfillmentModes)).min(1).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "至少提供一个修改字段");
const storeParamsSchema = z.object({ id: z.string().uuid() });
const syncStoreSchema = z.object({ days: z.number().int().min(1).max(90) });

export function registerStoreRoutes(
  app: FastifyInstance,
  config: AppConfig,
  stores: StoresRepository,
  syncService: SyncService,
): void {
  app.get("/api/stores", { preHandler: requireSession }, async () => {
    return (await stores.list()).map(toStoreView);
  });

  app.post("/api/stores", { preHandler: requireSession }, async (request, reply) => {
    const input = createStoreSchema.parse(request.body);
    const credentials = await syncService.testCredentials(input.clientId, input.apiKey, input.fulfillmentModes);
    const store = await stores.create({
      id: randomUUID(),
      name: input.name,
      clientId: input.clientId,
      apiKeyCiphertext: encryptSecret(input.apiKey, config.ENCRYPTION_KEY),
      color: input.color,
      fulfillmentModes: input.fulfillmentModes,
      apiKeyExpiresAt: credentials.expiresAt,
    });

    void syncService.backfillStore(store.id).catch((error: unknown) => {
      app.log.error({ err: error, storeId: store.id }, "Initial store backfill failed");
    });
    return reply.code(201).send({
      store: toStoreView(store),
      backfillDays: 90,
      pollIntervalSeconds: 60,
    });
  });

  app.patch("/api/stores/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = storeParamsSchema.parse(request.params);
    const input = updateStoreSchema.parse(request.body);
    const existing = await stores.findById(id);
    if (!existing) {
      return reply.code(404).send({ error: "STORE_NOT_FOUND", message: "店铺不存在" });
    }

    let apiKeyCiphertext: string | undefined;
    let apiKeyExpiresAt: string | null | undefined;
    if (input.apiKey || input.fulfillmentModes) {
      const apiKey = input.apiKey ?? decryptSecret(existing.apiKeyCiphertext, config.ENCRYPTION_KEY);
      const credentials = await syncService.testCredentials(
        existing.clientId,
        apiKey,
        input.fulfillmentModes ?? existing.fulfillmentModes,
      );
      apiKeyExpiresAt = credentials.expiresAt;
      if (input.apiKey) {
        apiKeyCiphertext = encryptSecret(input.apiKey, config.ENCRYPTION_KEY);
      }
    }

    const updated = await stores.update(id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.color ? { color: input.color } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.fulfillmentModes ? { fulfillmentModes: input.fulfillmentModes } : {}),
      ...(apiKeyCiphertext ? { apiKeyCiphertext } : {}),
      ...(apiKeyExpiresAt !== undefined ? { apiKeyExpiresAt } : {}),
    });
    return updated ? toStoreView(updated) : reply.code(404).send({ error: "STORE_NOT_FOUND" });
  });

  app.post("/api/stores/:id/test", { preHandler: requireSession }, async (request, reply) => {
    const { id } = storeParamsSchema.parse(request.params);
    const store = await stores.findById(id);
    if (!store) {
      return reply.code(404).send({ error: "STORE_NOT_FOUND", message: "店铺不存在" });
    }
    const result = await syncService.testCredentials(
      store.clientId,
      decryptSecret(store.apiKeyCiphertext, config.ENCRYPTION_KEY),
      store.fulfillmentModes,
    );
    return { ok: true, expiresAt: result.expiresAt, roles: result.roles.map((role) => role.name) };
  });

  app.post("/api/stores/:id/sync", { preHandler: requireSession }, async (request, reply) => {
    const { id } = storeParamsSchema.parse(request.params);
    const { days } = syncStoreSchema.parse(request.body);
    const store = await stores.findById(id);
    if (!store) {
      return reply.code(404).send({ error: "STORE_NOT_FOUND", message: "店铺不存在" });
    }
    const now = new Date();
    void syncService.syncStore(id, subDays(now, days), now).catch((error: unknown) => {
      app.log.error({ err: error, storeId: id }, "Manual store sync failed");
    });
    return reply.code(202).send({ accepted: true, days });
  });
}
