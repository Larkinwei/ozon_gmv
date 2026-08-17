import { createHash, randomUUID } from "node:crypto";

import sharp from "sharp";

import type { ResellImageInput, ResellImageUploadView, ResellImageView } from "../../shared/contracts";
import type { AppDatabase } from "../db/database";
import { IMAGE_PREFIX, OssImageStorageService } from "../services/oss-image-storage-service";

const MAX_IMAGES = 15;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

interface ImageAssetRow {
  id: string;
  object_key: string;
  public_url: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  width: number;
  height: number;
  sha256: string;
}

export interface ResolvedResellImage {
  assetId: string | null;
  url: string;
  source: "source" | "uploaded";
  fileName: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
}

function assetView(row: ImageAssetRow): ResellImageUploadView {
  return {
    id: row.id,
    url: row.public_url,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
  };
}

function sourceView(url: string, position: number): ResellImageView {
  return {
    id: `source-${createHash("sha256").update(url).digest("hex").slice(0, 20)}`,
    url,
    fileName: `来源图片 ${position + 1}`,
    mimeType: "image/*",
    byteSize: 0,
    width: 0,
    height: 0,
    source: "source",
  };
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Handles safe image normalization, OSS upload, and task image resolution. */
export class ResellImageService {
  public constructor(private readonly database: AppDatabase, private readonly storage: OssImageStorageService) {}

  /** Converts the MY source URL into a selectable image only when it is HTTPS. */
  public sourceImage(url: string | null): ResellImageView[] {
    return url && isHttpsUrl(url) ? [sourceView(url, 0)] : [];
  }

  /** Normalizes one local image, uploads it by content hash, and returns its asset metadata. */
  public async upload(fileName: string, input: Buffer): Promise<ResellImageUploadView> {
    if (input.byteLength === 0) {
      throw new Error("图片文件为空");
    }
    const metadata = await sharp(input).metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format)) {
      throw new Error("仅支持 JPG、PNG 或 WEBP 图片");
    }
    if (!metadata.width || !metadata.height) {
      throw new Error("无法读取图片尺寸");
    }
    const normalized = await sharp(input)
      .rotate()
      .resize({ width: 2_000, height: 2_000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    if (normalized.byteLength > MAX_OUTPUT_BYTES) {
      throw new Error("图片压缩后仍超过 2 MB，请选择更小的图片");
    }
    const sha256 = createHash("sha256").update(normalized).digest("hex");
    const existing = this.database.prepare("SELECT * FROM resell_image_assets WHERE sha256 = ?").get(sha256) as ImageAssetRow | undefined;
    if (existing) {
      return assetView(existing);
    }

    const objectKey = `${IMAGE_PREFIX}/${sha256}.jpg`;
    const stored = await this.storage.putObject(objectKey, normalized, "image/jpeg");
    const outputMetadata = await sharp(normalized).metadata();
    const id = randomUUID();
    this.database.prepare(`INSERT INTO resell_image_assets
      (id, object_key, public_url, file_name, mime_type, byte_size, width, height, sha256, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, stored.objectKey, stored.publicUrl, fileName.slice(0, 255) || "商品图片.jpg", "image/jpeg", normalized.byteLength,
        outputMetadata.width ?? metadata.width, outputMetadata.height ?? metadata.height, sha256, Date.now());
    return assetView(this.database.prepare("SELECT * FROM resell_image_assets WHERE id = ?").get(id) as ImageAssetRow);
  }

  /** Reads an image asset without exposing its storage credentials. */
  public getAsset(id: string): ImageAssetRow | null {
    return (this.database.prepare("SELECT * FROM resell_image_assets WHERE id = ?").get(id) as ImageAssetRow | undefined) ?? null;
  }

  /** Removes an unused asset record; the OSS lifecycle policy handles object cleanup. */
  public deleteAsset(id: string): boolean {
    const references = this.database.prepare("SELECT 1 FROM resell_task_images WHERE asset_id = ? LIMIT 1").get(id);
    if (references || !this.getAsset(id)) {
      return false;
    }
    return this.database.prepare("DELETE FROM resell_image_assets WHERE id = ?").run(id).changes > 0;
  }

  /** Resolves submitted positions to server-owned assets or the verified source image. */
  public async resolve(inputs: ResellImageInput[], sourceImages: ResellImageView[]): Promise<ResolvedResellImage[]> {
    if (inputs.length === 0 || inputs.length > MAX_IMAGES) {
      throw new Error(`商品图片数量必须在 1 到 ${MAX_IMAGES} 张之间`);
    }
    const ordered = [...inputs].sort((left, right) => left.position - right.position);
    if (ordered.some((item, index) => item.position !== index)) {
      throw new Error("图片顺序不连续，请重新排列后再试");
    }
    const sourceUrls = new Set(sourceImages.map((image) => image.url));
    return ordered.map((input) => {
      if (input.assetId) {
        const asset = this.getAsset(input.assetId);
        if (!asset) throw new Error("图片资产不存在或已过期");
        return {
          assetId: asset.id,
          url: asset.public_url,
          source: "uploaded" as const,
          fileName: asset.file_name,
          mimeType: asset.mime_type,
          byteSize: asset.byte_size,
          width: asset.width,
          height: asset.height,
        };
      }
      if (input.sourceUrl && isHttpsUrl(input.sourceUrl) && sourceUrls.has(input.sourceUrl)) {
        const source = sourceImages.find((image) => image.url === input.sourceUrl)!;
        return {
          assetId: null,
          url: source.url,
          source: "source" as const,
          fileName: source.fileName,
          mimeType: source.mimeType,
          byteSize: source.byteSize,
          width: source.width,
          height: source.height,
        };
      }
      throw new Error("图片必须来自已上传的图片资产或来源商品主图");
    });
  }

  /** Persists the immutable image order associated with a resell task. */
  public saveTaskImages(taskId: string, images: ResolvedResellImage[]): void {
    const save = this.database.transaction(() => {
      this.database.prepare("DELETE FROM resell_task_images WHERE task_id = ?").run(taskId);
      const statement = this.database.prepare(`INSERT INTO resell_task_images
        (task_id, position, asset_id, source_url, created_at_ms) VALUES (?, ?, ?, ?, ?)`);
      for (const [position, image] of images.entries()) {
        statement.run(taskId, position, image.assetId, image.assetId ? null : image.url, Date.now());
        if (image.assetId) {
          this.database.prepare("UPDATE resell_image_assets SET last_used_at_ms = ? WHERE id = ?").run(Date.now(), image.assetId);
        }
      }
    });
    save();
  }

  /** Returns the ordered public URLs used by the Ozon picture import request. */
  public listTaskImageUrls(taskId: string): string[] {
    const rows = this.database.prepare(`SELECT COALESCE(asset.public_url, task.source_url) AS url
      FROM resell_task_images task
      LEFT JOIN resell_image_assets asset ON asset.id = task.asset_id
      WHERE task.task_id = ? ORDER BY task.position`).all(taskId) as Array<{ url: string | null }>;
    return rows.map((row) => row.url).filter((url): url is string => Boolean(url));
  }
}

export { MAX_IMAGES };
