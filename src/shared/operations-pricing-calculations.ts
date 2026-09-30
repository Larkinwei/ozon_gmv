import Decimal from "decimal.js";

export interface PricingFeeRates {
  commission: string;
  tax: string;
  withdrawal: string;
  tailService: string;
  advertising: string;
  afterSales: string;
}

export type PricingMode = "target-price" | "existing-price";

export interface PricingCommonInputs {
  weightKg: string;
  lengthCm?: string;
  widthCm?: string;
  heightCm?: string;
  procurementCostCny: string;
  otherCostCny: string;
  feeRates: PricingFeeRates;
  rubPerCny: string;
}

export interface TargetPriceInputs extends PricingCommonInputs {
  targetProfitCny: string;
}

export interface ExistingPriceInputs extends PricingCommonInputs {
  salePriceCny: string;
}

export interface PricingFeeLine {
  key: keyof PricingFeeRates;
  label: string;
  rate: string;
  amountCny: string;
}

export interface PricingCalculationBase {
  mode: PricingMode;
  shippingCostCny: string;
  procurementCostCny: string;
  otherCostCny: string;
  totalCostCny: string;
  platformReceivableCny: string;
  feeLines: PricingFeeLine[];
  feeRateTotal: string;
  shippingChannel: string | null;
}

export interface TargetPriceCalculation extends PricingCalculationBase {
  mode: "target-price";
  status: "stable" | "needs-review";
  suggestedPriceCny: string;
  suggestedPriceRub: string;
  priceBand: string | null;
  targetProfitCny: string;
  profitRate: string;
  originalPriceCny: string;
  statusMessage: string | null;
}

export interface ProfitCalculation extends PricingCalculationBase {
  mode: "existing-price";
  actualSalePriceCny: string;
  actualSalePriceRub: string;
  priceBand: string | null;
  estimatedProfitCny: string;
  profitRate: string;
}

export type PricingResult = TargetPriceCalculation | ProfitCalculation;

export interface ShippingInputs {
  salePriceCny: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  rubPerCny: string;
}

export type ShippingAvailability = "available" | "unsupported";

export interface ShippingChannelResult {
  id: string;
  name: string;
  chineseName: string;
  service: string;
  deliveryTime: string;
  feeCny: string | null;
  billableWeightKg: string | null;
  volumeWeightKg: string | null;
  availability: ShippingAvailability;
  reason: string | null;
  billingLogic: string;
  returnService: string;
  cheapest: boolean;
  fastest: boolean;
}

export interface ShippingCalculation {
  salePriceCny: string;
  salePriceRub: string;
  priceBand: string | null;
  channels: ShippingChannelResult[];
}

export type ShippingRiskLevel = "safe" | "critical" | "high-risk" | "unsupported";
export type MeasurementPreset = "reliable" | "normal" | "conservative" | "custom";

export interface MeasurementUncertainty {
  enabled: boolean;
  preset: MeasurementPreset;
  weightPercent: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
}

export interface ShippingRiskFactor {
  key: string;
  label: string;
  currentValue: string;
  boundary: string;
  unit: string;
  message: string;
}

export interface ShippingRiskScenario {
  label: string;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  availableChannelIds: string[];
  lowestFeeCny: string | null;
  highestFeeCny: string | null;
  priceBand: string | null;
}

export interface ShippingRiskResult {
  level: ShippingRiskLevel;
  enabled: boolean;
  hasDimensions: boolean;
  summary: string;
  factors: ShippingRiskFactor[];
  scenarios: ShippingRiskScenario[];
  current: ShippingRiskScenario | null;
  conservative: ShippingRiskScenario | null;
  lowestFeeCny: string | null;
  highestFeeCny: string | null;
  recommendations: string[];
}

export interface PricingScenarioSnapshot {
  id: string;
  name: string;
  mode: PricingMode;
  inputs: PricingCommonInputs & Partial<Pick<TargetPriceInputs, "targetProfitCny"> & Pick<ExistingPriceInputs, "salePriceCny">>;
  result: PricingResult;
  risk: ShippingRiskResult;
}

export interface PricingScenarioComparison {
  leftId: string;
  rightId: string;
  fields: Array<{ key: string; label: string; left: string; right: string; difference: string }>;
}

export const CEL_RFBS_RULE_VERSION = "CEL OZON-rFBS V7.24";
export const PRICING_FORMULA_RULE_VERSION = "Pricing Formula V1";

const pricingFeeLabels: Record<keyof PricingFeeRates, string> = {
  commission: "平台佣金",
  tax: "税费",
  withdrawal: "提现手续费",
  tailService: "尾程、服务费等",
  advertising: "广告、营销",
  afterSales: "售后",
};

export const defaultPricingFeeRates: PricingFeeRates = {
  commission: "15",
  tax: "8",
  withdrawal: "1.2",
  tailService: "8",
  advertising: "0",
  afterSales: "1",
};

const feeKeys: Array<keyof PricingFeeRates> = ["commission", "tax", "withdrawal", "tailService", "advertising", "afterSales"];

interface PricingBand {
  label: string;
  min: number;
  max: number;
}

const pricingBands: PricingBand[] = [
  { label: "1～1,500 ₽", min: 1, max: 1500 },
  { label: "1,501～7,000 ₽", min: 1501, max: 7000 },
  { label: "7,001～250,000 ₽", min: 7001, max: 250000 },
];

function decimal(value: string): Decimal {
  return new Decimal(value);
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function exact(value: Decimal): string {
  return value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

function inRange(value: Decimal, min: number, max: number): boolean {
  return value.gte(min) && value.lte(max);
}

export function classifyOzonPrice(priceRub: string): string | null {
  const price = decimal(priceRub);
  if (inRange(price, 1, 1500)) return "1～1,500 ₽";
  if (inRange(price, 1501, 7000)) return "1,501～7,000 ₽";
  if (inRange(price, 7001, 250000)) return "7,001～250,000 ₽";
  if (inRange(price, 250001, 500000)) return "250,001～500,000 ₽";
  return null;
}

function calculatePriceBandShipping(priceRub: Decimal, weightKg: Decimal): Decimal | null {
  if (inRange(priceRub, 1, 1500) && weightKg.gt(0) && weightKg.lte(0.5)) return weightKg.mul(1000).mul("0.0393").plus("3.37");
  if (inRange(priceRub, 1, 1500) && weightKg.gt(0.5) && weightKg.lte(30)) return weightKg.mul(1000).mul("0.0191").plus("25.83");
  if (inRange(priceRub, 1501, 7000) && weightKg.gt(0) && weightKg.lte(2)) return weightKg.mul(1000).mul("0.0393").plus("17.97");
  if (inRange(priceRub, 1501, 7000) && weightKg.gt(2) && weightKg.lte(30)) return weightKg.mul(1000).mul("0.0191").plus("40.44");
  if (inRange(priceRub, 7001, 250000) && weightKg.gt(0) && weightKg.lte(5)) return weightKg.mul(1000).mul("0.0393").plus("24.71");
  if (inRange(priceRub, 7001, 250000) && weightKg.gt(5) && weightKg.lte(30)) return weightKg.mul(1000).mul("0.0258").plus("69.64");
  return null;
}

function feeRateSummary(feeRates: PricingFeeRates): { total: Decimal; denominator: Decimal } {
  const total = feeKeys.reduce((sum, key) => sum.plus(decimal(feeRates[key]).div(100)), new Decimal(0));
  return { total, denominator: new Decimal(1).minus(total) };
}

function createFeeLines(priceCny: Decimal, feeRates: PricingFeeRates): PricingFeeLine[] {
  return feeKeys.map((key) => ({
    key,
    label: pricingFeeLabels[key],
    rate: feeRates[key],
    amountCny: money(priceCny.mul(decimal(feeRates[key]).div(100))),
  }));
}

function feeTotal(feeLines: PricingFeeLine[]): Decimal {
  return feeLines.reduce((sum, line) => sum.plus(decimal(line.amountCny)), new Decimal(0));
}

function buildCalculationBase(
  mode: PricingMode,
  salePriceCny: Decimal,
  shippingCostCny: Decimal,
  procurementCostCny: Decimal,
  otherCostCny: Decimal,
  feeRates: PricingFeeRates,
  shippingChannel: string | null = null,
): PricingCalculationBase {
  const feeLines = createFeeLines(salePriceCny, feeRates);
  const platformFees = feeTotal(feeLines);
  const totalCost = procurementCostCny.plus(otherCostCny).plus(shippingCostCny).plus(platformFees);
  return {
    mode,
    shippingCostCny: money(shippingCostCny),
    procurementCostCny: money(procurementCostCny),
    otherCostCny: money(otherCostCny),
    totalCostCny: money(totalCost),
    platformReceivableCny: money(salePriceCny.minus(platformFees)),
    feeLines,
    feeRateTotal: exact(feeRateSummary(feeRates).total.mul(100)),
    shippingChannel,
  };
}

function hasCompleteDimensions(inputs: PricingCommonInputs): boolean {
  return [inputs.lengthCm, inputs.widthCm, inputs.heightCm].every((value) => Boolean(value) && Number.isFinite(Number(value)) && Number(value) > 0);
}

function resolveShippingForPrice(inputs: PricingCommonInputs, salePriceCny: Decimal): { fee: Decimal; channel: string | null } | null {
  if (!hasCompleteDimensions(inputs)) {
    const fee = calculatePriceBandShipping(salePriceCny.mul(decimal(inputs.rubPerCny)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP), decimal(inputs.weightKg));
    return fee === null ? null : { fee, channel: null };
  }
  const result = calculateShipping({ salePriceCny: salePriceCny.toFixed(12), weightKg: inputs.weightKg, lengthCm: inputs.lengthCm as string, widthCm: inputs.widthCm as string, heightCm: inputs.heightCm as string, rubPerCny: inputs.rubPerCny });
  const available = result.channels.filter((channel) => channel.availability === "available" && channel.feeCny !== null);
  const cheapest = available.reduce<typeof available[number] | null>((current, channel) => current === null || Number(channel.feeCny) < Number(current.feeCny) ? channel : current, null);
  return cheapest?.feeCny ? { fee: decimal(cheapest.feeCny), channel: `${cheapest.name} · ${cheapest.chineseName}` } : null;
}

function calculateTargetCandidate(inputs: TargetPriceInputs, band: PricingBand, denominator: Decimal): TargetPriceCalculation | null {
  const weightKg = decimal(inputs.weightKg);
  let shipping = calculatePriceBandShipping(new Decimal(band.min), weightKg);
  if (shipping === null && !hasCompleteDimensions(inputs)) return null;

  const procurementCostCny = decimal(inputs.procurementCostCny);
  const otherCostCny = decimal(inputs.otherCostCny);
  const targetProfitCny = decimal(inputs.targetProfitCny);
  let suggestedPriceCny = procurementCostCny.plus(shipping ?? 0).plus(otherCostCny).plus(targetProfitCny).div(denominator);
  let shippingChannel: string | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const resolved = resolveShippingForPrice(inputs, suggestedPriceCny);
    if (resolved === null) return null;
    const nextPrice = procurementCostCny.plus(resolved.fee).plus(otherCostCny).plus(targetProfitCny).div(denominator);
    shipping = resolved.fee;
    shippingChannel = resolved.channel;
    if (nextPrice.minus(suggestedPriceCny).abs().lt("0.000001")) {
      suggestedPriceCny = nextPrice;
      break;
    }
    suggestedPriceCny = nextPrice;
  }
  if (shipping === null) return null;
  const suggestedPriceRub = suggestedPriceCny.mul(decimal(inputs.rubPerCny)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const priceBand = classifyOzonPrice(suggestedPriceRub.toFixed(2));
  const base = buildCalculationBase("target-price", suggestedPriceCny, shipping, procurementCostCny, otherCostCny, inputs.feeRates, shippingChannel);
  const profitRate = targetProfitCny.div(suggestedPriceCny).mul(100);
  const stable = priceBand === band.label;
  return {
    ...base,
    mode: "target-price",
    status: stable ? "stable" : "needs-review",
    suggestedPriceCny: exact(suggestedPriceCny),
    suggestedPriceRub: suggestedPriceRub.toFixed(2),
    priceBand,
    targetProfitCny: money(targetProfitCny),
    profitRate: exact(profitRate),
    originalPriceCny: exact(suggestedPriceCny.mul(2)),
    statusMessage: stable ? null : "建议售价跨越了运费价格区间，请人工确认后再发布。",
  };
}

/** Calculates a stable suggested price by solving each supported Ozon price band. */
export function calculateTargetPrice(inputs: TargetPriceInputs): TargetPriceCalculation | null {
  const { denominator } = feeRateSummary(inputs.feeRates);
  if (denominator.lte(0)) return null;
  const candidates = pricingBands.map((band) => calculateTargetCandidate(inputs, band, denominator)).filter((candidate): candidate is TargetPriceCalculation => candidate !== null);
  const stable = candidates.find((candidate) => candidate.status === "stable");
  return stable ?? candidates[0] ?? null;
}

/** Calculates profit from an already published Ozon transaction price. */
export function calculateProfitAtSalePrice(inputs: ExistingPriceInputs): ProfitCalculation | null {
  const salePriceCny = decimal(inputs.salePriceCny);
  const salePriceRub = salePriceCny.mul(decimal(inputs.rubPerCny)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const resolved = resolveShippingForPrice(inputs, salePriceCny);
  if (resolved === null) return null;
  const shipping = resolved.fee;
  const procurementCostCny = decimal(inputs.procurementCostCny);
  const otherCostCny = decimal(inputs.otherCostCny);
  const base = buildCalculationBase("existing-price", salePriceCny, shipping, procurementCostCny, otherCostCny, inputs.feeRates, resolved.channel);
  const estimatedProfit = salePriceCny.minus(decimal(base.totalCostCny));
  return {
    ...base,
    mode: "existing-price",
    actualSalePriceCny: money(salePriceCny),
    actualSalePriceRub: salePriceRub.toFixed(2),
    priceBand: classifyOzonPrice(salePriceRub.toFixed(2)),
    estimatedProfitCny: money(estimatedProfit),
    profitRate: exact(estimatedProfit.div(salePriceCny).mul(100)),
  };
}

interface ChannelDefinition {
  id: string;
  name: string;
  chineseName: string;
  service: string;
  deliveryTime: string;
  priceMin: number;
  priceMax: number;
  weightMin: number;
  weightMax: number;
  dimensionSumMax: number;
  edgeMax: number;
  volumetricDivisor: number | undefined;
  billableWeightMax: number | undefined;
  ratePerKg: string;
  fixedFee: string;
  roundBillableToTenth: boolean;
  billingLogic: string;
  returnService: string;
}

const rFbsChannels: ChannelDefinition[] = [
  ["extra-small-express", "CEL Express Extra Small", "超级轻小件", "陆空特快", "5-10天", 1, 1500, 0, 0.5, 90, 60, undefined, undefined, "50.5", "3.37", false, "实重计费", "免费销毁；无改派；无退回"],
  ["extra-small-standard", "CEL Standard Extra Small", "超级轻小件", "陆空标准", "10-15天", 1, 1500, 0, 0.5, 90, 60, undefined, undefined, "39.3", "3.37", false, "实重计费", "免费销毁；无改派；无退回"],
  ["extra-small-economy", "CEL Economy Extra Small", "超级轻小件", "陆运经济", "15-25天", 1, 1500, 0, 0.5, 90, 60, undefined, undefined, "28.1", "3.37", false, "实重计费", "免费销毁；无改派；无退回"],
  ["budget-express", "CEL Express Budget", "低客单价标准件", "陆空特快", "5-10天", 1, 1500, 0.5, 30, 150, 60, undefined, undefined, "37.1", "25.83", false, "实重计费", "未填写"],
  ["budget-standard", "CEL Standard Budget", "低客单价标准件", "陆空标准", "10-15天", 1, 1500, 0.5, 30, 150, 60, undefined, undefined, "28.1", "25.83", false, "实重计费", "未填写"],
  ["budget-economy", "CEL Economy Budget", "低客单价标准件", "陆运经济", "15-25天", 1, 1500, 0.5, 30, 150, 60, undefined, undefined, "19.1", "25.83", false, "实重计费", "未填写"],
  ["small-express", "CEL Express Small", "小件", "陆空特快", "5-10天", 1501, 7000, 0, 2, 150, 60, undefined, undefined, "50.5", "17.97", false, "实重计费", "免费销毁；支持改派；退回收取正向运价 1.5 倍"],
  ["small-standard", "CEL Standard Small", "小件", "陆空标准", "10-15天", 1501, 7000, 0, 2, 150, 60, undefined, undefined, "39.3", "17.97", false, "实重计费", "免费销毁；支持改派；退回收取正向运价 1.5 倍"],
  ["small-economy", "CEL Economy Small", "小件", "陆运经济", "15-25天", 1501, 7000, 0, 2, 150, 60, undefined, undefined, "28.1", "17.97", false, "实重计费", "免费销毁；支持改派；退回收取正向运价 1.5 倍"],
  ["big-standard", "CEL Standard Big", "大件", "陆空标准", "10-15天", 1501, 7000, 2, 30, 310, 150, 12000, 31, "28.1", "40.44", false, "实重与体积重取较大值计费", "未填写"],
  ["big-economy", "CEL Economy Big", "大件", "陆运经济", "15-25天", 1501, 7000, 2, 30, 310, 150, 12000, 31, "19.1", "40.44", false, "实重与体积重取较大值计费", "未填写"],
  ["premium-small-express", "CEL Express Premium Small", "高客单价小件", "陆空特快", "5-10天", 7001, 250000, 0, 5, 250, 150, undefined, undefined, "50.5", "24.71", false, "实重计费", "未填写"],
  ["premium-small-standard", "CEL Standard Premium Small", "高客单价小件", "陆空标准", "10-15天", 7001, 250000, 0, 5, 250, 150, undefined, undefined, "39.3", "24.71", false, "实重计费", "未填写"],
  ["premium-small-economy", "CEL Economy Premium Small", "高客单价小件", "陆运经济", "15-25天", 7001, 250000, 0, 5, 250, 150, undefined, undefined, "28.1", "24.71", false, "实重计费", "未填写"],
  ["premium-big-standard", "CEL Standard Premium Big", "高客单价大件", "陆空标准", "10-15天", 7001, 250000, 5, 30, 310, 150, 12000, 80, "31.4", "69.64", false, "实重与体积重取较大值计费", "未填写"],
  ["premium-big-economy", "CEL Economy Premium Big", "高客单价大件", "陆运经济", "15-25天", 7001, 250000, 5, 30, 310, 150, 12000, 80, "25.8", "69.64", false, "实重与体积重取较大值计费", "未填写"],
  ["hk-express", "CEL Express HK", "中国香港", "香港空运", "7-12天", 1, 500000, 0, 25, 310, 150, 6000, undefined, "96", "19", true, "三边和超过 60cm 时使用体积重；百克进位", "免费销毁；支持改派；退运收取正向运价 1.5 倍"],
].map(([id, name, category, service, deliveryTime, priceMin, priceMax, weightMin, weightMax, dimensionSumMax, edgeMax, volumetricDivisor, billableWeightMax, ratePerKg, fixedFee, roundBillableToTenth, billingLogic, returnService]) => ({
  id: id as string,
  name: name as string,
  chineseName: category === "中国香港" ? "香港空运" : `${category}（${service}）`,
  service: service as string,
  deliveryTime: deliveryTime as string,
  priceMin: priceMin as number,
  priceMax: priceMax as number,
  weightMin: weightMin as number,
  weightMax: weightMax as number,
  dimensionSumMax: dimensionSumMax as number,
  edgeMax: edgeMax as number,
  volumetricDivisor: volumetricDivisor as number | undefined,
  billableWeightMax: billableWeightMax as number | undefined,
  ratePerKg: ratePerKg as string,
  fixedFee: fixedFee as string,
  roundBillableToTenth: roundBillableToTenth as boolean,
  billingLogic: billingLogic as string,
  returnService: returnService as string,
}));

function roundUpTenth(value: Decimal): Decimal {
  return value.mul(10).ceil().div(10);
}

function unsupportedReason(definition: ChannelDefinition, priceRub: Decimal, weightKg: Decimal, dimensionSum: Decimal, maxEdge: Decimal, billableWeight: Decimal | null): string | null {
  const reasons: string[] = [];
  if (!inRange(priceRub, definition.priceMin, definition.priceMax)) reasons.push(`货值需在 ${definition.priceMin}～${definition.priceMax} ₽`);
  if (!(weightKg.gt(definition.weightMin) && weightKg.lte(definition.weightMax))) reasons.push(`重量需大于 ${definition.weightMin}kg 且不超过 ${definition.weightMax}kg`);
  if (dimensionSum.gt(definition.dimensionSumMax)) reasons.push(`三边和超过 ${definition.dimensionSumMax}cm`);
  if (maxEdge.gt(definition.edgeMax)) reasons.push(`单边超过 ${definition.edgeMax}cm`);
  if (billableWeight !== null && definition.billableWeightMax !== undefined && billableWeight.gt(definition.billableWeightMax)) reasons.push(`计费重超过 ${definition.billableWeightMax}kg`);
  return reasons.length > 0 ? reasons.join("；") : null;
}

export function calculateShipping(inputs: ShippingInputs): ShippingCalculation {
  const salePriceCny = decimal(inputs.salePriceCny);
  const rubPerCny = decimal(inputs.rubPerCny);
  const priceRub = salePriceCny.mul(rubPerCny).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const weightKg = decimal(inputs.weightKg);
  const lengthCm = decimal(inputs.lengthCm);
  const widthCm = decimal(inputs.widthCm);
  const heightCm = decimal(inputs.heightCm);
  const dimensionSum = lengthCm.plus(widthCm).plus(heightCm);
  const maxEdge = Decimal.max(lengthCm, widthCm, heightCm);
  const channels = rFbsChannels.map((definition) => {
    const volumeWeight = definition.volumetricDivisor && dimensionSum.gt(60) ? lengthCm.mul(widthCm).mul(heightCm).div(definition.volumetricDivisor) : null;
    let billableWeight = definition.volumetricDivisor ? Decimal.max(weightKg, volumeWeight ?? new Decimal(0)) : weightKg;
    if (definition.roundBillableToTenth) billableWeight = roundUpTenth(billableWeight);
    const reason = unsupportedReason(definition, priceRub, weightKg, dimensionSum, maxEdge, billableWeight);
    const fee = reason ? null : billableWeight.mul(definition.ratePerKg).plus(definition.fixedFee);
    return {
      id: definition.id,
      name: definition.name,
      chineseName: definition.chineseName,
      service: definition.service,
      deliveryTime: definition.deliveryTime,
      feeCny: fee ? money(fee) : null,
      billableWeightKg: reason ? null : money(billableWeight),
      volumeWeightKg: volumeWeight ? money(volumeWeight) : null,
      availability: reason ? "unsupported" as const : "available" as const,
      reason,
      billingLogic: definition.billingLogic,
      returnService: definition.returnService,
      cheapest: false,
      fastest: false,
    };
  });
  const available = channels.filter((channel) => channel.availability === "available");
  const cheapestFee = available.length > 0 ? Math.min(...available.map((channel) => Number(channel.feeCny))) : null;
  const fastestTime = available.length > 0 ? Math.min(...available.map((channel) => Number(channel.deliveryTime.match(/\d+/)?.[0] ?? "999"))) : null;
  return {
    salePriceCny: money(salePriceCny),
    salePriceRub: priceRub.toFixed(2),
    priceBand: classifyOzonPrice(priceRub.toFixed(2)),
    channels: channels.map((channel) => ({
      ...channel,
      cheapest: channel.availability === "available" && Number(channel.feeCny) === cheapestFee,
      fastest: channel.availability === "available" && Number(channel.deliveryTime.match(/\d+/)?.[0] ?? "999") === fastestTime,
    })),
  };
}

function toRiskScenario(label: string, inputs: ShippingInputs): ShippingRiskScenario {
  const calculation = calculateShipping(inputs);
  const available = calculation.channels.filter((channel) => channel.availability === "available");
  const fees = available.map((channel) => new Decimal(channel.feeCny ?? "0"));
  return {
    label,
    weightKg: inputs.weightKg,
    lengthCm: inputs.lengthCm,
    widthCm: inputs.widthCm,
    heightCm: inputs.heightCm,
    availableChannelIds: available.map((channel) => channel.id),
    lowestFeeCny: fees.length > 0 ? money(Decimal.min(...fees)) : null,
    highestFeeCny: fees.length > 0 ? money(Decimal.max(...fees)) : null,
    priceBand: calculation.priceBand,
  };
}

function uniqueNearbyBoundaries(values: number[], current: Decimal): number[] {
  return values.filter((value, index, all) => all.indexOf(value) === index && Math.abs(current.toNumber() - value) <= Math.max(3, current.toNumber() * 0.2));
}

function buildRiskFactors(inputs: ShippingInputs, uncertainty: MeasurementUncertainty): ShippingRiskFactor[] {
  const weight = decimal(inputs.weightKg);
  const length = decimal(inputs.lengthCm);
  const width = decimal(inputs.widthCm);
  const height = decimal(inputs.heightCm);
  const dimensionSum = length.plus(width).plus(height);
  const maxEdge = Decimal.max(length, width, height);
  const factors: ShippingRiskFactor[] = [];
  const weightTolerance = weight.mul(decimal(uncertainty.weightPercent).div(100));
  for (const boundary of uniqueNearbyBoundaries([0.5, 2, 5, 30], weight)) {
    if (weight.minus(weightTolerance).lte(boundary) && weight.plus(weightTolerance).gte(boundary)) {
      factors.push({ key: `weight-${boundary}`, label: "重量", currentValue: weight.toFixed(2), boundary: boundary.toFixed(2), unit: "kg", message: `重量 ${weight.toFixed(2)}kg 的误差范围可能跨过 ${boundary.toFixed(2)}kg 物流边界。` });
    }
  }
  const sumTolerance = decimal(uncertainty.lengthCm).plus(decimal(uncertainty.widthCm)).plus(decimal(uncertainty.heightCm));
  for (const boundary of uniqueNearbyBoundaries([90, 150, 310], dimensionSum)) {
    if (dimensionSum.minus(sumTolerance).lte(boundary) && dimensionSum.plus(sumTolerance).gte(boundary)) {
      factors.push({ key: `sum-${boundary}`, label: "三边和", currentValue: dimensionSum.toFixed(1), boundary: boundary.toFixed(1), unit: "cm", message: `三边和 ${dimensionSum.toFixed(1)}cm 的尺寸误差可能超过 ${boundary}cm。` });
    }
  }
  const edgeTolerance = Decimal.max(decimal(uncertainty.lengthCm), decimal(uncertainty.widthCm), decimal(uncertainty.heightCm));
  for (const boundary of uniqueNearbyBoundaries([60, 120, 150], maxEdge)) {
    if (maxEdge.minus(edgeTolerance).lte(boundary) && maxEdge.plus(edgeTolerance).gte(boundary)) {
      factors.push({ key: `edge-${boundary}`, label: "最大边", currentValue: maxEdge.toFixed(1), boundary: boundary.toFixed(1), unit: "cm", message: `最大边 ${maxEdge.toFixed(1)}cm 的尺寸误差可能超过 ${boundary}cm。` });
    }
  }
  return factors;
}

function buildShippingRiskInputs(base: ShippingInputs, weight: Decimal, dimensions: Decimal[]): ShippingInputs {
  const [length, width, height] = dimensions;
  if (!length || !width || !height) throw new Error("物流风险模拟缺少尺寸");
  return { ...base, weightKg: weight.toFixed(8), lengthCm: length.toFixed(8), widthCm: width.toFixed(8), heightCm: height.toFixed(8) };
}

/** Simulates package measurement errors while reusing the production rFBS calculator. */
export function calculateShippingRisk(inputs: ShippingInputs, uncertainty: MeasurementUncertainty): ShippingRiskResult {
  if (!uncertainty.enabled) {
    return { level: "safe", enabled: false, hasDimensions: true, summary: "已关闭测量误差分析。", factors: [], scenarios: [], current: null, conservative: null, lowestFeeCny: null, highestFeeCny: null, recommendations: [] };
  }
  const dimensionValues = [inputs.lengthCm, inputs.widthCm, inputs.heightCm];
  const hasDimensions = dimensionValues.every((value) => value && Number.isFinite(Number(value)) && Number(value) > 0);
  if (!hasDimensions) {
    return { level: "critical", enabled: true, hasDimensions: false, summary: "未填写完整包装尺寸，无法判断体积重、三边和及单边风险。", factors: [], scenarios: [], current: null, conservative: null, lowestFeeCny: null, highestFeeCny: null, recommendations: ["让供应商提供含包装实重", "重新测量实物外包装长宽高", "拿到完整包装数据后再确认物流渠道"] };
  }
  const weight = decimal(inputs.weightKg);
  const dimensions = dimensionValues.map(decimal);
  const weightTolerance = decimal(uncertainty.weightPercent).div(100);
  const dimensionTolerance = [uncertainty.lengthCm, uncertainty.widthCm, uncertainty.heightCm].map(decimal);
  const lowDimensions = dimensions.map((value, index) => Decimal.max(value.minus(dimensionTolerance[index] as Decimal), new Decimal("0.01")));
  const highDimensions = dimensions.map((value, index) => value.plus(dimensionTolerance[index] as Decimal));
  const lowWeight = Decimal.max(weight.mul(new Decimal(1).minus(weightTolerance)), new Decimal("0.001"));
  const highWeight = weight.mul(new Decimal(1).plus(weightTolerance));
  const current = toRiskScenario("当前测量值", inputs);
  const conservative = toRiskScenario("保守估算", buildShippingRiskInputs(inputs, highWeight, highDimensions));
  const scenarios: ShippingRiskScenario[] = [current, conservative];
  const dimensionOptions = dimensions.map((_value, index) => [lowDimensions[index] as Decimal, highDimensions[index] as Decimal]);
  for (const scenarioWeight of [lowWeight, highWeight]) {
    for (const length of dimensionOptions[0] as Decimal[]) {
      for (const width of dimensionOptions[1] as Decimal[]) {
        for (const height of dimensionOptions[2] as Decimal[]) {
          const candidate = toRiskScenario("误差场景", buildShippingRiskInputs(inputs, scenarioWeight, [length, width, height]));
          const exists = scenarios.some((item) => item.weightKg === candidate.weightKg && item.lengthCm === candidate.lengthCm && item.widthCm === candidate.widthCm && item.heightCm === candidate.heightCm);
          if (!exists) scenarios.push(candidate);
        }
      }
    }
  }
  const factors = buildRiskFactors(inputs, uncertainty);
  const channelSetChanged = scenarios.some((scenario) => scenario.availableChannelIds.join(",") !== current.availableChannelIds.join(","));
  const minFees = scenarios.flatMap((scenario) => scenario.lowestFeeCny ? [new Decimal(scenario.lowestFeeCny)] : []);
  const maxFees = scenarios.flatMap((scenario) => scenario.highestFeeCny ? [new Decimal(scenario.highestFeeCny)] : []);
  const unsupported = conservative.availableChannelIds.length === 0;
  const level: ShippingRiskLevel = unsupported ? "unsupported" : channelSetChanged ? "high-risk" : factors.length > 0 ? "critical" : "safe";
  const recommendations = factors.length > 0 || channelSetChanged
    ? ["让供应商提供含包装实重", "重新测量实物外包装长宽高", "按较高一档物流费用计入成本"]
    : ["保留含包装测量记录，发货前复核一次"];
  if (unsupported) recommendations.unshift("当前保守测量值不符合任何渠道，不适合直接发布");
  return {
    level,
    enabled: true,
    hasDimensions: true,
    summary: unsupported ? "保守测量值无适用渠道。" : channelSetChanged ? "测量误差可能导致物流渠道或计费规则变化。" : factors.length > 0 ? "当前参数接近物流切换边界，建议按高档预算。" : "误差范围内渠道和费用没有明显变化。",
    factors,
    scenarios,
    current,
    conservative,
    lowestFeeCny: minFees.length > 0 ? money(Decimal.min(...minFees)) : null,
    highestFeeCny: maxFees.length > 0 ? money(Decimal.max(...maxFees)) : null,
    recommendations,
  };
}

/** Runs the same measurement analysis for a resolved pricing result. */
export function calculatePricingRisk(inputs: ShippingInputs, uncertainty: MeasurementUncertainty): ShippingRiskResult {
  return calculateShippingRisk(inputs, uncertainty);
}

/** Compares the saved outputs of two scenarios without mutating either snapshot. */
export function comparePricingScenarios(left: PricingScenarioSnapshot, right: PricingScenarioSnapshot): PricingScenarioComparison {
  const leftResult = left.result.mode === "target-price" ? left.result.suggestedPriceCny : left.result.estimatedProfitCny;
  const rightResult = right.result.mode === "target-price" ? right.result.suggestedPriceCny : right.result.estimatedProfitCny;
  return {
    leftId: left.id,
    rightId: right.id,
    fields: [
      { key: "weight", label: "重量", left: `${left.inputs.weightKg}kg`, right: `${right.inputs.weightKg}kg`, difference: `${(Number(right.inputs.weightKg) - Number(left.inputs.weightKg)).toFixed(2)}kg` },
      { key: "shipping", label: "物流费用", left: `¥${left.result.shippingCostCny}`, right: `¥${right.result.shippingCostCny}`, difference: `¥${(Number(right.result.shippingCostCny) - Number(left.result.shippingCostCny)).toFixed(2)}` },
      { key: "result", label: left.mode === "target-price" ? "建议成交价" : "预计利润", left: `¥${leftResult}`, right: `¥${rightResult}`, difference: `¥${(Number(rightResult) - Number(leftResult)).toFixed(2)}` },
      { key: "margin", label: "利润率", left: `${Number(left.result.profitRate).toFixed(2)}%`, right: `${Number(right.result.profitRate).toFixed(2)}%`, difference: `${(Number(right.result.profitRate) - Number(left.result.profitRate)).toFixed(2)}个百分点` },
      { key: "risk", label: "风险等级", left: left.risk.level, right: right.risk.level, difference: left.risk.level === right.risk.level ? "无变化" : "有变化" },
    ],
  };
}

function validateCommonPricingInputs(inputs: PricingCommonInputs): Record<string, string> {
  const errors: Record<string, string> = {};
  const fields: Array<[keyof PricingCommonInputs, string, boolean]> = [
    ["weightKg", "商品重量", true],
    ["procurementCostCny", "采购成本", false],
    ["otherCostCny", "其他成本（含礼品）", false],
  ];
  for (const [key, label, positive] of fields) {
    if (!inputs[key] || !Number.isFinite(Number(inputs[key]))) errors[key] = `请输入${label}`;
    else if (positive && decimal(inputs[key] as string).lte(0)) errors[key] = `${label}必须大于 0`;
    else if (!positive && decimal(inputs[key] as string).lt(0)) errors[key] = `${label}不能小于 0`;
  }
  if (!inputs.rubPerCny || decimal(inputs.rubPerCny).lte(0)) errors.rubPerCny = "等待有效汇率";
  for (const key of feeKeys) {
    const value = inputs.feeRates[key];
    if (!value || !Number.isFinite(Number(value)) || decimal(value).lt(0) || decimal(value).gt(100)) errors[`feeRates.${key}`] = "请输入 0～100 的比例";
  }
  return errors;
}

export function validateTargetPriceInputs(inputs: TargetPriceInputs): Record<string, string> {
  const errors = validateCommonPricingInputs(inputs);
  if (!inputs.targetProfitCny || !Number.isFinite(Number(inputs.targetProfitCny))) errors.targetProfitCny = "请输入目标利润";
  else if (decimal(inputs.targetProfitCny).lt(0)) errors.targetProfitCny = "目标利润不能小于 0";
  return errors;
}

export function validateProfitInputs(inputs: ExistingPriceInputs): Record<string, string> {
  const errors = validateCommonPricingInputs(inputs);
  if (!inputs.salePriceCny || !Number.isFinite(Number(inputs.salePriceCny))) errors.salePriceCny = "请输入平台实际成交价";
  else if (decimal(inputs.salePriceCny).lte(0)) errors.salePriceCny = "平台实际成交价必须大于 0";
  return errors;
}

export function validateShippingInputs(inputs: ShippingInputs): Record<string, string> {
  const errors: Record<string, string> = {};
  const fields: Array<[keyof ShippingInputs, string]> = [["salePriceCny", "实际成交价"], ["weightKg", "重量"], ["lengthCm", "长度"], ["widthCm", "宽度"], ["heightCm", "高度"]];
  for (const [key, label] of fields) {
    if (!inputs[key] || !Number.isFinite(Number(inputs[key])) || decimal(inputs[key] as string).lte(0)) errors[key] = `${label}必须大于 0`;
  }
  if (!inputs.rubPerCny || decimal(inputs.rubPerCny).lte(0)) errors.rubPerCny = "等待有效汇率";
  return errors;
}
