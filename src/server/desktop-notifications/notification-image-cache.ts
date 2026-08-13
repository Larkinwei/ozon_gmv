import { createHash } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";

import sharp from "sharp";

const MAX_OUTPUT_BYTES = 200 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const OUTPUT_SIZES = [256, 192, 128];

export interface NotificationImageCacheOptions {
  rootDir?: string;
  fetchImplementation?: typeof fetch;
  now?: () => number;
}

function defaultRootDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "Ozon GMV Dashboard", "notification-images");
}

function imageFileName(imageUrl: string): string {
  return `${createHash("sha256").update(imageUrl).digest("hex")}.png`;
}

async function existingFreshImage(filePath: string, now: number): Promise<string | null> {
  try {
    const image = await stat(filePath);
    if (now - image.mtimeMs <= CACHE_TTL_MS && image.size <= MAX_OUTPUT_BYTES) {
      return filePath;
    }
  } catch {
    return null;
  }
  await rm(filePath, { force: true });
  return null;
}

async function encodePng(source: Buffer): Promise<Buffer | null> {
  for (const size of OUTPUT_SIZES) {
    const encoded = await sharp(source)
      .resize(size, size, { fit: "cover", withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    if (encoded.byteLength <= MAX_OUTPUT_BYTES) {
      return encoded;
    }
  }
  return null;
}

/** Downloads, normalizes and caches one HTTPS product image for Windows Toast. */
export class NotificationImageCache {
  private readonly rootDir: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Map<string, Promise<string | null>>();

  public constructor(options: NotificationImageCacheOptions = {}) {
    this.rootDir = options.rootDir ?? defaultRootDir();
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public async resolve(imageUrl: string | null): Promise<string | null> {
    if (!imageUrl) {
      return null;
    }
    let url: URL;
    try {
      url = new URL(imageUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") {
      return null;
    }

    const cacheKey = url.toString();
    const existingRequest = this.pending.get(cacheKey);
    if (existingRequest) {
      return existingRequest;
    }
    const request = this.load(cacheKey);
    this.pending.set(cacheKey, request);
    try {
      return await request;
    } finally {
      this.pending.delete(cacheKey);
    }
  }

  private async load(imageUrl: string): Promise<string | null> {
    const url = new URL(imageUrl);

    await mkdir(this.rootDir, { recursive: true });
    const filePath = join(this.rootDir, imageFileName(url.toString()));
    const cached = await existingFreshImage(filePath, this.now());
    if (cached) {
      return cached;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImplementation(url, { signal: controller.signal });
      if (!response.ok) {
        return null;
      }
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > MAX_SOURCE_BYTES) {
        return null;
      }
      const source = Buffer.from(await response.arrayBuffer());
      if (source.byteLength > MAX_SOURCE_BYTES) {
        return null;
      }
      const encoded = await encodePng(source);
      if (!encoded) {
        return null;
      }
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, encoded);
      await rename(temporaryPath, filePath);
      return filePath;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Removes image files that have not been used for seven days. */
  public async cleanup(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return;
    }
    const cutoff = this.now() - CACHE_TTL_MS;
    await Promise.all(entries.filter((entry) => extname(entry) === ".png").map(async (entry) => {
      const filePath = join(this.rootDir, entry);
      try {
        if ((await stat(filePath)).mtimeMs < cutoff) {
          await rm(filePath, { force: true });
        }
      } catch {
        // A concurrent notification may remove or replace the file.
      }
    }));
  }
}
