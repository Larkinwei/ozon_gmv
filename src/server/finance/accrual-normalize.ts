import Decimal from "decimal.js";

import type { FinanceCategory } from "../../shared/contracts";
import type { OzonFinanceAccrual } from "../ozon/schemas";

export interface NormalizedFinanceLine {
  sourceKey: string;
  sourceDate: string;
  accrualDate: string;
  accruedCategory: string;
  unitNumber: string;
  postingNumber: string | null;
  sku: string | null;
  typeId: string | null;
  typeName: string | null;
  category: FinanceCategory;
  amount: string;
  currency: string;
  quantity: number | null;
  sellerPrice: string | null;
  rawJson: string;
}

const logisticsTypes = new Set(["29", "32", "98"]);
const promotionTypes = new Set(["12", "41", "46", "48", "54", "77", "78", "84", "96"]);
const returnTypes = new Set(["6", "45", "59"]);
const otherDirectTypes = new Set(["1", "10", "25"]);

function validMoney(value: { amount: string; currency: string } | null | undefined): boolean {
  if (!value || !value.currency || value.currency.length !== 3) {
    return false;
  }
  try {
    return new Decimal(value.amount).isFinite();
  } catch {
    return false;
  }
}

function categoryFor(typeId: string | null, section: "delivery" | "item" | "non_item" | "fallback"): FinanceCategory {
  if (section === "non_item") {
    return "shared";
  }
  if (section === "fallback") {
    return "unknown";
  }
  if (typeId && returnTypes.has(typeId)) {
    return "returns";
  }
  if (section === "delivery" || (typeId && logisticsTypes.has(typeId))) {
    return "logistics";
  }
  if (typeId && promotionTypes.has(typeId)) {
    return "promotion";
  }
  if (typeId && otherDirectTypes.has(typeId)) {
    return "other_direct";
  }
  return "unknown";
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

/** Converts one by-day accrual into signed, SKU-aware lines without changing Ozon amounts. */
export function normalizeAccrual(
  accrual: OzonFinanceAccrual,
  requestedDate: string,
  typeNames: Map<string, string>,
): NormalizedFinanceLine[] {
  const sourceDate = accrual.date || requestedDate;
  const postingNumber = accrual.accrued_category === "NON_ITEM" ? null : accrual.unit_number || null;
  const rawJson = JSON.stringify(accrual);
  const lines: NormalizedFinanceLine[] = [];
  let lineIndex = 0;

  function pushLine(input: {
    amount: { amount: string; currency: string } | null | undefined;
    category: FinanceCategory;
    typeId?: string | null | undefined;
    sku?: string | null | undefined;
    quantity?: number | null | undefined;
    sellerPrice?: string | null | undefined;
  }): void {
    const amount = input.amount;
    if (!amount || !validMoney(amount)) {
      return;
    }
    const typeId = input.typeId ?? null;
    lines.push({
      sourceKey: `${sourceDate}:${accrual.unit_number}:${typeId ?? "none"}:${input.sku ?? "none"}:${input.category}:${lineIndex}`,
      sourceDate,
      accrualDate: sourceDate,
      accruedCategory: accrual.accrued_category,
      unitNumber: accrual.unit_number,
      postingNumber,
      sku: input.sku ?? null,
      typeId,
      typeName: typeId ? typeNames.get(typeId) ?? null : null,
      category: input.category,
      amount: amount.amount,
      currency: normalizeCurrency(amount.currency),
      quantity: input.quantity ?? null,
      sellerPrice: input.sellerPrice ?? null,
      rawJson,
    });
    lineIndex += 1;
  }

  for (const product of accrual.posting?.products ?? []) {
    const commission = product.commission;
    if (commission?.seller_price) {
      pushLine({
        amount: commission.seller_price,
        category: "revenue",
        typeId: accrual.type_id,
        sku: product.sku,
        quantity: product.quantity,
        sellerPrice: commission.seller_price.amount,
      });
    }
    if (commission?.sale_commission) {
      pushLine({ amount: commission.sale_commission, category: "commission", typeId: accrual.type_id, sku: product.sku, quantity: product.quantity });
    }
    const services = product.delivery?.services ?? [];
    if (services.length > 0) {
      for (const service of services) {
        pushLine({
          amount: service.accrued,
          category: categoryFor(service.type_id, "delivery"),
          typeId: service.type_id,
          sku: product.sku,
          quantity: product.quantity,
        });
      }
    } else if (product.delivery?.total_accrued) {
      pushLine({
        amount: product.delivery.total_accrued,
        category: "logistics",
        typeId: accrual.type_id,
        sku: product.sku,
        quantity: product.quantity,
      });
    }
  }

  for (const group of accrual.item_fees?.fees ?? []) {
    for (const fee of group.fees) {
      pushLine({ amount: fee.accrued, category: categoryFor(fee.type_id, "item"), typeId: fee.type_id, sku: group.sku });
    }
  }

  if (accrual.non_item_fee?.accrued) {
    pushLine({ amount: accrual.non_item_fee.accrued, category: categoryFor(accrual.non_item_fee.type_id, "non_item"), typeId: accrual.non_item_fee.type_id });
  }

  if (lines.length === 0 && accrual.total_amount) {
    pushLine({ amount: accrual.total_amount, category: categoryFor(accrual.type_id ?? null, "fallback"), typeId: accrual.type_id, sku: null });
  }

  return lines;
}

/** Supplies stable Chinese labels for the persisted category enum. */
export function financeCategoryLabel(category: FinanceCategory): string {
  switch (category) {
    case "revenue": return "成交收入";
    case "commission": return "佣金";
    case "logistics": return "物流费用";
    case "promotion": return "活动费用";
    case "returns": return "退货/拒收";
    case "other_direct": return "其他订单费用";
    case "shared": return "店铺公共费用";
    case "unknown": return "待确认费用";
  }
}
