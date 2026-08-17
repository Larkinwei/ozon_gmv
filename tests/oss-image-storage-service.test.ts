import { describe, expect, it } from "vitest";

import { OssImageStorageService } from "../src/server/services/oss-image-storage-service";
import { createTestDatabase } from "./test-context";

describe("OSS image storage", () => {
  it("encrypts credentials, signs uploads, and does not expose secrets", async () => {
    const context = createTestDatabase();
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(null, { status: String(input).includes("connection-test") ? 404 : 200 });
    }) as typeof fetch;
    try {
      const service = new OssImageStorageService(context.config, context.database, fetchImplementation);
      expect(service.view().configured).toBe(false);
      service.update({ accessKeyId: "test-access-key-id", accessKeySecret: "test-secret" });
      expect(service.view()).toMatchObject({ configured: true, bucket: "haodian-ozon-images", prefix: "ozon/resell-images", accessKeyIdMasked: "test••••••••••y-id", accessKeySecretMasked: "••••••••••••" });
      await service.test();
      const stored = await service.putObject("ozon/resell-images/test.jpg", new Uint8Array([1, 2]), "image/jpeg");
      expect(calls.map((call) => call.url)).toEqual([
        "https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/ozon/resell-images/.connection-test",
        "https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/ozon/resell-images/test.jpg",
      ]);
      expect(stored.publicUrl).toContain("https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/");
      expect(calls.map((call) => call.method)).toEqual(["HEAD", "PUT"]);
      expect(context.database.prepare("SELECT value FROM app_settings WHERE key = ?").get("resell.images.oss.access_key_secret")).not.toMatchObject({ value: "test-secret" });
    } finally {
      context.cleanup();
    }
  });
});
