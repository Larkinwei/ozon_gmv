import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { subDays } from "date-fns";

import { requireSession } from "../security/session";
import type { StockPrepService } from "../services/stock-prep-service";
import type { StoresRepository } from "../db/stores-repository";
import type { SyncService } from "../services/sync-service";

const storeParams = z.object({ storeId: z.string().uuid() });
const orderKeys = z.object({ keys: z.array(z.object({ postingNumber: z.string().min(1).max(100), offerId: z.string().min(1).max(100) })).min(1).max(5000) });
const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Restricts AI-agent write access to local CLI requests. */
async function requireLocalAgent(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!loopbackAddresses.has(request.ip) || request.headers.origin) {
    await reply.code(403).send({ error: "LOCAL_AGENT_ONLY", message: "Agent API 仅接受本机命令行客户端" });
  }
}

/** Returns the single OpenAPI contract shared by the GMV help page and local AI agents. */
function buildBlacklistAgentOpenApi(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Ozon GMV 买家黑名单候选接口",
      version: "1.0.0",
      description: "供本机 AI Agent 查询 Ozon 店铺并提交黑名单候选。候选必须由运营人员在 GMV 后台审核后才会生效。",
    },
    servers: [{ url: "http://127.0.0.1:3001" }],
    paths: {
      "/api/agent/v1/blacklist/stores": {
        get: {
          summary: "查询可用的 Ozon 店铺",
          description: "返回店铺 ID、名称和启用状态，供提交候选时选择目标店铺。",
          responses: { "200": { description: "店铺列表" }, "403": { description: "请求不是来自本机命令行客户端" } },
        },
      },
      "/api/agent/v1/stores/{storeId}/blacklist/candidates": {
        put: {
          summary: "提交黑名单候选供人工审核",
          description: "所有记录只会保存为待审核候选；此接口不能直接启用、停用或删除黑名单。",
          parameters: [{ name: "storeId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["candidates"], properties: { candidates: { type: "array", maxItems: 500, items: { type: "object", required: ["buyerId", "reasonCode"], properties: { buyerId: { type: "string", maxLength: 200 }, reasonCode: { type: "string", maxLength: 100 }, summary: { type: "string", maxLength: 2000 }, evidenceOrders: { type: "array", maxItems: 100, items: { type: "string", maxLength: 100 } }, ruleVersion: { type: "string", maxLength: 100 } }, additionalProperties: false } } }, additionalProperties: false } } } },
          responses: { "200": { description: "返回提交数量和候选状态" }, "400": { description: "请求参数无效" }, "403": { description: "请求不是来自本机命令行客户端" } },
        },
      },
    },
  };
}

/** Registers the interactive order-to-1688 replenishment workflow. */
export function registerStockPrepRoutes(app: FastifyInstance, service: StockPrepService, stores: StoresRepository, syncService: SyncService): void {
  app.get("/api/stock-prep/connection", { preHandler: requireSession }, async () => service.getConnectionState());

  app.get("/api/stock-prep/agent-api-docs", { preHandler: requireSession }, async () => buildBlacklistAgentOpenApi());

  app.put("/api/stock-prep/dropship-suppliers", { preHandler: requireSession }, async (request, reply) => {
    const input = z.object({ names: z.array(z.string().trim().min(1).max(120)).max(100) }).parse(request.body);
    try { return { suppliers: service.saveDropshipSupplierNames(input.names) }; }
    catch (error) { return reply.code(400).send({ error: "DROPSHIP_SUPPLIERS_INVALID", message: error instanceof Error ? error.message : "代发供应商名单无效" }); }
  });

  app.get("/api/stock-prep/stores/:storeId/buyer-blacklist", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const store = await stores.findById(storeId);
    if (!store || store.platform !== "ozon") return reply.code(404).send({ error: "STORE_NOT_AVAILABLE", message: "仅支持 Ozon 店铺黑名单" });
    return { entries: service.listBuyerBlacklist(storeId) };
  });

  app.post("/api/stock-prep/stores/:storeId/buyer-blacklist", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const input = z.object({ buyerId: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(1000) }).parse(request.body);
    try {
      service.upsertBuyerBlacklist(storeId, { buyerId: input.buyerId, status: "active", source: "manual", reasonCode: "manual", summary: input.reason });
      return { added: true };
    } catch (error) { return reply.code(400).send({ error: "BUYER_BLACKLIST_INVALID", message: error instanceof Error ? error.message : "黑名单买家无效" }); }
  });

  app.post("/api/stock-prep/stores/:storeId/buyer-blacklist/from-order", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const input = z.object({ orderNumber: z.string().trim().min(1).max(100), reason: z.string().trim().min(1).max(1000) }).parse(request.body);
    try { service.addOrderBuyerToBlacklist(storeId, input.orderNumber, input.reason); return { added: true }; }
    catch (error) { return reply.code(409).send({ error: "BUYER_ID_UNAVAILABLE", message: error instanceof Error ? error.message : "无法从订单添加买家" }); }
  });

  app.patch("/api/stock-prep/stores/:storeId/buyer-blacklist/:entryId", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const { entryId } = z.object({ entryId: z.string().uuid() }).parse(request.params);
    const input = z.object({ status: z.enum(["active", "inactive"]) }).parse(request.body);
    try { service.updateBuyerBlacklist(storeId, entryId, input.status, "manual"); return { updated: true }; }
    catch (error) { return reply.code(404).send({ error: "BUYER_BLACKLIST_NOT_FOUND", message: error instanceof Error ? error.message : "黑名单记录不存在" }); }
  });

  app.get("/api/agent/v1/blacklist/openapi.json", { preHandler: requireLocalAgent }, async () => buildBlacklistAgentOpenApi());

  app.get("/api/agent/v1/blacklist/stores", { preHandler: requireLocalAgent }, async () => (await stores.list()).filter((store) => store.platform === "ozon").map(({ id, name, enabled }) => ({ id, name, enabled })));

  app.put("/api/agent/v1/stores/:storeId/blacklist/candidates", { preHandler: requireLocalAgent }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const store = await stores.findById(storeId);
    if (!store || store.platform !== "ozon") return reply.code(404).send({ error: "STORE_NOT_AVAILABLE", message: "目标 Ozon 店铺不存在" });
    const input = z.object({ candidates: z.array(z.object({ buyerId: z.string().trim().min(1).max(200), reasonCode: z.string().trim().min(1).max(100), summary: z.string().trim().max(2000).optional(), evidenceOrders: z.array(z.string().trim().min(1).max(100)).max(100).optional(), ruleVersion: z.string().trim().max(100).optional() })).max(500) }).parse(request.body);
    for (const item of input.candidates) service.upsertBuyerBlacklist(storeId, {
      buyerId: item.buyerId,
      status: "candidate",
      source: "agent",
      reasonCode: item.reasonCode,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.evidenceOrders ? { evidenceOrders: item.evidenceOrders } : {}),
      ...(item.ruleVersion ? { ruleVersion: item.ruleVersion } : {}),
    });
    return { submitted: input.candidates.length, status: "candidate" };
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

  app.post("/api/stock-prep/stores/:storeId/risk-approvals", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const input = z.object({ orderNumber: z.string().min(1).max(100) }).parse(request.body);
    try { service.approveRiskOrder(storeId, input.orderNumber); return { approved: true }; }
    catch (error) { return reply.code(409).send({ error: "RISK_APPROVAL_REJECTED", message: error instanceof Error ? error.message : "无法放行订单" }); }
  });

  app.delete("/api/stock-prep/stores/:storeId/risk-approvals/:orderNumber", { preHandler: requireSession }, async (request, reply) => {
    const { storeId } = storeParams.parse(request.params);
    const { orderNumber } = z.object({ orderNumber: z.string().min(1).max(100) }).parse(request.params);
    try { service.revokeRiskOrderApproval(storeId, orderNumber); return { revoked: true }; }
    catch (error) { return reply.code(409).send({ error: "RISK_APPROVAL_NOT_FOUND", message: error instanceof Error ? error.message : "无法撤回人工放行" }); }
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
