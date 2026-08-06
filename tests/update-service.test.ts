import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { UpdateManifest } from "../src/shared/contracts";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import {
  compareVersions,
  UpdateService,
  verifyUpdateManifest,
} from "../src/server/services/update-service";
import { createTestDatabase } from "./test-context";

function signedManifest(manifest: UpdateManifest): { raw: string; signature: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = `${JSON.stringify(manifest, null, 2)}\n`;
  return {
    raw,
    signature: sign(null, Buffer.from(raw), privateKey).toString("base64"),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

async function waitForState(service: UpdateService, expected: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (service.view().state === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Update service did not enter ${expected}: ${JSON.stringify(service.view())}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signed Windows updates", () => {
  it("compares stable versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.1.0", "1.1.0")).toBe(0);
    expect(compareVersions("1.0.9", "1.1.0")).toBe(-1);
    expect(() => compareVersions("1.1.0-beta", "1.1.0")).toThrow("无效的软件版本");
  });

  it("verifies exact bytes and rejects signed URLs outside the allowlist", () => {
    const installer = Buffer.from("signed installer");
    const manifest: UpdateManifest = {
      schemaVersion: 1,
      version: "1.1.1",
      publishedAt: "2026-08-06T08:00:00.000Z",
      notes: "安全更新",
      size: installer.length,
      sha256: createHash("sha256").update(installer).digest("hex"),
      urls: [
        "https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/ozon-gmv/releases/v1.1.1/OzonGMV-Setup-1.1.1.exe",
        "https://github.com/Larkinwei/ozon_gmv/releases/download/v1.1.1/OzonGMV-Setup-1.1.1.exe",
      ],
    };
    const signed = signedManifest(manifest);
    expect(verifyUpdateManifest(signed.raw, signed.signature, signed.publicKey)).toEqual(manifest);
    expect(() => verifyUpdateManifest(`${signed.raw} `, signed.signature, signed.publicKey)).toThrow("签名无效");

    const unsafe = signedManifest({ ...manifest, urls: ["https://example.com/update.exe", manifest.urls[1]] });
    expect(() => verifyUpdateManifest(unsafe.raw, unsafe.signature, unsafe.publicKey)).toThrow("允许列表");
  });

  it("falls back to GitHub, verifies the installer, and starts only one install task", async () => {
    const context = createTestDatabase();
    const installer = Buffer.from("valid windows installer bytes");
    const manifest: UpdateManifest = {
      schemaVersion: 1,
      version: "1.1.1",
      publishedAt: "2026-08-06T08:00:00.000Z",
      notes: "修复和稳定性更新",
      size: installer.length,
      sha256: createHash("sha256").update(installer).digest("hex"),
      urls: [
        "https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/ozon-gmv/releases/v1.1.1/OzonGMV-Setup-1.1.1.exe",
        "https://github.com/Larkinwei/ozon_gmv/releases/download/v1.1.1/OzonGMV-Setup-1.1.1.exe",
      ],
    };
    const signed = signedManifest(manifest);
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxy = new ProxySettingsService(context.config, settings);
    const launches: string[] = [];
    const service = new UpdateService(
      { ...context.config, UPDATE_ENABLED: true },
      proxy,
      { platform: "win32", publicKey: signed.publicKey, launchInstaller: (path) => { launches.push(path); } },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("haodian-ozon-images") && url.endsWith("latest.json")) {
        return new Response("unavailable", { status: 503 });
      }
      if (url.includes("haodian-ozon-images") && url.endsWith("latest.sig")) {
        return new Response("unavailable", { status: 503 });
      }
      if (url.endsWith("latest.json")) {
        return new Response(signed.raw);
      }
      if (url.endsWith("latest.sig")) {
        return new Response(signed.signature);
      }
      if (url.includes("haodian-ozon-images")) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(installer);
    }));

    try {
      expect((await service.check()).state).toBe("available");
      service.beginInstall();
      service.beginInstall();
      await waitForState(service, "installing");
      expect(launches).toHaveLength(1);
      expect(service.view()).toMatchObject({ downloadedBytes: installer.length, totalBytes: installer.length });
    } finally {
      context.cleanup();
    }
  });

  it("rejects a corrupted installer from both sources", async () => {
    const context = createTestDatabase();
    const expectedInstaller = Buffer.from("expected installer");
    const manifest: UpdateManifest = {
      schemaVersion: 1,
      version: "1.1.1",
      publishedAt: "2026-08-06T08:00:00.000Z",
      notes: "安全更新",
      size: expectedInstaller.length,
      sha256: createHash("sha256").update(expectedInstaller).digest("hex"),
      urls: [
        "https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/ozon-gmv/releases/v1.1.1/OzonGMV-Setup-1.1.1.exe",
        "https://github.com/Larkinwei/ozon_gmv/releases/download/v1.1.1/OzonGMV-Setup-1.1.1.exe",
      ],
    };
    const signed = signedManifest(manifest);
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxy = new ProxySettingsService(context.config, settings);
    const service = new UpdateService(
      { ...context.config, UPDATE_ENABLED: true },
      proxy,
      { platform: "win32", publicKey: signed.publicKey, launchInstaller: () => undefined },
    );
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("latest.json")) {
        return new Response(signed.raw);
      }
      if (url.endsWith("latest.sig")) {
        return new Response(signed.signature);
      }
      return new Response(Buffer.alloc(expectedInstaller.length, 0));
    }));

    try {
      await service.check();
      service.beginInstall();
      await waitForState(service, "failed");
      expect(service.view().error).toContain("SHA-256");
    } finally {
      context.cleanup();
    }
  });

  it("resumes an existing partial installer with an HTTP range request", async () => {
    const context = createTestDatabase();
    const installer = Buffer.from("resumable windows installer");
    const version = "1.1.1";
    const manifest: UpdateManifest = {
      schemaVersion: 1,
      version,
      publishedAt: "2026-08-06T08:00:00.000Z",
      notes: "断点续传验证",
      size: installer.length,
      sha256: createHash("sha256").update(installer).digest("hex"),
      urls: [
        `https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/ozon-gmv/releases/v${version}/OzonGMV-Setup-${version}.exe`,
        `https://github.com/Larkinwei/ozon_gmv/releases/download/v${version}/OzonGMV-Setup-${version}.exe`,
      ],
    };
    const signed = signedManifest(manifest);
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxy = new ProxySettingsService(context.config, settings);
    const service = new UpdateService(
      { ...context.config, UPDATE_ENABLED: true },
      proxy,
      { platform: "win32", publicKey: signed.publicKey, launchInstaller: () => undefined },
    );
    const partialSize = 8;
    const updateDir = join(context.config.DATA_DIR, "updates");
    await mkdir(updateDir, { recursive: true });
    await writeFile(join(updateDir, `OzonGMV-Setup-${version}.exe.part`), installer.subarray(0, partialSize));
    let rangeHeader: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("latest.json")) {
        return new Response(signed.raw);
      }
      if (url.endsWith("latest.sig")) {
        return new Response(signed.signature);
      }
      rangeHeader = new Headers(init?.headers).get("Range");
      return new Response(installer.subarray(partialSize), {
        status: 206,
        headers: { "Content-Range": `bytes ${partialSize}-${installer.length - 1}/${installer.length}` },
      });
    }));

    try {
      await service.check();
      service.beginInstall();
      await waitForState(service, "installing");
      expect(rangeHeader).toBe(`bytes=${partialSize}-`);
    } finally {
      context.cleanup();
    }
  });
});
