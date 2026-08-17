import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { ResellImageService } from "../src/server/selection/resell-image-service";
import { createTestDatabase } from "./test-context";

describe("resell image service", () => {
  it("normalizes, deduplicates, and resolves uploaded images in order", async () => {
    const context = createTestDatabase();
    const uploads: string[] = [];
    const storage = {
      putObject: async (key: string) => {
        uploads.push(key);
        return { objectKey: key, publicUrl: `https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/${key}` };
      },
    } as never;
    try {
      const service = new ResellImageService(context.database, storage);
      const input = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#22d3ee" } }).png().toBuffer();
      const first = await service.upload("first.png", input);
      const second = await service.upload("renamed.png", input);

      expect(second.id).toBe(first.id);
      expect(uploads).toHaveLength(1);
      const resolved = await service.resolve([
        { assetId: first.id, position: 0 },
        { assetId: first.id, position: 1 },
      ], []);
      expect(resolved.map((image) => image.url)).toEqual([first.url, first.url]);
    } finally {
      context.cleanup();
    }
  });

  it("accepts only the server-provided HTTPS source image", async () => {
    const context = createTestDatabase();
    const storage = { putObject: async () => ({ objectKey: "x", publicUrl: "https://example.com/x.jpg" }) } as never;
    try {
      const service = new ResellImageService(context.database, storage);
      const source = service.sourceImage("https://cdn.example.com/source.jpg");
      await expect(service.resolve([{ sourceUrl: "https://cdn.example.com/source.jpg", position: 0 }], source)).resolves.toHaveLength(1);
      await expect(service.resolve([{ sourceUrl: "https://evil.example.com/image.jpg", position: 0 }], source)).rejects.toThrow("来源商品主图");
    } finally {
      context.cleanup();
    }
  });
});
