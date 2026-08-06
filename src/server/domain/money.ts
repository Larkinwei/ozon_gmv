import Decimal from "decimal.js";

export interface MoneyProduct {
  price: string;
  quantity: number;
  currency: string;
}

/** Calculates posting GMV without converting through a binary floating-point number. */
export function calculatePostingGmv(products: MoneyProduct[]): { amount: string; currency: string } {
  if (products.length === 0) {
    return { amount: "0.00", currency: "RUB" };
  }

  const currency = products[0]?.currency ?? "RUB";
  if (products.some((product) => product.currency !== currency)) {
    throw new Error("A posting cannot contain multiple currencies");
  }

  const amount = products.reduce(
    (total, product) => total.plus(new Decimal(product.price).times(product.quantity)),
    new Decimal(0),
  );
  return { amount: amount.toFixed(2), currency };
}

/** Formats a decimal string for display without losing precision. */
export function normalizeAmount(value: string | number): string {
  return new Decimal(value).toFixed(2);
}

