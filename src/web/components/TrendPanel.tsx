import Decimal from "decimal.js";
import { RotateCcw, Table2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BarShapeProps } from "recharts";

import type { StoreTimeSeriesValue, TimeSeriesPoint } from "../../shared/contracts";
import { formatCompactNumber, formatMoney, formatMoneyList } from "../format";

interface StoreDescriptor {
  id: string;
  name: string;
  color: string;
  totalOrders: number;
  totalGmv: number;
}

interface StoreChartValue {
  id: string;
  name: string;
  color: string;
  orders: number;
  gmv: number;
}

interface ChartDatum {
  bucket: string;
  label: string;
  orders: number;
  gmv: number;
  storeGmv: Record<string, number>;
  stores: StoreChartValue[];
}

interface ActiveBucket {
  index: number;
  mode: "keyboard" | "pointer" | "touch";
}

interface LineVisibilitySelection {
  scopeKey: string;
  storeIds: Set<string>;
}

interface UnifiedStoreRow {
  id: string;
  name: string;
  color: string;
  orders: number;
  gmv: number;
  storeCount: number;
}

interface UnifiedTrendDetailProps {
  datum: ChartDatum;
  currency: string;
  placement: "left" | "right";
  announce: boolean;
}

const LINE_COLLAPSE_THRESHOLD = 6;
const DEFAULT_STORE_LINE_LIMIT = 5;
const TOOLTIP_STORE_LIMIT = 6;

function moneyAmount(values: StoreTimeSeriesValue["gmv"], currency: string): number {
  return Number(values.find((value) => value.currency === currency)?.amount ?? 0);
}

function toChartData(points: TimeSeriesPoint[], currency: string): ChartDatum[] {
  return points.map((point) => {
    const stores = point.stores.map((store) => ({
      id: store.storeId,
      name: store.storeName,
      color: store.color,
      orders: store.orders,
      gmv: moneyAmount(store.gmv, currency),
    }));
    return {
      bucket: point.bucket,
      label: point.label,
      orders: point.orders,
      gmv: Number(point.gmv.find((value) => value.currency === currency)?.amount ?? 0),
      storeGmv: Object.fromEntries(stores.map((store) => [store.id, store.gmv])),
      stores,
    };
  });
}

function collectStores(points: TimeSeriesPoint[], currency: string): StoreDescriptor[] {
  const stores = new Map<string, StoreDescriptor>();
  for (const point of points) {
    for (const store of point.stores) {
      const existing = stores.get(store.storeId) ?? {
        id: store.storeId,
        name: store.storeName,
        color: store.color,
        totalOrders: 0,
        totalGmv: 0,
      };
      existing.totalOrders += store.orders;
      existing.totalGmv += moneyAmount(store.gmv, currency);
      stores.set(store.storeId, existing);
    }
  }
  return [...stores.values()].sort((left, right) => {
    if (right.totalGmv !== left.totalGmv) {
      return right.totalGmv - left.totalGmv;
    }
    return right.totalOrders - left.totalOrders;
  });
}

/** Builds a compact cross-chart detail while preserving exact totals for hidden rows. */
function buildUnifiedStoreRows(datum: ChartDatum): UnifiedStoreRow[] {
  const sortedRows = datum.stores
    .filter((store) => store.orders > 0 || store.gmv > 0)
    .sort((left, right) => {
      if (right.gmv !== left.gmv) {
        return right.gmv - left.gmv;
      }
      return right.orders - left.orders;
    });
  const visibleRows = sortedRows.slice(0, TOOLTIP_STORE_LIMIT).map((store) => ({
    ...store,
    storeCount: 1,
  }));
  const hiddenRows = sortedRows.slice(TOOLTIP_STORE_LIMIT);
  if (hiddenRows.length === 0) {
    return visibleRows;
  }

  const hiddenGmv = hiddenRows.reduce((sum, store) => sum.plus(store.gmv), new Decimal(0));
  return [
    ...visibleRows,
    {
      id: "other-stores",
      name: `其他 ${hiddenRows.length} 家`,
      color: "#64748B",
      orders: hiddenRows.reduce((sum, store) => sum + store.orders, 0),
      gmv: hiddenGmv.toNumber(),
      storeCount: hiddenRows.length,
    },
  ];
}

/** Keeps columns slender as the selected time range contains more buckets. */
function getMaximumBarSize(pointCount: number): number {
  return Math.max(6, Math.min(12, Math.floor(300 / Math.max(pointCount, 1))));
}

interface OrderStackShapeProps extends BarShapeProps {
  clipIdPrefix: string;
  cornerRadius: number;
  storeOrder: StoreDescriptor[];
}

/** Draws one clipped column so every store segment shares the same pixel bounds. */
function OrderStackShape({
  x,
  y,
  width,
  height,
  index,
  payload,
  clipIdPrefix,
  cornerRadius,
  storeOrder,
}: OrderStackShapeProps): React.JSX.Element | null {
  const datum = payload as ChartDatum | undefined;
  if (!datum || datum.orders <= 0 || width <= 0 || height === 0) {
    return null;
  }

  const segmentByStoreId = new Map(datum.stores.map((store) => [store.id, store]));
  const segments = storeOrder
    .map((store) => segmentByStoreId.get(store.id))
    .filter((store): store is StoreChartValue => Boolean(store && store.orders > 0));
  const totalOrders = segments.reduce((sum, store) => sum + store.orders, 0);
  if (totalOrders === 0) {
    return null;
  }

  const columnX = Math.round(x);
  const columnWidth = Math.max(1, Math.round(x + width) - columnX);
  const columnTop = Math.round(Math.min(y, y + height));
  const columnBottom = Math.round(Math.max(y, y + height));
  const columnHeight = Math.max(1, columnBottom - columnTop);
  const clipId = `${clipIdPrefix}-${index}`;

  // 最大余数法：先按订单占比向下取整分配像素，再把剩余像素按小数部分从大到小逐段补偿。
  // 这样取整误差均匀摊到各色块，而不是全部累积到顶部色块，避免顶部占比失真、衔接不自然。
  const idealHeights = segments.map((store) => (columnHeight * store.orders) / totalOrders);
  const segmentHeights = idealHeights.map((value) => Math.floor(value));
  let remainingPixels = columnHeight - segmentHeights.reduce((sum, value) => sum + value, 0);
  const fractionalParts = idealHeights
    .map((value, segmentIndex) => ({ segmentIndex, fraction: value - (segmentHeights[segmentIndex] ?? 0) }))
    .sort((left, right) => right.fraction - left.fraction);
  for (let offset = 0; offset < remainingPixels; offset += 1) {
    const target = fractionalParts[offset % fractionalParts.length];
    if (target) {
      segmentHeights[target.segmentIndex] = (segmentHeights[target.segmentIndex] ?? 0) + 1;
    }
  }

  // 从柱底向上堆叠，相邻色块共享取整后的边界，杜绝亚像素缝隙；
  // 每个色块不透明渲染，避免矮色块因半透明叠加而发虚、发暗。
  let segmentTop = columnBottom;
  const stackedSegments = segments.map((store, segmentIndex) => {
    const segmentHeight = Math.max(0, segmentHeights[segmentIndex] ?? 0);
    segmentTop -= segmentHeight;
    return { store, segmentTop, segmentHeight };
  });

  return (
    <g data-order-stack={datum.bucket}>
      <defs>
        <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
          <rect x={columnX} y={columnTop} width={columnWidth} height={columnHeight} rx={cornerRadius} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {stackedSegments.map(({ store, segmentTop: y, segmentHeight: height }) =>
          height > 0 ? (
            <rect
              data-store-segment={store.id}
              x={columnX}
              y={y}
              width={columnWidth}
              height={height}
              fill={store.color}
              key={store.id}
            />
          ) : null,
        )}
      </g>
    </g>
  );
}

function UnifiedTrendDetail({
  datum,
  currency,
  placement,
  announce,
}: UnifiedTrendDetailProps): React.JSX.Element {
  const rows = buildUnifiedStoreRows(datum);
  return (
    <div
      className={`chart-tooltip chart-tooltip--${placement}`}
      data-testid="trend-detail"
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : "off"}
      aria-atomic={announce ? "true" : undefined}
    >
      <p className="chart-tooltip__label">{datum.label}</p>
      <div className="chart-tooltip__totals">
        <div>
          <span>总 GMV</span>
          <strong>{formatMoney({ amount: String(datum.gmv), currency })}</strong>
        </div>
        <div>
          <span>总订单</span>
          <strong>{datum.orders} 单</strong>
        </div>
      </div>
      {rows.length > 0 ? (
        <div className="chart-tooltip__stores">
          <div className="chart-tooltip__columns" aria-hidden="true">
            <span>店铺</span>
            <span>GMV</span>
            <span>订单</span>
          </div>
          <ul className="chart-tooltip__list" aria-label="当前时间段店铺明细">
            {rows.map((row) => (
              <li data-other-store-count={row.storeCount > 1 ? row.storeCount : undefined} key={row.id}>
                <span className="chart-tooltip__store" title={row.name}>
                  <span className="chart-color-dot" style={{ backgroundColor: row.color }} aria-hidden="true" />
                  <span>{row.name}</span>
                </span>
                <strong>{formatMoney({ amount: String(row.gmv), currency })}</strong>
                <span>{row.orders} 单</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="chart-tooltip__empty">该时间段暂无订单</p>
      )}
    </div>
  );
}

export function TrendPanel({ points }: { points: TimeSeriesPoint[] }): React.JSX.Element {
  const orderStackClipPrefix = useId().replaceAll(":", "");
  const [showTable, setShowTable] = useState(false);
  const [lineVisibility, setLineVisibility] = useState<LineVisibilitySelection | null>(null);
  const [emphasizedStoreId, setEmphasizedStoreId] = useState<string | null>(null);
  const [activeBucket, setActiveBucket] = useState<ActiveBucket | null>(null);
  const currencies = useMemo(
    () => [...new Set(points.flatMap((point) => point.gmv.map((value) => value.currency)))],
    [points],
  );
  const [currency, setCurrency] = useState(currencies[0] ?? "RUB");
  useEffect(() => {
    const firstCurrency = currencies[0];
    if (firstCurrency && !currencies.includes(currency)) {
      setCurrency(firstCurrency);
    }
  }, [currencies, currency]);

  const data = useMemo(() => toChartData(points, currency), [points, currency]);
  const stores = useMemo(() => collectStores(points, currency), [points, currency]);
  const automaticVisibleStoreIds = useMemo(() => {
    const lineLimit = stores.length > LINE_COLLAPSE_THRESHOLD ? DEFAULT_STORE_LINE_LIMIT : stores.length;
    return new Set(stores.slice(0, lineLimit).map((store) => store.id));
  }, [stores]);
  const storeScope = stores.map((store) => store.id).sort().join(",");
  const firstBucket = data[0]?.bucket ?? "";
  const lastBucket = data.at(-1)?.bucket ?? "";
  const visibilityScopeKey = `${currency}:${firstBucket}:${lastBucket}:${storeScope}`;
  const visibleStoreIds = lineVisibility?.scopeKey === visibilityScopeKey
    ? lineVisibility.storeIds
    : automaticVisibleStoreIds;
  const visibleStores = stores.filter((store) => visibleStoreIds.has(store.id));
  const hiddenStoreCount = stores.length - visibleStores.length;
  const showTotalLine = stores.length > 1;
  const totalGmv = points.reduce((sum, point) => {
    const amount = point.gmv.find((value) => value.currency === currency)?.amount ?? "0";
    return sum.plus(amount);
  }, new Decimal(0));
  const peak = data.reduce<ChartDatum | null>((current, item) => (!current || item.gmv > current.gmv ? item : current), null);
  const maximumBarSize = getMaximumBarSize(data.length);
  const stackCornerRadius = data.length >= 14 ? 0 : 2;
  const activeDatum = activeBucket === null ? null : data[activeBucket.index] ?? null;
  const detailPlacement = activeBucket && activeBucket.index >= data.length / 2 ? "left" : "right";

  function toggleStore(storeId: string): void {
    const nextStoreIds = new Set(visibleStoreIds);
    if (nextStoreIds.has(storeId)) {
      nextStoreIds.delete(storeId);
    } else {
      nextStoreIds.add(storeId);
    }
    setLineVisibility({ scopeKey: visibilityScopeKey, storeIds: nextStoreIds });
  }

  function showAllStoreLines(): void {
    setLineVisibility({
      scopeKey: visibilityScopeKey,
      storeIds: new Set(stores.map((store) => store.id)),
    });
  }

  function updateActiveBucket(rawIndex: number | string | null | undefined, mode: ActiveBucket["mode"]): void {
    const index = Number(rawIndex);
    if (Number.isInteger(index) && index >= 0 && index < data.length) {
      setActiveBucket({ index, mode });
    }
  }

  function clearPointerBucket(): void {
    setActiveBucket((current) => {
      if (current?.mode === "pointer") {
        return null;
      }
      return current;
    });
  }

  function handleChartKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      setActiveBucket(null);
      return;
    }
    if (data.length === 0) {
      return;
    }
    let nextIndex = activeBucket?.index ?? data.length - 1;
    if (event.key === "ArrowLeft") {
      nextIndex = Math.max(0, nextIndex - 1);
    } else if (event.key === "ArrowRight") {
      nextIndex = Math.min(data.length - 1, nextIndex + 1);
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = data.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    setActiveBucket({ index: nextIndex, mode: "keyboard" });
  }

  function handleLegendBlur(event: React.FocusEvent<HTMLButtonElement>, storeId: string): void {
    if (emphasizedStoreId === storeId && !event.currentTarget.matches(":hover")) {
      setEmphasizedStoreId(null);
    }
  }

  function handleChartBlur(event: React.FocusEvent<HTMLDivElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setActiveBucket((current) => {
        if (current?.mode === "keyboard") {
          return null;
        }
        return current;
      });
    }
  }

  return (
    <section className="panel trend-panel" aria-labelledby="trend-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">ORDER MOMENTUM</p>
          <h2 id="trend-title">GMV 与订单趋势</h2>
          <p className="chart-summary">
            共 {formatMoney({ amount: totalGmv.toFixed(2), currency })}，峰值出现在 {peak?.label ?? "—"}。
          </p>
        </div>
        <div className="chart-actions">
          {currencies.length > 1 && (
            <label className="currency-filter">
              <span className="sr-only">图表币种</span>
              <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
                {currencies.map((item) => <option value={item} key={item}>{item}</option>)}
              </select>
            </label>
          )}
          <button className="secondary-button compact-button" type="button" onClick={() => setShowTable((value) => !value)} aria-expanded={showTable}>
            <Table2 size={17} aria-hidden="true" /> {showTable ? "返回图表" : "数据表"}
          </button>
        </div>
      </div>

      {!showTable && stores.length > 0 && (
        <div className="chart-legend" aria-label="GMV 折线图例">
          {showTotalLine && (
            <span className="chart-legend__total">
              <span className="chart-legend__line" aria-hidden="true" />
              总计
            </span>
          )}
          {stores.map((store) => {
            const visible = visibleStoreIds.has(store.id);
            if (!showTotalLine) {
              return (
                <span className="chart-legend__single" key={store.id}>
                  <span className="chart-color-dot" style={{ backgroundColor: store.color }} aria-hidden="true" />
                  {store.name}
                </span>
              );
            }
            return (
              <button
                className={`chart-legend__button${visible ? "" : " is-hidden"}`}
                type="button"
                key={store.id}
                aria-pressed={visible}
                onBlur={(event) => handleLegendBlur(event, store.id)}
                onClick={() => toggleStore(store.id)}
                onFocus={() => setEmphasizedStoreId(store.id)}
                onMouseEnter={() => setEmphasizedStoreId(store.id)}
                onMouseLeave={(event) => {
                  if (!event.currentTarget.matches(":focus")) {
                    setEmphasizedStoreId(null);
                  }
                }}
              >
                <span className="chart-color-dot" style={{ backgroundColor: store.color }} aria-hidden="true" />
                {store.name}
              </button>
            );
          })}
          {hiddenStoreCount > 0 && (
            <button className="chart-legend__reset" type="button" onClick={showAllStoreLines}>
              <RotateCcw size={14} aria-hidden="true" /> 显示全部
            </button>
          )}
        </div>
      )}

      {showTable ? (
        <div className="table-scroll">
          <table>
            <caption className="sr-only">按时间和店铺拆分的 GMV 与订单趋势数据</caption>
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">店铺</th>
                <th scope="col">订单</th>
                <th scope="col">GMV</th>
              </tr>
            </thead>
            <tbody>
              {points.flatMap((point) => point.stores.map((store) => (
                <tr key={`${point.bucket}:${store.storeId}`}>
                  <td>{point.label}</td>
                  <td>
                    <span className="chart-table-store">
                      <span className="chart-color-dot" style={{ backgroundColor: store.color }} aria-hidden="true" />
                      {store.storeName}
                    </span>
                  </td>
                  <td>{store.orders}</td>
                  <td>{formatMoneyList(store.gmv)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      ) : data.length === 0 ? (
        <div className="empty-state">所选时间段暂无订单趋势</div>
      ) : (
        <div
          className="charts"
          role="group"
          tabIndex={0}
          aria-label="GMV 折线图及订单量堆叠柱状图。使用左右方向键查看相邻时间段。"
          onBlur={handleChartBlur}
          onFocus={() => setActiveBucket((current) => ({
            index: current?.index ?? data.length - 1,
            mode: "keyboard",
          }))}
          onKeyDown={handleChartKeyDown}
          onMouseLeave={clearPointerBucket}
        >
          {activeDatum && (
            <UnifiedTrendDetail
              datum={activeDatum}
              currency={currency}
              placement={detailPlacement}
              announce={activeBucket?.mode === "keyboard"}
            />
          )}
          <div className="gmv-chart" aria-label={`${currency} GMV 趋势`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={data}
                margin={{ top: 12, right: 8, left: 4, bottom: 0 }}
                syncId="store-trend"
                onMouseMove={(state) => {
                  if (state.isTooltipActive) {
                    updateActiveBucket(state.activeTooltipIndex, "pointer");
                  }
                }}
                onTouchMove={(state) => updateActiveBucket(state.activeTooltipIndex, "touch")}
                onTouchStart={(state) => updateActiveBucket(state.activeTooltipIndex, "touch")}
              >
                <CartesianGrid stroke="#243047" strokeDasharray="3 6" vertical={false} />
                <XAxis dataKey="label" stroke="#64748B" tickLine={false} axisLine={false} minTickGap={28} />
                <YAxis
                  stroke="#64748B"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={formatCompactNumber}
                  width={52}
                  domain={[0, (dataMax: number) => Math.max(1, Math.ceil(dataMax * 1.15))]}
                />
                <Tooltip cursor={false} content={() => null} />
                {activeDatum && <ReferenceLine x={activeDatum.label} stroke="#38BDF8" strokeDasharray="3 4" />}
                {showTotalLine && (
                  <Line
                    type="linear"
                    dataKey="gmv"
                    name="全部店铺"
                    stroke="#F8FAFC"
                    strokeOpacity={emphasizedStoreId ? 0.58 : 1}
                    strokeWidth={3}
                    dot={false}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                )}
                {visibleStores.map((store) => (
                  <Line
                    type="linear"
                    dataKey={`storeGmv.${store.id}`}
                    name={store.name}
                    stroke={store.color}
                    strokeOpacity={emphasizedStoreId ? (emphasizedStoreId === store.id ? 1 : 0.2) : 0.82}
                    strokeWidth={emphasizedStoreId === store.id ? 2.5 : 1.5}
                    dot={false}
                    activeDot={{ r: 3 }}
                    isAnimationActive={false}
                    key={store.id}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="orders-chart" aria-label="各店铺订单量堆叠趋势">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                margin={{ top: 0, right: 8, left: 4, bottom: 0 }}
                syncId="store-trend"
                onMouseMove={(state) => {
                  if (state.isTooltipActive) {
                    updateActiveBucket(state.activeTooltipIndex, "pointer");
                  }
                }}
                onTouchMove={(state) => updateActiveBucket(state.activeTooltipIndex, "touch")}
                onTouchStart={(state) => updateActiveBucket(state.activeTooltipIndex, "touch")}
              >
                <CartesianGrid stroke="#1E293B" strokeDasharray="3 6" vertical={false} />
                <XAxis dataKey="label" hide />
                <YAxis
                  stroke="#64748B"
                  tickLine={false}
                  axisLine={false}
                  width={52}
                  allowDecimals={false}
                  domain={[0, (dataMax: number) => Math.max(1, Math.ceil(dataMax * 1.15))]}
                />
                <Tooltip cursor={{ fill: "rgba(56, 189, 248, 0.055)" }} content={() => null} />
                <Bar
                  dataKey="orders"
                  name="总订单"
                  fill="transparent"
                  maxBarSize={maximumBarSize}
                  isAnimationActive={false}
                  shape={(shapeProps: BarShapeProps) => (
                    <OrderStackShape
                      {...shapeProps}
                      clipIdPrefix={orderStackClipPrefix}
                      cornerRadius={stackCornerRadius}
                      storeOrder={stores}
                    />
                  )}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </section>
  );
}
