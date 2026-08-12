import { createHash, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";

import OSS from "ali-oss";
import { z } from "zod";

const metricSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  categoryLevel1Id: z.string().min(1),
  categoryLevel1Name: z.string().min(1),
  periodDays: z.union([z.literal(7), z.literal(28)]),
  gmvMinor: z.string().regex(/^\d+$/),
  gmvGrowth: z.number().nullable(),
  orderedUnits: z.number().int().nonnegative(),
  averagePriceMinor: z.string().regex(/^\d+$/),
  averagePriceGrowth: z.number().nullable(),
  sellerCount: z.number().nonnegative().nullable(),
  brandCount: z.number().nonnegative().nullable(),
  clusterCount: z.number().nonnegative().nullable(),
  buyoutRate: z.number().nullable(),
  topFiveSellerShare: z.number().nullable(),
  categoryShare: z.number().nullable(),
  rating: z.number().nullable(),
  maximumRating: z.number().nullable(),
});
export const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
  collectedAt: z.string().datetime(),
  periods: z.tuple([z.literal(7), z.literal(28)]),
  rowCount: z.number().int().positive(),
  metrics: z.array(metricSchema).min(1),
}).superRefine((snapshot, context) => {
  if (snapshot.rowCount !== snapshot.metrics.length) {
    context.addIssue({ code: "custom", message: "rowCount 与 metrics 数量不一致" });
  }
  const periods = new Set(snapshot.metrics.map((metric) => metric.periodDays));
  if (!periods.has(7) || !periods.has(28)) {
    context.addIssue({ code: "custom", message: "快照必须同时包含 7 天和 28 天数据" });
  }
  const expectedId = snapshotIdentity(snapshot);
  if (snapshot.snapshotId !== expectedId) {
    context.addIssue({ code: "custom", message: "snapshotId 与快照内容不一致" });
  }
});

export type CategorySnapshot = z.infer<typeof snapshotSchema>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Produces the immutable identifier used by collectors and the cloud validator. */
export function snapshotIdentity(snapshot: Pick<CategorySnapshot, "collectedAt" | "periods" | "metrics">): string {
  return createHash("sha256").update(canonicalJson({
    collectedAt: snapshot.collectedAt,
    periods: snapshot.periods,
    metrics: snapshot.metrics,
  })).digest("hex");
}

export interface StoredPointer {
  schemaVersion: 1;
  snapshotId: string;
  collectedAt: string;
  rowCount: number;
  sha256: string;
  objectName: string;
}

export interface SnapshotManifest extends Omit<StoredPointer, "objectName"> {
  downloadUrl: string;
  expiresAt: string;
}

export interface SnapshotStoragePort {
  exists: (objectName: string) => Promise<boolean>;
  putImmutable: (objectName: string, content: Buffer, sha256: string) => Promise<void>;
  readPointer: () => Promise<StoredPointer | null>;
  writePointer: (pointer: StoredPointer) => Promise<void>;
  signedUrl: (objectName: string, expiresSeconds: number) => string;
}

/** OSS adapter keeps every snapshot immutable and updates the latest pointer last. */
export class OssSnapshotStorage implements SnapshotStoragePort {
  private readonly client: OSS;

  public constructor(environment: NodeJS.ProcessEnv) {
    const accessKeyId = environment.OSS_ACCESS_KEY_ID ?? environment.ALIBABA_CLOUD_ACCESS_KEY_ID;
    const accessKeySecret = environment.OSS_ACCESS_KEY_SECRET ?? environment.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
    this.client = new OSS({
      region: environment.OSS_REGION!,
      bucket: environment.OSS_BUCKET!,
      accessKeyId: accessKeyId!,
      accessKeySecret: accessKeySecret!,
      stsToken: environment.OSS_STS_TOKEN ?? environment.ALIBABA_CLOUD_SECURITY_TOKEN,
      secure: true,
    });
  }

  public async exists(objectName: string): Promise<boolean> {
    try {
      await this.client.head(objectName);
      return true;
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        return false;
      }
      throw error;
    }
  }

  public async putImmutable(objectName: string, content: Buffer, sha256: string): Promise<void> {
    await this.client.put(objectName, content, {
      headers: {
        "Content-Type": "application/gzip",
        "Cache-Control": "private, max-age=31536000, immutable",
        "x-oss-meta-sha256": sha256,
      },
    });
    const head = await this.client.head(objectName);
    const headers = head.res.headers as Record<string, string | undefined>;
    const storedHash = String(headers["x-oss-meta-sha256"] ?? "");
    if (storedHash !== sha256) {
      throw new Error("OSS 对象校验失败，未更新 latest 指针");
    }
  }

  public async readPointer(): Promise<StoredPointer | null> {
    try {
      const result = await this.client.get("category-snapshots/latest.json");
      return JSON.parse(Buffer.from(result.content).toString("utf8")) as StoredPointer;
    } catch (error) {
      if ((error as { status?: number }).status === 404) {
        return null;
      }
      throw error;
    }
  }

  public async writePointer(pointer: StoredPointer): Promise<void> {
    await this.client.put("category-snapshots/latest.json", Buffer.from(JSON.stringify(pointer)), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    });
  }

  public signedUrl(objectName: string, expiresSeconds: number): string {
    return this.client.signatureUrl(objectName, { expires: expiresSeconds, method: "GET" });
  }
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** Implements authenticated atomic publication and public short-lived reads. */
export class SnapshotService {
  public constructor(
    private readonly storage: SnapshotStoragePort,
    private readonly uploadToken: string,
  ) {}

  public authorize(authorization: string | undefined): boolean {
    const prefix = "Bearer ";
    return Boolean(authorization?.startsWith(prefix))
      && safeTokenEqual(authorization!.slice(prefix.length), this.uploadToken);
  }

  public async publish(input: unknown): Promise<SnapshotManifest> {
    const snapshot = snapshotSchema.parse(input);
    const compressed = gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
    const sha256 = createHash("sha256").update(compressed).digest("hex");
    const objectName = `category-snapshots/v1/${snapshot.snapshotId}.json.gz`;
    if (!await this.storage.exists(objectName)) {
      await this.storage.putImmutable(objectName, compressed, sha256);
    }
    const pointer: StoredPointer = {
      schemaVersion: 1,
      snapshotId: snapshot.snapshotId,
      collectedAt: snapshot.collectedAt,
      rowCount: snapshot.rowCount,
      sha256,
      objectName,
    };
    const current = await this.storage.readPointer();
    if (!current || Date.parse(pointer.collectedAt) >= Date.parse(current.collectedAt)) {
      await this.storage.writePointer(pointer);
    }
    return this.toManifest(pointer);
  }

  public async latest(): Promise<SnapshotManifest | null> {
    const pointer = await this.storage.readPointer();
    return pointer ? this.toManifest(pointer) : null;
  }

  private toManifest(pointer: StoredPointer): SnapshotManifest {
    const expiresSeconds = 300;
    return {
      schemaVersion: 1,
      snapshotId: pointer.snapshotId,
      collectedAt: pointer.collectedAt,
      rowCount: pointer.rowCount,
      sha256: pointer.sha256,
      downloadUrl: this.storage.signedUrl(pointer.objectName, expiresSeconds),
      expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
    };
  }
}
