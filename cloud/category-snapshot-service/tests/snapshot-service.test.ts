import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  SnapshotService,
  snapshotIdentity,
  type SnapshotStoragePort,
  type StoredPointer,
} from "../src/snapshot-service.js";

class MemoryStorage implements SnapshotStoragePort {
  public objects = new Map<string, Buffer>();
  public pointer: StoredPointer | null = null;

  public async exists(objectName: string): Promise<boolean> { return this.objects.has(objectName); }
  public async putImmutable(objectName: string, content: Buffer): Promise<void> { this.objects.set(objectName, content); }
  public async readPointer(): Promise<StoredPointer | null> { return this.pointer; }
  public async writePointer(pointer: StoredPointer): Promise<void> { this.pointer = pointer; }
  public signedUrl(objectName: string): string { return `https://oss.example/${objectName}`; }
}

function snapshot() {
  const metric = {
    id: "3", name: "洗发水", categoryLevel1Id: "1", categoryLevel1Name: "美容",
    gmvMinor: "10000", gmvGrowth: 0.2, orderedUnits: 10, averagePriceMinor: "1000",
    averagePriceGrowth: 0.1, sellerCount: 5, brandCount: 4, clusterCount: 2,
    buyoutRate: 0.9, topFiveSellerShare: 0.3, categoryShare: 0.1, rating: 4.8, maximumRating: 5,
  };
  const collectedAt = "2026-08-12T00:00:00.000Z";
  const periods = [7, 28] as [7, 28];
  const metrics = [{ ...metric, periodDays: 7 as const }, { ...metric, periodDays: 28 as const }];
  const snapshotId = snapshotIdentity({ collectedAt, periods, metrics });
  return {
    schemaVersion: 1 as const, snapshotId, collectedAt,
    periods, rowCount: 2, metrics,
  };
}

describe("category snapshot service", () => {
  it("publishes the object before latest and keeps duplicate uploads idempotent", async () => {
    const storage = new MemoryStorage();
    const service = new SnapshotService(storage, "secret");
    const first = await service.publish(snapshot());
    const second = await service.publish(snapshot());
    expect(storage.objects.size).toBe(1);
    expect(storage.pointer?.snapshotId).toBe(snapshot().snapshotId);
    expect(second.sha256).toBe(first.sha256);
    expect(service.authorize("Bearer secret")).toBe(true);
    expect(service.authorize("Bearer wrong")).toBe(false);
  });

  it("stores an authenticated gzip snapshot without expanding it in memory", async () => {
    const storage = new MemoryStorage();
    const service = new SnapshotService(storage, "secret");
    const input = snapshot();
    const compressed = gzipSync(Buffer.from(JSON.stringify(input)));
    const sha256 = createHash("sha256").update(compressed).digest("hex");

    const manifest = await service.publishCompressed(compressed, {
      snapshotId: input.snapshotId,
      collectedAt: input.collectedAt,
      rowCount: input.rowCount,
      sha256,
    });

    expect(storage.objects.get(`category-snapshots/v1/${input.snapshotId}.json.gz`)).toEqual(compressed);
    expect(manifest.sha256).toBe(sha256);
  });
});
