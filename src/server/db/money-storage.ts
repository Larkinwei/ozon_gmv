import Decimal from "decimal.js";

/** Converts a two-decimal monetary amount into an exact SQLite integer. */
export function amountToMinorUnits(amount: string | number): number {
  const minorUnits = new Decimal(amount).times(100);
  if (!minorUnits.isInteger()) {
    throw new Error(`Money amount has more than two decimals: ${String(amount)}`);
  }
  const value = minorUnits.toNumber();
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Money amount exceeds SQLite safe integer range: ${String(amount)}`);
  }
  return value;
}

/** Converts an exact SQLite minor-unit integer into the public decimal contract. */
export function minorUnitsToAmount(minorUnits: number): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new Error(`Stored money is outside the safe integer range: ${minorUnits}`);
  }
  return new Decimal(minorUnits).dividedBy(100).toFixed(2);
}
