import { describe, expect, it } from "vitest";

import { parseCbrCnyRate } from "./exchange-rate-service";

describe("CBR exchange-rate parser", () => {
  it("reads the CNY node instead of the preceding currency", () => {
    const xml = `<ValCurs Date="21.09.2026"><Valute><NumCode>840</NumCode><Nominal>1</Nominal><Value>80,00</Value></Valute><Valute><NumCode>156</NumCode><Nominal>1</Nominal><Value>11,25</Value></Valute></ValCurs>`;
    const result = parseCbrCnyRate(xml, "2026-09-21T00:00:00.000Z");
    expect(result.rate).toBe("11.25");
    expect(result.effectiveDate).toBe("2026-09-21");
  });
});
