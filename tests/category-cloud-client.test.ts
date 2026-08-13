import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { SelectionCategoryCloudSnapshot } from "../src/shared/contracts";
import { CategoryCloudClient } from "../src/server/selection/category-cloud-client";

const metric = {
  id: "3", name: "洗发水", categoryLevel1Id: "1", categoryLevel1Name: "美容",
  gmvMinor: "10000", gmvGrowth: 0.2, orderedUnits: 10, averagePriceMinor: "1000",
  averagePriceGrowth: 0.1, sellerCount: 5, brandCount: 4, clusterCount: 2,
  buyoutRate: 0.9, topFiveSellerShare: 0.3, categoryShare: 0.1, rating: 4.8, maximumRating: 5,
};

const snapshot: SelectionCategoryCloudSnapshot = {
  schemaVersion: 1,
  snapshotId: "a".repeat(64),
  collectedAt: "2026-08-13T00:00:00.000Z",
  periods: [7, 28],
  rowCount: 2,
  metrics: [{ ...metric, periodDays: 7 }, { ...metric, periodDays: 28 }],
};

describe("category cloud client", () => {
  it("uploads one gzip body with immutable snapshot metadata headers", async () => {
    let request: RequestInit | undefined;
    const client = new CategoryCloudClient("https://cloud.example", async (_input, init) => {
      request = init;
      return new Response(JSON.stringify({
        schemaVersion: 1,
        snapshotId: snapshot.snapshotId,
        collectedAt: snapshot.collectedAt,
        rowCount: snapshot.rowCount,
        sha256: "b".repeat(64),
        downloadUrl: "https://oss.example/snapshot.json.gz",
        expiresAt: "2026-08-13T01:00:00.000Z",
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    });

    await client.upload(snapshot, "secret");

    const headers = new Headers(request?.headers);
    expect(headers.get("content-type")).toBe("application/gzip");
    expect(headers.get("x-ozon-snapshot-id")).toBe(snapshot.snapshotId);
    expect(headers.get("x-ozon-snapshot-sha256")).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(gunzipSync(Buffer.from(request?.body as Buffer)).toString("utf8"))).toEqual(snapshot);
  });
});
