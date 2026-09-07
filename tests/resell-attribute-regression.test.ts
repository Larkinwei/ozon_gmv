import { describe, expect, it } from "vitest";

import { normalizeOzonAttributes, normalizeProductBarcode } from "../src/server/selection/resell-module";
import { hasPublishAttributeValue } from "../src/shared/publish-attributes";

describe("resell attribute payload regression", () => {
  it("emits each attribute ID only once when compact and Ozon-shaped keys coexist", () => {
    const payload = normalizeOzonAttributes({
      "31": "126745801",
      attribute_31: { id: 31, values: [{ dictionary_value_id: 126745801 }] },
      "72": ["742982632", "742982632"],
    }, [{ id: 31, name: "Бренд", required: true, dictionaryId: 28732849, isCollection: false, type: "", raw: {} }]);

    expect(payload.map((attribute) => attribute.id)).toEqual([31, 72]);
    expect(payload.find((attribute) => attribute.id === 31)?.values).toHaveLength(1);
    expect(payload.find((attribute) => attribute.id === 72)?.values).toHaveLength(1);
  });

  it("recognizes dictionary values as complete in the editor and preflight", () => {
    expect(hasPublishAttributeValue({ dictionary_value_id: 126745801 })).toBe(true);
    expect(hasPublishAttributeValue({ values: [{ dictionary_value_id: 126745801 }] })).toBe(true);
    expect(hasPublishAttributeValue({ values: [] })).toBe(false);
  });

  it("keeps Seller image attributes out of the product attribute payload", () => {
    const payload = normalizeOzonAttributes({
      "4194": "https://cdn.example.com/main.jpg",
      "4195": "https://cdn.example.com/sub.jpg",
      "attribute_31": { id: 31, values: [{ dictionary_value_id: 126745801 }] },
    });

    expect(payload.map((attribute) => attribute.id)).toEqual([31]);
  });

  it("keeps barcode out of generic attributes", () => {
    const payload = normalizeOzonAttributes({
      "7822": { id: 7822, values: [{ value: "4006381333931" }] },
      "31": { id: 31, values: [{ dictionary_value_id: 126745801 }] },
    });

    expect(payload.map((attribute) => attribute.id)).toEqual([31]);
  });

  it("accepts real GTIN check digits and rejects synthetic OZN barcodes", () => {
    expect(normalizeProductBarcode("4006381333931")).toBe("4006381333931");
    expect(normalizeProductBarcode("OZN2084612101")).toBeNull();
    expect(normalizeProductBarcode("4006381333932")).toBeNull();
  });
});
