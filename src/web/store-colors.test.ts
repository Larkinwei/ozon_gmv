import { describe, expect, it } from "vitest";

import { pickAvailableStoreColor, STORE_COLOR_PALETTE } from "./store-colors";

describe("store colors", () => {
  it("selects an unused palette color case-insensitively", () => {
    const color = pickAvailableStoreColor(
      [STORE_COLOR_PALETTE[0].toLowerCase(), STORE_COLOR_PALETTE[1]],
      () => 0,
    );

    expect(color).toBe(STORE_COLOR_PALETTE[2]);
  });

  it("reuses the curated palette only after all colors are occupied", () => {
    const color = pickAvailableStoreColor(STORE_COLOR_PALETTE, () => 0.9999);

    expect(color).toBe(STORE_COLOR_PALETTE.at(-1));
  });
});
