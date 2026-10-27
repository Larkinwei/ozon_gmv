import { describe, expect, it } from "vitest";

import { dashboardCurrencySymbol, formatDashboardMoney, formatFinanceCurrencyName, formatFinanceMoney } from "./format";

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

describe("dashboard currency formatting", () => {
  it("uses the familiar currency symbols for CNY and RUB", () => {
    expect(formatDashboardMoney({ amount: "1234.56", currency: "CNY" })).toBe("¥1,234.56");
    expect(formatDashboardMoney({ amount: "1234.56", currency: "RUB" })).toBe("₽1,234.56");
    expect(dashboardCurrencySymbol("CNY")).toBe("¥");
    expect(dashboardCurrencySymbol("RUB")).toBe("₽");
  });
});
