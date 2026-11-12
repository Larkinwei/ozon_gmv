import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { subDays } from "date-fns";

import { requireSession } from "../security/session";
import type { StockPrepService } from "../services/stock-prep-service";
import type { StoresRepository } from "../db/stores-repository";
import type { SyncService } from "../services/sync-service";

const storeParams = z.object({ storeId: z.string().uuid() });
const orderKeys = z.object({ keys: z.array(z.object({ postingNumber: z.string().min(1).max(100), offerId: z.string().min(1).max(100) })).min(1).max(5000) });

/** Registers the interactive order-to-1688 replenishment workflow. */
export function registerStockPrepRoutes(app: FastifyInstance, service: StockPrepService, stores: StoresRepository, syncService: SyncService): void {
  app.get("/api/stock-prep/connection", { preHandler: requireSession }, async () => service.getConnectionState());

  app.put("/api/stock-prep/dropship-suppliers", { preHandler: requireSession }, async (request, reply) => {
    const input = z.object({ names: z.array(z.string().trim().min(1).max(120)).max(100) }).parse(request.body);
    try { return { suppliers: service.saveDropshipSupplierNames(input.names) }; }
    catch (error) { return reply.code(400).send({ error: "DROPSHIP_SUPPLIERS_INVALID", message: error instanceof Error ? error.message : "代发供应商名单无效" }); }
  });

  app.put("/api/stock-prep/connection/app", { preHandler: requireSession }, async (request, reply) => {
    const input = z.object({ appId: z.string().min(1).max(100), appSecret: z.string().min(8).max(500) }).parse(request.body);
    try { service.configureFeishuApp(input.appId, input.appSecret); return { configured: true }; }
    catch (error) { return reply.code(400).send({ error: "FEISHU_APP_INVALID", message: error instanceof Error ? error.message : "飞书应用配置无效" }); }
  });

  app.post("/api/stock-prep/connection/authorize", { preHandler: requireSession }, async (_request, reply) => {
    try { return await service.beginFeishuAuthorization(); }
    catch (error) { return reply.code(409).send({ error: "FEISHU_AUTH_START_FAILED", message: error instanceof Error ? error.message : "无法发起飞书授权" }); }
  });

  app.get("/api/stock-prep/stores/:storeId", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const store = await stores.findById(storeId);
    if (!store || store.platform !== "ozon" || !store.enabled) return reply.code(404).send({ error: "STORE_NOT_AVAILABLE", message: "目标 Ozon 店铺不存在或已停用" });
    return { source: service.getSource(storeId), latestBatch: service.getLatestBatch(storeId), connection: await service.getConnectionState() };
  });

  app.put("/api/stock-prep/stores/:storeId/source", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const input = z.object({ url: z.string().url().max(2048) }).parse(request.body);
    const store = await stores.findById(storeId);
    if (!store || store.platform !== "ozon") return reply.code(404).send({ error: "STORE_NOT_AVAILABLE", message: "仅支持配置 Ozon 店铺" });
    try { return await service.saveStoreSource(storeId, input.url); }
    catch (error) { return reply.code(400).send({ error: "SKU_SOURCE_INVALID", message: error instanceof Error ? error.message : "飞书 SKU 表校验失败" }); }
  });

  app.post("/api/stock-prep/stores/:storeId/scan", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const { forceRefresh } = z.object({ forceRefresh: z.boolean().optional() }).parse(request.body ?? {});
    try {
      if (forceRefresh || !service.hasFreshOrderSyncCache(storeId)) {
        await syncService.syncStore(storeId, subDays(new Date(), 14), new Date(), ["FBS", "RFBS"]);
        service.markOrderSyncCacheFresh(storeId);
      }
      return await service.scan(storeId);
    }
    catch (error) { return reply.code(422).send({ error: "STOCK_PREP_SCAN_FAILED", message: error instanceof Error ? error.message : "备货订单扫描失败" }); }
  });

  app.post("/api/stock-prep/stores/:storeId/batches", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const input = orderKeys.parse(request.body);
    try {
      await syncService.syncStore(storeId, subDays(new Date(), 14), new Date(), ["FBS", "RFBS"]);
      service.markOrderSyncCacheFresh(storeId);
      return reply.code(202).send(await service.createBatch(storeId, input.keys));
    }
    catch (error) { return reply.code(409).send({ error: "STOCK_PREP_BATCH_REJECTED", message: error instanceof Error ? error.message : "无法创建加购批次" }); }
  });

  app.get("/api/stock-prep/batches/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const batch = service.getBatch(id);
    return batch ?? reply.code(404).send({ error: "BATCH_NOT_FOUND", message: "加购批次不存在" });
  });

  app.post("/api/stock-prep/stores/:storeId/reset", { preHandler: requireSession }, async (request) => {
    const { storeId } = storeParams.parse(request.params);
    return { resetCount: service.resetOrders(storeId, orderKeys.parse(request.body).keys) };
  });

  app.post("/api/stock-prep/stores/:storeId/resolve-no-add", { preHandler: requireSession }, async (request) => {
    const { storeId } = storeParams.parse(request.params);
    return { resolvedCount: service.resolveUncertainAsFailed(storeId, orderKeys.parse(request.body).keys) };
  });
}
