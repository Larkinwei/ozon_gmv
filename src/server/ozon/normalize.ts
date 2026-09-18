import type { FulfillmentMode } from "../../shared/contracts";
import { calculatePostingGmv, normalizeAmount, type MoneyProduct } from "../domain/money";
import type { OzonPosting } from "./schemas";

export interface NormalizedPostingItem {
  sku: string;
  offerId: string;
  name: string;
  quantity: number;
  unitPrice: string;
  currency: string;
}

export interface NormalizedPosting {
  postingNumber: string;
  orderNumber: string;
  fulfillmentMode: FulfillmentMode;
  orderAt: Date;
  shipmentAt?: Date | null;
  shipmentTimeSource?: "delivering_date" | "in_process_at" | "missing";
  status: string;
  substatus: string | null;
  grossAmount: string;
  currency: string;
  cancelledAt: Date | null;
  items: NormalizedPostingItem[];
}

function getPrice(product: OzonPosting["products"][number]): MoneyProduct {
  if (typeof product.price === "object") {
    return {
      price: product.price.amount,
      quantity: product.quantity,
      currency: product.price.currency,
    };
  }
  return {
    price: String(product.price),
    quantity: product.quantity,
    currency: product.currency_code ?? "RUB",
  };
}

function resolveFulfillment(posting: OzonPosting, source: "FBO" | "FBS"): FulfillmentMode {
  if (source === "FBO") {
    return "FBO";
  }
  return posting.delivery_schema?.toUpperCase().includes("RFBS") ? "RFBS" : "FBS";
}

function resolveShipmentTime(posting: OzonPosting, source: "FBO" | "FBS"): {
  value: string | null;
  source: "delivering_date" | "in_process_at" | "missing";
} {
  if (source === "FBS" && posting.delivering_date) {
    return { value: posting.delivering_date, source: "delivering_date" };
  }
  if (posting.in_process_at) {
    return { value: posting.in_process_at, source: "in_process_at" };
  }
  return { value: null, source: "missing" };
}

/** Drops all buyer fields and converts an Ozon response into the persistence contract. */
export function normalizePosting(posting: OzonPosting, source: "FBO" | "FBS", observedAt = new Date()): NormalizedPosting {
  const orderAtValue = source === "FBO" ? posting.created_at ?? posting.in_process_at : posting.in_process_at;
  if (!orderAtValue) {
    throw new Error(`Posting ${posting.posting_number} has no order timestamp`);
  }

  const pricedProducts = posting.products.map(getPrice);
  const total = calculatePostingGmv(pricedProducts);
  const items = posting.products.map((product, index) => {
    const price = pricedProducts[index] as MoneyProduct;
    return {
      sku: String(product.sku),
      offerId: product.offer_id,
      name: product.name,
      quantity: product.quantity,
      unitPrice: normalizeAmount(price.price),
      currency: price.currency,
    };
  });
  const cancelled = posting.status.toLowerCase().includes("cancel");
  const shipmentTime = resolveShipmentTime(posting, source);

  return {
    postingNumber: posting.posting_number,
    orderNumber: posting.order_number,
    fulfillmentMode: resolveFulfillment(posting, source),
    orderAt: new Date(orderAtValue),
    shipmentAt: shipmentTime.value ? new Date(shipmentTime.value) : null,
    shipmentTimeSource: shipmentTime.source,
    status: posting.status,
    substatus: posting.substatus ?? null,
    grossAmount: total.amount,
    currency: total.currency,
    cancelledAt: cancelled ? observedAt : null,
    items,
  };
}
