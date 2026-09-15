import { describe, expect, it } from "vitest";

import { formatFinanceCurrencyName, formatFinanceMoney } from "./format";

describe("finance currency formatting", () => {
  it("uses compact symbols for supported settlement currencies", () => {
    expect(formatFinanceMoney({ amount: "1234.56", currency: "CNY" })).toBe("¥1,234.56");
    expect(formatFinanceMoney({ amount: "1234.56", currency: "RUB" })).toBe("₽1,234.56");
  });

  it("uses readable Chinese currency names in finance summaries", () => {
    expect(formatFinanceCurrencyName("CNY")).toBe("人民币");
    expect(formatFinanceCurrencyName("RUB")).toBe("俄罗斯卢布");
    expect(formatFinanceCurrencyName("EUR")).toBe("EUR");
  });
});
