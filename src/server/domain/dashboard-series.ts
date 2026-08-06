import { addDays, addHours, addMinutes, startOfDay, startOfHour } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import Decimal from "decimal.js";

import type { TimeSeriesPoint } from "../../shared/contracts";
import { DASHBOARD_TIMEZONE, formatBucketLabel, type DashboardWindow } from "./time-range";

export interface DashboardSeriesRow {
  bucket: Date;
  storeId: string;
  storeName: string;
  storeColor: string;
  currency: string;
  orders: number;
  gmv: string;
}

interface AggregatedSeriesRow {
  orders: number;
  gmv: Decimal;
}

interface SeriesStore {
  id: string;
  name: string;
  color: string;
}

function floorToBucket(date: Date, granularity: DashboardWindow["granularity"]): Date {
  const zonedDate = toZonedTime(date, DASHBOARD_TIMEZONE);
  if (granularity === "day") {
    return fromZonedTime(startOfDay(zonedDate), DASHBOARD_TIMEZONE);
  }
  if (granularity === "hour") {
    return fromZonedTime(startOfHour(zonedDate), DASHBOARD_TIMEZONE);
  }
  zonedDate.setMinutes(Math.floor(zonedDate.getMinutes() / 15) * 15, 0, 0);
  return fromZonedTime(zonedDate, DASHBOARD_TIMEZONE);
}

function nextBucket(date: Date, granularity: DashboardWindow["granularity"]): Date {
  if (granularity === "day") {
    return addDays(date, 1);
  }
  if (granularity === "hour") {
    return addHours(date, 1);
  }
  return addMinutes(date, 15);
}

function seriesRowKey(bucket: string, storeId: string, currency: string): string {
  return `${bucket}:${storeId}:${currency}`;
}

/** Builds a continuous chart series so empty time buckets remain visible as zero values. */
export function buildDashboardSeries(
  rows: DashboardSeriesRow[],
  window: DashboardWindow,
): TimeSeriesPoint[] {
  if (rows.length === 0) {
    return [];
  }

  const currencies = [...new Set(rows.map((row) => row.currency))].sort();
  const storesById = new Map<string, SeriesStore>();
  const rowsBySeriesKey = new Map<string, AggregatedSeriesRow>();
  for (const row of rows) {
    storesById.set(row.storeId, {
      id: row.storeId,
      name: row.storeName,
      color: row.storeColor,
    });
    const key = seriesRowKey(row.bucket.toISOString(), row.storeId, row.currency);
    const existing = rowsBySeriesKey.get(key) ?? { orders: 0, gmv: new Decimal(0) };
    existing.orders += row.orders;
    existing.gmv = existing.gmv.plus(row.gmv);
    rowsBySeriesKey.set(key, existing);
  }
  const stores = [...storesById.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const series: TimeSeriesPoint[] = [];

  for (
    let bucket = floorToBucket(window.from, window.granularity);
    bucket < window.to;
    bucket = nextBucket(bucket, window.granularity)
  ) {
    const bucketKey = bucket.toISOString();
    const storeValues = stores.map((store) => {
      const storeRows = currencies.map((currency) => rowsBySeriesKey.get(seriesRowKey(bucketKey, store.id, currency)));
      return {
        storeId: store.id,
        storeName: store.name,
        color: store.color,
        orders: storeRows.reduce((sum, row) => sum + (row?.orders ?? 0), 0),
        gmv: currencies.map((currency, index) => ({
          amount: storeRows[index]?.gmv.toFixed(2) ?? "0.00",
          currency,
        })),
      };
    });
    series.push({
      bucket: bucketKey,
      label: formatBucketLabel(bucket, window.granularity),
      orders: storeValues.reduce((sum, store) => sum + store.orders, 0),
      gmv: currencies.map((currency) => ({
        amount: storeValues
          .reduce((sum, store) => {
            const value = store.gmv.find((money) => money.currency === currency)?.amount ?? "0";
            return sum.plus(value);
          }, new Decimal(0))
          .toFixed(2),
        currency,
      })),
      stores: storeValues,
    });
  }

  return series;
}
