import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  calculateProfitAtSalePrice,
  calculateShipping,
  calculateTargetPrice,
  CEL_RFBS_RULE_VERSION,
  defaultPricingFeeRates,
  PRICING_FORMULA_RULE_VERSION,
  type PricingCommonInputs,
  type PricingFeeRates,
  type PricingResult,
} from "../../shared/operations-pricing-calculations";
import type { ExchangeRateSnapshot } from "../../shared/contracts";
import type { ExchangeRateService } from "../services/exchange-rate-service";

const decimalTextSchema = z.string().trim().max(32).regex(/^\d{1,12}(?:\.\d{1,8})?$/, "金额和测量值必须是十进制数字字符串");
const positiveDecimalSchema = decimalTextSchema.refine((value) => Number(value) > 0, "数值必须大于 0");
const nonNegativeDecimalSchema = decimalTextSchema.refine((value) => Number(value) >= 0, "数值不能小于 0");
const percentageSchema = decimalTextSchema.refine((value) => Number(value) >= 0 && Number(value) <= 100, "比例必须在 0～100 之间");
const feeRatesSchema = z.object({
  commission: percentageSchema.optional(),
  tax: percentageSchema.optional(),
  withdrawal: percentageSchema.optional(),
  tailService: percentageSchema.optional(),
  advertising: percentageSchema.optional(),
  afterSales: percentageSchema.optional(),
}).optional();

const commonPricingSchema = z.object({
  weightKg: positiveDecimalSchema,
  lengthCm: positiveDecimalSchema.optional(),
  widthCm: positiveDecimalSchema.optional(),
  heightCm: positiveDecimalSchema.optional(),
  procurementCostCny: nonNegativeDecimalSchema,
  otherCostCny: nonNegativeDecimalSchema,
  feeRates: feeRatesSchema,
});
const targetPriceSchema = commonPricingSchema.extend({ targetProfitCny: nonNegativeDecimalSchema });
const existingPriceSchema = commonPricingSchema.extend({ salePriceCny: positiveDecimalSchema });
const shippingSchema = z.object({
  salePriceCny: positiveDecimalSchema,
  weightKg: positiveDecimalSchema,
  lengthCm: positiveDecimalSchema,
  widthCm: positiveDecimalSchema,
  heightCm: positiveDecimalSchema,
});

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function requireLocalAgent(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!loopbackAddresses.has(request.ip) || request.headers.origin) {
    await reply.code(403).send({ error: "LOCAL_AGENT_ONLY", message: "Agent API 仅接受本机命令行客户端" });
  }
}

type FeeRateOverrides = { [Key in keyof PricingFeeRates]?: string | undefined };

function mergeFeeRates(overrides: FeeRateOverrides | undefined): PricingFeeRates {
  return {
    commission: overrides?.commission ?? defaultPricingFeeRates.commission,
    tax: overrides?.tax ?? defaultPricingFeeRates.tax,
    withdrawal: overrides?.withdrawal ?? defaultPricingFeeRates.withdrawal,
    tailService: overrides?.tailService ?? defaultPricingFeeRates.tailService,
    advertising: overrides?.advertising ?? defaultPricingFeeRates.advertising,
    afterSales: overrides?.afterSales ?? defaultPricingFeeRates.afterSales,
  };
}

function omitSettlementEstimate<T extends PricingResult>(result: T): Omit<T, "platformReceivableCny"> {
  const { platformReceivableCny: _estimate, ...publicResult } = result;
  return publicResult;
}

function parseBody<T extends z.ZodType>(schema: T, body: unknown, reply: FastifyReply): z.infer<T> | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  reply.code(400).send({
    error: "VALIDATION_ERROR",
    message: "请求参数不正确",
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
  return null;
}

function getPublicPricingInputs(
  input: z.infer<typeof commonPricingSchema>,
  rubPerCny: string,
): PricingCommonInputs {
  return {
    weightKg: input.weightKg,
    ...(input.lengthCm !== undefined ? { lengthCm: input.lengthCm } : {}),
    ...(input.widthCm !== undefined ? { widthCm: input.widthCm } : {}),
    ...(input.heightCm !== undefined ? { heightCm: input.heightCm } : {}),
    procurementCostCny: input.procurementCostCny,
    otherCostCny: input.otherCostCny,
    feeRates: mergeFeeRates(input.feeRates),
    rubPerCny,
  };
}

function hasUsableExchangeRate(snapshot: ExchangeRateSnapshot): snapshot is ExchangeRateSnapshot & { rate: string } {
  return snapshot.available && snapshot.rate !== null && Number(snapshot.rate) > 0;
}

function sendExchangeRateUnavailable(reply: FastifyReply, snapshot: ExchangeRateSnapshot) {
  return reply.code(503).send({
    error: "EXCHANGE_RATE_UNAVAILABLE",
    message: "当前没有可用的人民币/卢布汇率，请先在定价工具中更新汇率",
    exchangeRate: snapshot,
  });
}

function buildOpenApiDocument(): Record<string, unknown> {
  const decimal = { type: "string", pattern: "^\\d{1,12}(?:\\.\\d{1,8})?$", example: "54.21" };
  const positiveDecimal = { ...decimal, description: "必须大于 0" };
  const optionalFeeRates = {
    type: "object",
    description: "可只传需要覆盖的比例；未提供的比例采用定价公式默认值。税费是国内税费估算，售后是按退货率估算，均不代表 Ozon 实际结算费用。",
    properties: Object.fromEntries(Object.keys(defaultPricingFeeRates).map((key) => [key, { ...decimal, maximum: 100 }])),
    additionalProperties: false,
  };
  const commonPricing = {
    type: "object",
    required: ["weightKg", "procurementCostCny", "otherCostCny"],
    properties: {
      weightKg: positiveDecimal,
      lengthCm: positiveDecimal,
      widthCm: positiveDecimal,
      heightCm: positiveDecimal,
      procurementCostCny: decimal,
      otherCostCny: decimal,
      feeRates: optionalFeeRates,
    },
    additionalProperties: false,
  };
  const exchangeRateResponse = {
    type: "object",
    properties: {
      rate: { type: "string", example: "10.2" },
      fromCurrency: { const: "CNY" },
      toCurrency: { const: "RUB" },
      source: { type: ["string", "null"] },
      effectiveDate: { type: ["string", "null"], format: "date" },
      checkedAt: { type: ["string", "null"], format: "date-time" },
      fetchedAt: { type: ["string", "null"], format: "date-time" },
      error: { type: ["string", "null"] },
    },
  };
  const rules = {
    type: "object",
    properties: {
      pricingFormulaVersion: { type: "string", example: PRICING_FORMULA_RULE_VERSION },
      shippingTariffVersion: { type: "string", example: CEL_RFBS_RULE_VERSION },
    },
  };
  const envelope = (result: Record<string, unknown>) => ({
    type: "object",
    properties: { result, exchangeRate: exchangeRateResponse, rules },
    required: ["result", "exchangeRate", "rules"],
  });
  const feeLine = {
    type: "object",
    properties: {
      key: { type: "string", enum: Object.keys(defaultPricingFeeRates) },
      label: { type: "string" },
      rate: { type: "string" },
      amountCny: { type: "string" },
    },
  };
  const pricingResult = {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["target-price", "existing-price"] },
      shippingCostCny: { type: "string" },
      procurementCostCny: { type: "string" },
      otherCostCny: { type: "string" },
      totalCostCny: { type: "string" },
      feeLines: { type: "array", items: feeLine },
      feeRateTotal: { type: "string" },
      shippingChannel: { type: ["string", "null"] },
    },
  };
  const targetResult = {
    ...pricingResult,
    properties: {
      ...pricingResult.properties,
      status: { type: "string", enum: ["stable", "needs-review"] },
      suggestedPriceCny: { type: "string" },
      suggestedPriceRub: { type: "string" },
      priceBand: { type: ["string", "null"] },
      targetProfitCny: { type: "string" },
      profitRate: { type: "string" },
      originalPriceCny: { type: "string" },
      statusMessage: { type: ["string", "null"] },
    },
  };
  const profitResult = {
    ...pricingResult,
    properties: {
      ...pricingResult.properties,
      actualSalePriceCny: { type: "string" },
      actualSalePriceRub: { type: "string" },
      priceBand: { type: ["string", "null"] },
      estimatedProfitCny: { type: "string" },
      profitRate: { type: "string" },
    },
  };
  const shippingResult = {
    type: "object",
    properties: {
      salePriceCny: { type: "string" },
      salePriceRub: { type: "string" },
      priceBand: { type: ["string", "null"] },
      channels: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            chineseName: { type: "string" },
            service: { type: "string" },
            deliveryTime: { type: "string" },
            feeCny: { type: ["string", "null"] },
            billableWeightKg: { type: ["string", "null"] },
            volumeWeightKg: { type: ["string", "null"] },
            availability: { type: "string", enum: ["available", "unsupported"] },
            reason: { type: ["string", "null"] },
            billingLogic: { type: "string" },
            returnService: { type: "string" },
            cheapest: { type: "boolean" },
            fastest: { type: "boolean" },
          },
        },
      },
    },
  };
  const errors = {
    "400": { description: "请求字段格式或取值不正确" },
    "403": { description: "只允许本机非浏览器客户端调用" },
    "503": { description: "本地尚无可用汇率" },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Ozon GMV Agent Pricing API",
      version: "1.0.0",
      description: "供同一台电脑上的 Agent 调用的定价与 rFBS 运费纯计算接口。仅本机 loopback 可访问；不需要 API Key。所有金额和测量值以十进制字符串传入。税费是国内税费估算，售后是按退货率估算，不代表 Ozon 实际结算费用。",
    },
    servers: [{ url: "http://127.0.0.1:3001", description: "本机管理端；端口可按安装配置调整" }],
    paths: {
      "/api/agent/v1/pricing/target-price": {
        post: {
          operationId: "calculateTargetPrice",
          summary: "按目标利润反推建议成交价",
          requestBody: { required: true, content: { "application/json": { schema: { ...commonPricing, required: [...commonPricing.required as string[], "targetProfitCny"], properties: { ...commonPricing.properties, targetProfitCny: decimal } } } } },
          responses: {
            "200": { description: "建议售价及成本、利润明细；不含平台回款估算字段", content: { "application/json": { schema: envelope(targetResult) } } },
            "422": { description: "当前费率或输入条件下无法生成有效建议价格" },
            ...errors,
          },
        },
      },
      "/api/agent/v1/pricing/profit": {
        post: {
          operationId: "calculateProfitAtSalePrice",
          summary: "按已有成交价估算利润",
          requestBody: { required: true, content: { "application/json": { schema: { ...commonPricing, required: [...commonPricing.required as string[], "salePriceCny"], properties: { ...commonPricing.properties, salePriceCny: positiveDecimal } } } } },
          responses: {
            "200": { description: "预计利润和费用明细；不含平台回款估算字段", content: { "application/json": { schema: envelope(profitResult) } } },
            "422": { description: "当前费率或输入条件下无法计算利润" },
            ...errors,
          },
        },
      },
      "/api/agent/v1/shipping/calculate": {
        post: {
          operationId: "calculateRFBShipping",
          summary: "试算 Ozon rFBS 全部物流渠道",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["salePriceCny", "weightKg", "lengthCm", "widthCm", "heightCm"],
                  properties: { salePriceCny: positiveDecimal, weightKg: positiveDecimal, lengthCm: positiveDecimal, widthCm: positiveDecimal, heightCm: positiveDecimal },
                  additionalProperties: false,
                },
              },
            },
          },
          responses: {
            "200": { description: "各渠道运费、计费重、时效及不适用原因", content: { "application/json": { schema: envelope(shippingResult) } } },
            ...errors,
          },
        },
      },
    },
  };
}

/** Registers unauthenticated loopback-only calculation APIs for local agents. */
export function registerAgentPricingRoutes(app: FastifyInstance, exchangeRate: ExchangeRateService): void {
  app.get("/api/agent/v1/openapi.json", { preHandler: requireLocalAgent }, async () => buildOpenApiDocument());

  app.post("/api/agent/v1/pricing/target-price", { preHandler: requireLocalAgent }, async (request, reply) => {
    const input = parseBody(targetPriceSchema, request.body, reply);
    if (!input) return;
    const snapshot = exchangeRate.view();
    if (!hasUsableExchangeRate(snapshot)) return sendExchangeRateUnavailable(reply, snapshot);
    const result = calculateTargetPrice({ ...getPublicPricingInputs(input, snapshot.rate), targetProfitCny: input.targetProfitCny });
    if (!result) return reply.code(422).send({ error: "CALCULATION_UNAVAILABLE", message: "当前费率或输入条件下无法生成有效建议价格" });
    return { result: omitSettlementEstimate(result), exchangeRate: snapshot, rules: { pricingFormulaVersion: PRICING_FORMULA_RULE_VERSION, shippingTariffVersion: CEL_RFBS_RULE_VERSION } };
  });

  app.post("/api/agent/v1/pricing/profit", { preHandler: requireLocalAgent }, async (request, reply) => {
    const input = parseBody(existingPriceSchema, request.body, reply);
    if (!input) return;
    const snapshot = exchangeRate.view();
    if (!hasUsableExchangeRate(snapshot)) return sendExchangeRateUnavailable(reply, snapshot);
    const result = calculateProfitAtSalePrice({ ...getPublicPricingInputs(input, snapshot.rate), salePriceCny: input.salePriceCny });
    if (!result) return reply.code(422).send({ error: "CALCULATION_UNAVAILABLE", message: "当前输入条件下无法计算利润" });
    return { result: omitSettlementEstimate(result), exchangeRate: snapshot, rules: { pricingFormulaVersion: PRICING_FORMULA_RULE_VERSION, shippingTariffVersion: CEL_RFBS_RULE_VERSION } };
  });

  app.post("/api/agent/v1/shipping/calculate", { preHandler: requireLocalAgent }, async (request, reply) => {
    const snapshot = exchangeRate.view();
    const input = parseBody(shippingSchema, request.body, reply);
    if (!input) return;
    if (!hasUsableExchangeRate(snapshot)) return sendExchangeRateUnavailable(reply, snapshot);
    const result = calculateShipping({ ...input, rubPerCny: snapshot.rate });
    return { result, exchangeRate: snapshot, rules: { shippingTariffVersion: CEL_RFBS_RULE_VERSION } };
  });
}
