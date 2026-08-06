import { formatInTimeZone } from "date-fns-tz";

import type { Money, SyncHealth } from "../shared/contracts";

export function formatMoney(value: Money): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: value.currency,
    maximumFractionDigits: 2,
  }).format(Number(value.amount));
}

export function formatMoneyList(values: Money[]): string {
  return values.length > 0 ? values.map(formatMoney).join(" · ") : "—";
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatBeijingTime(value: string | Date, pattern = "HH:mm:ss"): string {
  return formatInTimeZone(value, "Asia/Shanghai", pattern);
}

export function syncHealthLabel(health: SyncHealth): string {
  switch (health) {
    case "healthy":
      return "同步正常";
    case "delayed":
      return "同步延迟";
    case "error":
      return "同步异常";
    case "never":
      return "等待首次同步";
  }
}

