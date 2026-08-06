/**
 * High-contrast categorical colors for store series on the dashboard's dark surface.
 * The sequence deliberately alternates hues so adjacent stores remain distinguishable.
 */
export const STORE_COLOR_PALETTE = [
  "#3B82F6",
  "#EC4899",
  "#22D3EE",
  "#F59E0B",
  "#A78BFA",
  "#34D399",
  "#F43F5E",
  "#60A5FA",
  "#F97316",
  "#2DD4BF",
  "#C084FC",
  "#A3E635",
  "#FB7185",
  "#06B6D4",
  "#FBBF24",
  "#8B5CF6",
  "#14B8A6",
  "#F472B6",
  "#84CC16",
  "#38BDF8",
] as const;

/** Picks an unused curated color and only reuses the palette after every color is occupied. */
export function pickAvailableStoreColor(
  usedColors: Iterable<string>,
  random: () => number = Math.random,
): string {
  const used = new Set([...usedColors].map((color) => color.toUpperCase()));
  const available = STORE_COLOR_PALETTE.filter((color) => !used.has(color.toUpperCase()));
  const candidates = available.length > 0 ? available : STORE_COLOR_PALETTE;
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index] ?? STORE_COLOR_PALETTE[0];
}
