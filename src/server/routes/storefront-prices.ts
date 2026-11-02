import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { requireSession } from "../security/session";
import type { StoresRepository } from "../db/stores-repository";
import type { StorefrontPriceMonitorService } from "../services/storefront-price-monitor";
import { ResellModule, ResellValidationError } from "../selection/resell-module";
import type { ExchangeRateService } from "../services/exchange-rate-service";

const jobIdSchema = z.object({ id: z.string().uuid() });
const createJobSchema = z.object({
  storeId: z.string().uuid(),
  products: z.array(z.object({
    productId: z.string().trim().min(1).max(100),
    sku: z.string().trim().max(100).nullable(),
    offerId: z.string().trim().min(1).max(100),
    productName: z.string().max(1000).nullable(),
    imageUrl: z.preprocess((value) => value === "" ? null : value, z.string().url().max(2048).nullable()),
    backendPrice: z.string().max(64).nullable(),
    currencyCode: z.string().max(8).nullable(),
  })).min(1).max(20_000),
});
const latestQuerySchema = z.object({
  storeId: z.string().uuid(),
  search: z.string().trim().max(300).default(""),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  frontPrice: z.enum(["all", "available", "missing"]).default("all"),
  difference: z.enum(["all", "higher", "lower", "equal", "unavailable"]).default("all"),
  sort: z.enum(["latest", "differenceDesc", "differenceAsc", "greenDesc", "greenAsc", "backendDesc", "backendAsc"]).default("latest"),
});
const historyQuerySchema = z.object({ storeId: z.string().uuid(), productId: z.string().trim().min(1).max(100) });
const jobDetailQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Registers administrator-only controls and reads for storefront price monitoring. */
export function registerStorefrontPriceRoutes(
  app: FastifyInstance,
  monitor: StorefrontPriceMonitorService,
  stores: StoresRepository,
  resell: ResellModule,
  exchangeRates?: ExchangeRateService,
): void {
  app.get("/api/operations/storefront-prices/jobs", { preHandler: requireSession }, async () => ({ items: monitor.listJobs(20) }));

  app.post("/api/operations/storefront-prices/jobs", { preHandler: requireSession }, async (request, reply) => {
    const input = createJobSchema.parse(request.body);
    const store = await stores.findById(input.storeId);
    if (!store || !store.enabled || store.platform !== "ozon") {
      return reply.code(404).send({ error: "STORE_NOT_AVAILABLE", message: "目标 Ozon 店铺不存在或已停用" });
    }

    const job = monitor.createJob({ id: store.id, name: store.name }, input.products);
    monitor.startCollection(job.id);
    return reply.code(201).send(job);
  });

  app.post("/api/operations/storefront-prices/jobs/all", { preHandler: requireSession }, async (request, reply) => {
    const input = z.object({ storeId: z.string().uuid() }).parse(request.body);
    const store = await stores.findById(input.storeId);
    if (!store || !store.enabled || store.platform !== "ozon") {
      return reply.code(404).send({ error: "STORE_NOT_AVAILABLE", message: "目标 Ozon 店铺不存在或已停用" });
    }
    try {
      const { items: products } = await resell.getOnlineProductsPage({ storeId: store.id, visibility: "VISIBLE" });
      const job = monitor.createJob({ id: store.id, name: store.name }, products.map((product) => ({
        productId: product.productId,
        sku: product.sku,
        offerId: product.offerId,
        productName: product.productName,
        imageUrl: product.imageUrl,
        backendPrice: product.price,
        currencyCode: product.currencyCode,
      })));
      monitor.startCollection(job.id);
      return reply.code(201).send(job);
    } catch (error) {
      if (error instanceof ResellValidationError) {
        return reply.code(422).send({ error: "ONLINE_PRODUCTS_READ_FAILED", message: error.message });
      }
      throw error;
    }
  });

  app.get("/api/operations/storefront-prices/jobs/:id/queue", { preHandler: requireSession }, async (request, reply) => {
    const { id } = jobIdSchema.parse(request.params);
    const job = monitor.getJob(id, 1, 1);
    return job ? { items: monitor.listQueuedItems(id) } : reply.code(404).send({ error: "JOB_NOT_FOUND", message: "采集任务不存在" });
  });

  app.post("/api/operations/storefront-prices/jobs/:id/activate", { preHandler: requireSession }, async (request, reply) => {
    const { id } = jobIdSchema.parse(request.params);
    const job = monitor.activateJob(id);
    return job ? job : reply.code(404).send({ error: "JOB_NOT_FOUND", message: "采集任务不存在" });
  });

  app.post("/api/operations/storefront-prices/jobs/:id/items/:itemId/result", { preHandler: requireSession }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), itemId: z.string().uuid() }).parse(request.params);
    const body = z.object({ payload: z.unknown().optional(), error: z.string().max(2000).nullable() }).parse(request.body);
    const recorded = monitor.recordBrowserResult(params.id, params.itemId, body.payload, body.error);
    return reply.send({ ok: true, recorded });
  });

  app.post("/api/operations/storefront-prices/jobs/:id/items/:itemId/retry", { preHandler: requireSession }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), itemId: z.string().uuid() }).parse(request.params);
    const retried = monitor.retryItem(params.id, params.itemId);
    if (retried) monitor.startCollection(params.id);
    return retried ? retried : reply.code(409).send({ error: "ITEM_NOT_RETRYABLE", message: "仅失败或无前台价格且 SKU 有效的商品可以重新采集" });
  });

  app.delete("/api/operations/storefront-prices/jobs/:id/items/:itemId", { preHandler: requireSession }, async (request, reply) => {
    const params = z.object({ id: z.string().uuid(), itemId: z.string().uuid() }).parse(request.params);
    const job = monitor.deleteFailedItem(params.id, params.itemId);
    return job ? job : reply.code(409).send({ error: "ITEM_NOT_DELETABLE", message: "仅失败或无前台价格的商品可以删除" });
  });

  app.get("/api/operations/storefront-prices/jobs/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = jobIdSchema.parse(request.params);
    const query = jobDetailQuerySchema.parse(request.query);
    const job = monitor.getJob(id, query.page, query.pageSize);
    return job ? job : reply.code(404).send({ error: "JOB_NOT_FOUND", message: "采集任务不存在" });
  });

  app.post("/api/operations/storefront-prices/jobs/:id/:action", { preHandler: requireSession }, async (request, reply) => {
    const { id } = jobIdSchema.parse(request.params);
    const action = z.enum(["pause", "resume", "cancel"]).parse((request.params as { action?: string }).action);
    const job = monitor.setJobState(id, action);
    return job ? job : reply.code(404).send({ error: "JOB_NOT_FOUND", message: "采集任务不存在" });
  });

  app.get("/api/operations/storefront-prices/latest", { preHandler: requireSession }, async (request) => {
    const query = latestQuerySchema.parse(request.query);
    const exchangeRate = exchangeRates?.view();
    const rubPerCny = exchangeRate?.available && exchangeRate.rate ? Number(exchangeRate.rate) : null;
    return monitor.listLatest({ ...query, rubPerCny });
  });

  app.get("/api/operations/storefront-prices/history", { preHandler: requireSession }, async (request) => {
    const query = historyQuerySchema.parse(request.query);
    return { items: monitor.listHistory(query.storeId, query.productId) };
  });
}
