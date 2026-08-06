# Dashboard override

This page overrides the generated light palette. The product is a dark-only operations dashboard.

## Tokens

- Background `#020617`, surface `#0E1628`, raised surface `#172033`, border `#334155`.
- Primary text `#F8FAFC`, secondary text `#94A3B8`.
- Data blue `#3B82F6`, live/success `#22C55E`, warning `#F59E0B`, danger `#F87171`, focus `#38BDF8`.
- Use the system sans-serif stack and `font-variant-numeric: tabular-nums` for all metrics.
- Use a 4/8px spacing scale, 12px card radius, 1px borders, and restrained shadows.

## Layout

- Desktop uses a 12-column grid. Trend charts occupy eight columns and the live feed occupies four.
- KPI cards form a four-column row. At widths below 1024px they become two columns; below 768px, one column.
- GMV uses a neutral total line plus store-colored lines; multi-store charts do not use overlapping area fills.
- With more than six stores, show the neutral total and the top five stores by range GMV by default; keep every store available in the compact interactive legend.
- Order count uses a store-colored stacked bar chart on the same time scale. Store line controls never remove order segments.
- New stores receive a random unused color from the curated 20-color categorical palette; existing stores retain an editable color. Do not generate arbitrary hex values or silently reuse a color while unused palette entries remain.
- Each order bucket uses one clipped column: all store segments share exact horizontal bounds and internal joins stay square and gapless. Dense ranges use square 6–12px columns; short ranges may use a 2px outer radius.
- Reserve at least 96px for the order plot, render normal columns at 92% opacity, and use a low-contrast hover band behind the active column. Never draw a dashed cursor through the stacked column.
- Keep the store legend in one horizontally scrollable row. Default legend items stay visually quiet and gain a surface only on hover or focus.
- The two synchronized trend charts share one combined detail card with bucket totals plus per-store GMV and orders. Show at most six stores and aggregate the remainder into one “other stores” row.
- Place the combined card on the opposite side of the active desktop bucket; on narrow screens place it below the plots. Never render one tooltip per synchronized chart.
- Show exact per-store values in the combined detail and the data table.
- Avoid dual-axis charts, decorative glow, gradients, and continuously moving marquees.

## Interaction and accessibility

- Controls are at least 44px high and all icon-only buttons have accessible labels.
- New orders enter once with a 220ms transform/opacity transition. Reduced motion removes the transition.
- Charts include a readable text summary and a table alternative.
- Loading, empty, stale, offline, and error states preserve layout size and give a recovery action.
