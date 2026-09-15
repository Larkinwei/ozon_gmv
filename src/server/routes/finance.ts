import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { financeOrderStatuses } from "../../shared/contracts";
import type { FinanceReader } from "../finance/finance-service";
import { requireSession } from "../security/session";

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份格式不正确");
const dateSchema = z.string().date();
const overviewQuerySchema = z.object({ month: monthSchema.optional(), storeIds: z.string().optional() });
const ordersQuerySchema = z.object({
  month: monthSchema.optional(),
  storeIds: z.string().optional(),
  sku: z.string().trim().max(100).optional(),
  status: z.enum(financeOrderStatuses).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const exceptionsQuerySchema = z.object({ month: monthSchema.optional(), storeIds: z.string().optional() });
const syncBodySchema = z.object({ month: monthSchema.optional(), from: dateSchema.optional(), to: dateSchema.optional(), storeIds: z.string().optional() }).refine(
  (value) => (!value.from && !value.to) || Boolean(value.from && value.to),
  { message: "同步日期必须同时提供开始和结束日期", path: ["to"] },
).refine((value) => !value.from || !value.to || value.from <= value.to, { message: "同步日期范围不正确", path: ["to"] });
const runParamsSchema = z.object({ id: z.string().uuid() });

function currentMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function monthDateRange(month: string): { from: string; to: string } {
  const [yearText, monthText] = month.split("-");
  const from = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, 1));
  const to = new Date(Date.UTC(Number(yearText), Number(monthText), 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function parseStoreIds(value?: string): string[] {
  if (!value) return [];
  return value.split(",").map((id) => z.string().uuid().parse(id.trim())).filter(Boolean);
}

/** Registers administrator-only order financial reconciliation endpoints. */
export function registerFinanceRoutes(app: FastifyInstance, finance: FinanceReader): void {
  app.get("/api/finance/overview", { preHandler: requireSession }, async (request) => {
    const query = overviewQuerySchema.parse(request.query);
    return finance.getOverview(query.month ?? currentMonth(), parseStoreIds(query.storeIds));
  });

  app.get("/api/finance/orders", { preHandler: requireSession }, async (request) => {
    const query = ordersQuerySchema.parse(request.query);
    return finance.getOrders({
      month: query.month ?? currentMonth(),
      storeIds: parseStoreIds(query.storeIds),
      ...(query.sku ? { sku: query.sku } : {}),
      ...(query.status ? { status: query.status } : {}),
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.get("/api/finance/orders/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = runParamsSchema.parse(request.params);
    const detail = await finance.getOrderDetail(id);
    if (!detail) return reply.code(404).send({ error: "FINANCE_ORDER_NOT_FOUND", message: "财务订单不存在" });
    return detail;
  });

  app.get("/api/finance/exceptions", { preHandler: requireSession }, async (request) => {
    const query = exceptionsQuerySchema.parse(request.query);
    return finance.getExceptions({ month: query.month ?? currentMonth(), storeIds: parseStoreIds(query.storeIds) });
  });

  app.post("/api/finance/sync", { preHandler: requireSession }, async (request, reply) => {
    const body = syncBodySchema.parse(request.body);
    const range = body.from && body.to ? { from: body.from, to: body.to } : monthDateRange(body.month ?? currentMonth());
    const run = await finance.beginSync({ from: range.from, to: range.to, storeIds: parseStoreIds(body.storeIds) });
    return reply.code(202).send(run);
  });

  app.get("/api/finance/sync/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = runParamsSchema.parse(request.params);
    const run = finance.getSyncRun(id);
    if (!run) return reply.code(404).send({ error: "FINANCE_SYNC_NOT_FOUND", message: "财务同步任务不存在" });
    return run;
  });
}
