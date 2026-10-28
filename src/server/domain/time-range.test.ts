import { describe, expect, it } from "vitest";

import { resolveDashboardWindow } from "./time-range";

describe("resolveDashboardWindow granularity", () => {
  const now = new Date("2026-10-28T04:00:00.000Z");

  it("uses half-hour buckets for today and daily buckets for 7/30 days", () => {
    expect(resolveDashboardWindow("today", now).granularity).toBe("30m");
    expect(resolveDashboardWindow("7d", now).granularity).toBe("day");
    expect(resolveDashboardWindow("30d", now).granularity).toBe("day");
  });

  it("uses daily buckets for multi-day custom ranges", () => {
    expect(resolveDashboardWindow(
      "custom",
      now,
      "2026-10-01T00:00:00.000Z",
      "2026-10-04T00:00:00.000Z",
    ).granularity).toBe("day");
  });
});
