import { describe, expect, it } from "vitest";

import { normalizeAccrual } from "./accrual-normalize";
import type { OzonFinanceAccrual } from "../ozon/schemas";

describe("finance accrual normalization", () => {
  it("keeps revenue and later item fees tied to the posting and SKU", () => {
    const lines = normalizeAccrual({
      accrued_category: "POSTING",
      date: "2026-05-12",
      type_id: "1",
      unit_number: "posting-1",
      posting: {
        products: [{
          sku: "sku-1",
          quantity: 2,
          commission: {
            seller_price: { amount: "1000.10", currency: "RUB" },
            sale_commission: { amount: "-150.05", currency: "RUB" },
          },
          delivery: { total_accrued: { amount: "-80.00", currency: "RUB" }, services: [] },
        }],
      },
      item_fees: { fees: [{ sku: "sku-1", fees: [{ type_id: "6", accrued: { amount: "-200.00", currency: "RUB" } }] }] },
      non_item_fee: null,
      total_amount: null,
    } as OzonFinanceAccrual, "2026-05-12", new Map([["1", "Продажа"], ["6", "Возврат"]]));

    expect(lines.map((line) => line.category)).toEqual(["revenue", "commission", "logistics", "returns"]);
    expect(lines.every((line) => line.postingNumber === "posting-1" && line.sku === "sku-1")).toBe(true);
    expect(lines[0]).toMatchObject({ amount: "1000.10", currency: "RUB", typeName: "Продажа" });
  });

  it("classifies return delivery services separately from ordinary logistics", () => {
    const lines = normalizeAccrual({
      accrued_category: "POSTING",
      date: "2026-05-12",
      type_id: "59",
      unit_number: "posting-return-1",
      posting: {
        products: [{
          sku: "sku-return",
          quantity: 1,
          commission: null,
          delivery: {
            services: [{ type_id: "59", accrued: { amount: "-90.00", currency: "RUB" } }],
          },
        }],
      },
      item_fees: null,
      non_item_fee: null,
      total_amount: null,
    } as OzonFinanceAccrual, "2026-05-12", new Map([["59", "ReturnFlowLogistic"]]));

    expect(lines[0]).toMatchObject({ category: "returns", typeId: "59", amount: "-90.00" });
  });

  it("keeps NON_ITEM and unknown types visible instead of dropping them", () => {
    const shared = normalizeAccrual({
      accrued_category: "NON_ITEM",
      date: "2026-05-13",
      type_id: "999",
      unit_number: "shared-1",
      posting: null,
      item_fees: null,
      non_item_fee: { type_id: "999", accrued: { amount: "-42.50", currency: "RUB" } },
      total_amount: null,
    } as OzonFinanceAccrual, "2026-05-13", new Map());
    const unknown = normalizeAccrual({
      accrued_category: "POSTING",
      date: "2026-05-14",
      type_id: "777",
      unit_number: "posting-2",
      posting: null,
      item_fees: null,
      non_item_fee: null,
      total_amount: { amount: "-13.25", currency: "RUB" },
    } as OzonFinanceAccrual, "2026-05-14", new Map());

    expect(shared[0]).toMatchObject({ category: "shared", postingNumber: null, sku: null, amount: "-42.50" });
    expect(unknown[0]).toMatchObject({ category: "unknown", postingNumber: "posting-2", amount: "-13.25" });
  });
});
