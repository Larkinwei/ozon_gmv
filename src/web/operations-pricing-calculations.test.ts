import { describe, expect, it } from "vitest";

import {
  calculateProfitAtSalePrice,
  calculateShippingRisk,
  calculateShipping,
  calculateTargetPrice,
  defaultPricingFeeRates,
  validateTargetPriceInputs,
} from "./operations-pricing-calculations";

const normalUncertainty = { enabled: true as const, preset: "normal" as const, weightPercent: "10", lengthCm: "2", widthCm: "2", heightCm: "2" };

const targetSample = {
  weightKg: "2.5",
  procurementCostCny: "54.21",
  otherCostCny: "0",
  targetProfitCny: "55",
  feeRates: defaultPricingFeeRates,
  rubPerCny: "10",
};

describe("Ozon rFBS pricing calculations", () => {
  it("matches the supplied pricing workbook sample with a stable shipping band", () => {
    const result = calculateTargetPrice(targetSample);
    expect(result?.status).toBe("stable");
    expect(result?.suggestedPriceRub).toBe("2955.09");
    expect(result?.shippingCostCny).toBe("88.19");
    expect(Number(result?.suggestedPriceCny)).toBeCloseTo(295.508982, 5);
    expect(Number(result?.profitRate)).toBeCloseTo(18.6119, 3);
    expect(Number(result?.originalPriceCny)).toBeCloseTo(591.017964, 5);
  });

  it("calculates profit from an existing platform transaction price", () => {
    const result = calculateProfitAtSalePrice({ salePriceCny: "160", ...targetSample });
    expect(result?.mode).toBe("existing-price");
    expect(result?.actualSalePriceRub).toBe("1600.00");
    expect(result?.shippingCostCny).toBe("88.19");
    expect(result?.estimatedProfitCny).toBe("-35.52");
  });

  it("uses complete package dimensions in the main pricing result", () => {
    const compact = calculateTargetPrice({ ...targetSample, lengthCm: "30", widthCm: "20", heightCm: "10" });
    const bulky = calculateTargetPrice({ ...targetSample, lengthCm: "10", widthCm: "100", heightCm: "100" });
    expect(compact?.shippingCostCny).toBe("88.19");
    expect(bulky?.shippingCostCny).not.toBe(compact?.shippingCostCny);
    expect(bulky?.shippingChannel).toContain("大件");
    expect(bulky?.suggestedPriceCny).not.toBe(compact?.suggestedPriceCny);
  });

  it("matches the CEL Extra Small and HK sample channels", () => {
    const result = calculateShipping({ salePriceCny: "150", weightKg: "0.5", lengthCm: "10", widthCm: "10", heightCm: "10", rubPerCny: "10" });
    const fees = Object.fromEntries(result.channels.map((channel) => [channel.id, channel.feeCny]));
    expect(result.salePriceRub).toBe("1500.00");
    expect(fees["extra-small-express"]).toBe("28.62");
    expect(fees["extra-small-standard"]).toBe("23.02");
    expect(fees["extra-small-economy"]).toBe("17.42");
    expect(fees["hk-express"]).toBe("67.00");
  });

  it("reports invalid proportions instead of calculating a meaningless price", () => {
    const inputs = { ...targetSample, feeRates: { ...defaultPricingFeeRates, commission: "100" } };
    expect(validateTargetPriceInputs(inputs)).toEqual({});
    expect(calculateTargetPrice(inputs)).toBeNull();
  });

  it("detects a weight boundary crossing in the supplier measurement range", () => {
    const result = calculateShippingRisk({ salePriceCny: "100", weightKg: "0.48", lengthCm: "10", widthCm: "10", heightCm: "10", rubPerCny: "10" }, normalUncertainty);
    expect(result.level).toBe("high-risk");
    expect(result.factors.some((factor) => factor.key === "weight-0.5")).toBe(true);
    expect(result.recommendations).toContain("让供应商提供含包装实重");
  });

  it("detects a three-side-sum boundary crossing", () => {
    const result = calculateShippingRisk({ salePriceCny: "100", weightKg: "1", lengthCm: "59", widthCm: "50", heightCm: "39", rubPerCny: "10" }, normalUncertainty);
    expect(result.factors.some((factor) => factor.key === "sum-150")).toBe(true);
    expect(result.level).toBe("high-risk");
  });

  it("keeps the main calculation independent when risk analysis is disabled or dimensions are missing", () => {
    const disabled = calculateShippingRisk({ salePriceCny: "100", weightKg: "1", lengthCm: "", widthCm: "", heightCm: "", rubPerCny: "10" }, { ...normalUncertainty, enabled: false });
    expect(disabled.level).toBe("safe");
    expect(disabled.enabled).toBe(false);
    const missing = calculateShippingRisk({ salePriceCny: "100", weightKg: "1", lengthCm: "10", widthCm: "", heightCm: "10", rubPerCny: "10" }, normalUncertainty);
    expect(missing.hasDimensions).toBe(false);
    expect(missing.summary).toContain("未填写完整包装尺寸");
  });
});
