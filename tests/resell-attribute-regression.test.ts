import { describe, expect, it } from "vitest";

import { normalizeOzonAttributes } from "../src/server/selection/resell-module";
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
});
