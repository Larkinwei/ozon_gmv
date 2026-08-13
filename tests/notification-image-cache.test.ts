import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NotificationImageCache } from "../src/server/desktop-notifications/notification-image-cache";

const roots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ozon-notification-images-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("notification image cache", () => {
  it("downloads and normalizes an HTTPS image into a small PNG", async () => {
    const root = await createRoot();
    const source = await sharp({ create: { width: 512, height: 512, channels: 3, background: "#22c55e" } }).jpeg().toBuffer();
    const fetchImplementation = vi.fn(async () => new Response(source, { status: 200, headers: { "content-type": "image/jpeg" } }));
    const cache = new NotificationImageCache({ rootDir: root, fetchImplementation, now: () => 1_000 });

    const imagePath = await cache.resolve("https://cdn.example.com/product.jpg");
    expect(imagePath).toMatch(/\.png$/);
    expect((await readFile(imagePath!)).byteLength).toBeGreaterThan(0);
    expect((await sharp(imagePath!).metadata()).format).toBe("png");
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("reuses a fresh cache and rejects non-HTTPS or failed images", async () => {
    const root = await createRoot();
    const source = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#3b82f6" } }).png().toBuffer();
    const fetchImplementation = vi.fn(async () => new Response(source, { status: 200 }));
    const cache = new NotificationImageCache({ rootDir: root, fetchImplementation, now: () => 1_000 });

    const first = await cache.resolve("https://cdn.example.com/product.png");
    const second = await cache.resolve("https://cdn.example.com/product.png");
    expect(second).toBe(first);
    expect(fetchImplementation).toHaveBeenCalledOnce();
    await expect(cache.resolve("http://cdn.example.com/product.png")).resolves.toBeNull();
    await expect(new NotificationImageCache({ rootDir: root, fetchImplementation: vi.fn(async () => new Response(null, { status: 404 })) }).resolve("https://cdn.example.com/missing.png")).resolves.toBeNull();
  });

  it("deduplicates concurrent downloads for the same URL", async () => {
    const root = await createRoot();
    const source = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#3b82f6" } }).png().toBuffer();
    let release: (() => void) | undefined;
    const fetchImplementation = vi.fn(() => new Promise<Response>((resolve) => {
      release = () => resolve(new Response(source, { status: 200 }));
    }));
    const cache = new NotificationImageCache({ rootDir: root, fetchImplementation, now: () => 1_000 });
    const first = cache.resolve("https://cdn.example.com/concurrent.png");
    const second = cache.resolve("https://cdn.example.com/concurrent.png");
    await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    release?.();
    const [firstPath, secondPath] = await Promise.all([first, second]);
    expect(firstPath).toBe(secondPath);
    expect(firstPath).not.toBeNull();
  });

  it("removes stale PNG cache entries", async () => {
    const root = await createRoot();
    const stalePath = join(root, "stale.png");
    await writeFile(stalePath, Buffer.from("stale"));
    await utimes(stalePath, 0, 0);
    await new NotificationImageCache({ rootDir: root, now: () => 8 * 24 * 60 * 60 * 1000 }).cleanup();
    await expect(readFile(stalePath)).rejects.toThrow();
  });
});
