import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import { z } from "zod";

import type {
  SelectionCategoryCloudManifest,
  SelectionCategoryCloudSnapshot,
} from "../../shared/contracts";

export type CategoryFetch = typeof fetch;

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().min(1),
  collectedAt: z.string().datetime(),
  rowCount: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  downloadUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});
const metricSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), categoryLevel1Id: z.string().min(1),
  categoryLevel1Name: z.string().min(1), periodDays: z.union([z.literal(7), z.literal(28)]),
  gmvMinor: z.string().regex(/^\d+$/), gmvGrowth: z.number().nullable(),
  orderedUnits: z.number().int().nonnegative(), averagePriceMinor: z.string().regex(/^\d+$/),
  averagePriceGrowth: z.number().nullable(), sellerCount: z.number().nonnegative().nullable(),
  brandCount: z.number().nonnegative().nullable(), clusterCount: z.number().nonnegative().nullable(),
  buyoutRate: z.number().nullable(), topFiveSellerShare: z.number().nullable(),
  categoryShare: z.number().nullable(), rating: z.number().nullable(), maximumRating: z.number().nullable(),
});
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  collectedAt: z.string().datetime(), periods: z.tuple([z.literal(7), z.literal(28)]),
  rowCount: z.number().int().positive(), metrics: z.array(metricSchema).min(1),
}).refine((snapshot) => snapshot.rowCount === snapshot.metrics.length, "快照行数不正确");

export interface CategoryCloudPort {
  upload: (snapshot: SelectionCategoryCloudSnapshot, token: string) => Promise<SelectionCategoryCloudManifest>;
  downloadLatest: () => Promise<SelectionCategoryCloudSnapshot>;
}

/** Transfers normalized categories, bestseller rankings and market queries as one atomic snapshot. */
export class CategoryCloudClient implements CategoryCloudPort {
  public constructor(
    private readonly baseUrl: string,
    private readonly fetchImplementation: CategoryFetch = fetch,
  ) {}

  public async upload(
    snapshot: SelectionCategoryCloudSnapshot,
    token: string,
  ): Promise<SelectionCategoryCloudManifest> {
    const compressed = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
    const sha256 = createHash("sha256").update(compressed).digest("hex");
    const response = await this.fetchImplementation(`${this.baseUrl}/v1/category-snapshots`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/gzip",
        "Content-Encoding": "gzip",
        "X-Ozon-Snapshot-Id": snapshot.snapshotId,
        "X-Ozon-Collected-At": snapshot.collectedAt,
        "X-Ozon-Row-Count": String(snapshot.rowCount),
        "X-Ozon-Snapshot-Sha256": sha256,
      },
      body: compressed,
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { message?: string } | null;
      const message = detail?.message ? `：${detail.message}` : "";
      throw new Error(`云端快照上传失败（${response.status}）${message}`);
    }
    return manifestSchema.parse(await response.json());
  }

  public async downloadLatest(): Promise<SelectionCategoryCloudSnapshot> {
    const manifestResponse = await this.fetchImplementation(`${this.baseUrl}/v1/category-snapshots/latest`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!manifestResponse.ok) {
      throw new Error(`云端快照清单读取失败（${manifestResponse.status}）`);
    }
    const manifest = manifestSchema.parse(await manifestResponse.json());
    const snapshotResponse = await this.fetchImplementation(manifest.downloadUrl, {
      headers: { Accept: "application/gzip, application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!snapshotResponse.ok) {
      throw new Error(`云端快照下载失败（${snapshotResponse.status}）`);
    }
    const compressed = Buffer.from(await snapshotResponse.arrayBuffer());
    const digest = createHash("sha256").update(compressed).digest("hex");
    if (digest !== manifest.sha256) {
      throw new Error("云端类目快照校验失败");
    }
    const snapshot = JSON.parse(gunzipSync(compressed).toString("utf8")) as SelectionCategoryCloudSnapshot;
    snapshotSchema.parse(snapshot);
    return snapshot;
  }
}
