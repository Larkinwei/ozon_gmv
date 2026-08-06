import { addDays, differenceInCalendarDays, startOfDay, subDays } from "date-fns";
import { formatInTimeZone, fromZonedTime, toZonedTime } from "date-fns-tz";

import type { DashboardRange } from "../../shared/contracts";

export const DASHBOARD_TIMEZONE = "Asia/Shanghai" as const;

export interface DashboardWindow {
  from: Date;
  to: Date;
  granularity: "15m" | "hour" | "day";
}

/** Resolves a named dashboard range into an exact UTC half-open interval. */
export function resolveDashboardWindow(
  range: DashboardRange,
  now: Date,
  customFrom?: string,
  customTo?: string,
): DashboardWindow {
  const zonedNow = toZonedTime(now, DASHBOARD_TIMEZONE);
  const today = startOfDay(zonedNow);

  if (range === "today") {
    return { from: fromZonedTime(today, DASHBOARD_TIMEZONE), to: now, granularity: "15m" };
  }
  if (range === "yesterday") {
    const yesterday = subDays(today, 1);
    return {
      from: fromZonedTime(yesterday, DASHBOARD_TIMEZONE),
      to: fromZonedTime(today, DASHBOARD_TIMEZONE),
      granularity: "hour",
    };
  }
  if (range === "7d" || range === "30d") {
    const days = range === "7d" ? 7 : 30;
    return {
      from: fromZonedTime(subDays(today, days - 1), DASHBOARD_TIMEZONE),
      to: now,
      granularity: "day",
    };
  }
  if (!customFrom || !customTo) {
    throw new Error("Custom range requires both from and to");
  }

  const from = new Date(customFrom);
  const to = new Date(customTo);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
    throw new Error("Custom range is invalid");
  }

  const days = differenceInCalendarDays(toZonedTime(to, DASHBOARD_TIMEZONE), toZonedTime(from, DASHBOARD_TIMEZONE));
  let granularity: DashboardWindow["granularity"] = "15m";
  if (days >= 2) {
    granularity = "day";
  } else if (days >= 1) {
    granularity = "hour";
  }
  return { from, to, granularity };
}

/** Produces compact Beijing-time labels for chart buckets. */
export function formatBucketLabel(date: Date, granularity: DashboardWindow["granularity"]): string {
  const pattern = granularity === "day" ? "MM-dd" : "HH:mm";
  return formatInTimeZone(date, DASHBOARD_TIMEZONE, pattern);
}

/** Splits long backfills into stable seven-day API windows. */
export function splitIntoSyncWindows(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const windows: Array<{ from: Date; to: Date }> = [];
  let cursor = from;
  while (cursor < to) {
    const end = addDays(cursor, 7);
    const windowEnd = end < to ? end : to;
    windows.push({ from: cursor, to: windowEnd });
    cursor = windowEnd;
  }
  return windows;
}
