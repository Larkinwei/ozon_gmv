import Decimal from "decimal.js";

import type { WildberriesReportRow } from "./schemas";

export interface WildberriesOrderItem {
  sku: string;
  offerId: string;
  name: string;
  quantity: number;
  unitPrice: string;
  currency: string;
}

export interface WildberriesOrder {
  externalOrderId: string;
  orderNumber: string;
  fulfillmentMode: string;
  orderAt: Date;
  status: string;
  substatus: string | null;
  grossAmount: string;
  currency: string;
  cancelledAt: Date | null;
  items: WildberriesOrderItem[];
  rawJson: string;
}

export interface WildberriesSale {
  externalSaleId: string;
  sourceOrderId: string | null;
  saleAt: Date;
  factType: "sale" | "return";
  amount: string;
  currency: string;
  sku: string;
  offerId: string;
  name: string;
  quantity: number;
  rawJson: string;
}

function text(row: WildberriesReportRow, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

function number(row: WildberriesReportRow, ...keys: string[]): Decimal {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      const parsed = new Decimal(String(value));
      if (parsed.isFinite()) return parsed;
    }
  }
  return new Decimal(0);
}

function date(row: WildberriesReportRow, ...keys: string[]): Date {
  const value = text(row, ...keys);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Wildberries report row has no valid date");
  }
  return parsed;
}

function quantity(row: WildberriesReportRow): number {
  const value = Number(text(row, "quantity", "count"));
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function money(row: WildberriesReportRow): Decimal {
  return number(row, "forPay", "finishedPrice", "retailPriceWithdiscRub", "priceWithDisc", "totalPrice");
}

function currency(row: WildberriesReportRow): string {
  return text(row, "currency", "currencyCode", "currency_code").toUpperCase() || "RUB";
}

function isCancel(row: WildberriesReportRow): boolean {
  const value = row.isCancel ?? row.is_cancel;
  return value === true || value === 1 || String(value).toLowerCase() === "true";
}

function isReturn(row: WildberriesReportRow): boolean {
  const value = row.isStorno ?? row.is_storno;
  return value === true || value === 1 || String(value).toLowerCase() === "true";
}

function rowId(row: WildberriesReportRow, index: number): string {
  const explicit = text(row, "saleID", "saleId", "srid", "odid", "gNumber");
  return explicit || `row-${index}-${text(row, "date", "lastChangeDate")}`;
}

export function normalizeWildberriesOrders(rows: WildberriesReportRow[]): WildberriesOrder[] {
  const groups = new Map<string, { rows: WildberriesReportRow[]; indexes: number[] }>();
  rows.forEach((row, index) => {
    const id = text(row, "srid", "odid", "gNumber") || `row-${index}`;
    const group = groups.get(id) ?? { rows: [], indexes: [] };
    group.rows.push(row);
    group.indexes.push(index);
    groups.set(id, group);
  });
  return [...groups.entries()].map(([externalOrderId, group]) => {
    const first = group.rows[0] as WildberriesReportRow;
    const items = group.rows.map((row) => {
      const itemQuantity = quantity(row);
      const itemAmount = money(row);
      return {
        sku: text(row, "barcode", "sku", "nmId"),
        offerId: text(row, "supplierArticle", "vendorCode"),
        name: text(row, "subject", "brand", "supplierArticle"),
        quantity: itemQuantity,
        unitPrice: itemAmount.dividedBy(itemQuantity).toFixed(2),
        currency: currency(row),
      };
    });
    const amount = group.rows.reduce((total, row) => total.plus(money(row)), new Decimal(0));
    const cancelled = group.rows.some(isCancel);
    return {
      externalOrderId,
      orderNumber: text(first, "odid", "gNumber", "srid") || externalOrderId,
      fulfillmentMode: text(first, "deliveryType", "warehouseType", "warehouseName") || "WB",
      orderAt: date(first, "date", "lastChangeDate"),
      status: cancelled ? "CANCELLED" : "ORDERED",
      substatus: null,
      grossAmount: amount.toFixed(2),
      currency: currency(first),
      cancelledAt: cancelled ? date(first, "cancelDate", "date", "lastChangeDate") : null,
      items,
      rawJson: JSON.stringify(group.rows),
    };
  });
}

export function normalizeWildberriesSales(rows: WildberriesReportRow[]): WildberriesSale[] {
  return rows.map((row, index) => {
    const amount = money(row).abs();
    const returnRecord = isReturn(row);
    return {
      externalSaleId: rowId(row, index),
      sourceOrderId: text(row, "srid", "odid", "gNumber") || null,
      saleAt: date(row, "date", "lastChangeDate"),
      factType: returnRecord ? "return" : "sale",
      amount: amount.toFixed(2),
      currency: currency(row),
      sku: text(row, "barcode", "sku", "nmId"),
      offerId: text(row, "supplierArticle", "vendorCode"),
      name: text(row, "subject", "brand", "supplierArticle"),
      quantity: quantity(row),
      rawJson: JSON.stringify(row),
    };
  });
}
