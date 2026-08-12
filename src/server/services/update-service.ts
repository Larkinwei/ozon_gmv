import { spawn } from "node:child_process";
import { createHash, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { z } from "zod";

import type { UpdateManifest, UpdateView } from "../../shared/contracts";
import type { AppConfig } from "../config";
import type { ProxySettingsService } from "./proxy-settings-service";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const STARTUP_CHECK_DELAY_MS = 5 * 60 * 1_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const PENDING_FILE = "pending-update.json";
const RESULT_FILE = "last-update-result.json";
const LOG_FILE = "update.log";
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "haodian-ozon-images.oss-cn-beijing.aliyuncs.com",
  "github.com",
]);

// The matching private key exists only as a protected GitHub Actions secret.
export const RELEASE_UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEARR0KOQVFM7JjD6xKrOj9qyedGXQ1YSzWcNnGWpBcSVo=
-----END PUBLIC KEY-----
`;

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  publishedAt: z.iso.datetime(),
  notes: z.string().max(20_000),
  size: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  urls: z.tuple([z.string().url(), z.string().url()]),
});

interface PendingUpdate {
  version: string;
  installerPath: string;
  startedAt: string;
}

interface UpdateResult {
  version: string;
  status: "succeeded" | "failed";
  finishedAt: string;
  message: string;
}

interface UpdateServiceOptions {
  platform?: NodeJS.Platform;
  publicKey?: string;
  now?: () => Date;
  launchInstaller?: (path: string) => void | Promise<void>;
}

function versionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`无效的软件版本：${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compares strict stable semantic versions without accepting prerelease syntax. */
export function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
}

/** Verifies the exact signed UTF-8 bytes before parsing the update manifest. */
export function verifyUpdateManifest(
  rawManifest: string,
  signatureBase64: string,
  publicKey = RELEASE_UPDATE_PUBLIC_KEY,
): UpdateManifest {
  const signature = Buffer.from(signatureBase64.trim(), "base64");
  if (signature.length === 0 || !verify(null, Buffer.from(rawManifest, "utf8"), publicKey, signature)) {
    throw new Error("更新清单签名无效");
  }
  const manifest = manifestSchema.parse(JSON.parse(rawManifest)) as UpdateManifest;
  for (const value of manifest.urls) {
    const url = new URL(value);
    if (url.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(url.hostname)) {
      throw new Error("更新包下载地址不在允许列表中");
    }
  }
  return manifest;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function existingSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

/** Owns the single Windows-only signed update task and its observable state. */
export class UpdateService {
  private readonly updatesDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly publicKey: string;
  private readonly now: () => Date;
  private readonly launchInstaller: (path: string) => void | Promise<void>;
  private currentManifest: UpdateManifest | null = null;
  private operation: Promise<void> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private state: UpdateView;

  public constructor(
    private readonly config: AppConfig,
    private readonly proxySettings: ProxySettingsService,
    options: UpdateServiceOptions = {},
  ) {
    this.updatesDir = join(config.DATA_DIR, "updates");
    this.platform = options.platform ?? process.platform;
    this.publicKey = options.publicKey ?? RELEASE_UPDATE_PUBLIC_KEY;
    this.now = options.now ?? (() => new Date());
    this.launchInstaller = options.launchInstaller ?? ((path) => new Promise<void>((resolve, reject) => {
      const child = spawn(path, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    }));
    const supported = config.UPDATE_ENABLED && this.platform === "win32";
    this.state = {
      supported,
      currentVersion: config.APP_VERSION,
      latestVersion: null,
      state: supported ? "idle" : "unsupported",
      notes: null,
      publishedAt: null,
      downloadedBytes: 0,
      totalBytes: 0,
      lastCheckedAt: null,
      error: null,
    };
  }

  /** Restores the previous update result, cleans stale files, and starts periodic checks. */
  public async start(): Promise<void> {
    await mkdir(this.updatesDir, { recursive: true });
    await this.reconcilePendingUpdate();
    await this.cleanupExpiredFiles();
    if (!this.state.supported) {
      return;
    }
    this.startupTimer = setTimeout(() => void this.check(), STARTUP_CHECK_DELAY_MS);
    this.startupTimer.unref();
    this.intervalTimer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  public stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
    }
    this.startupTimer = null;
    this.intervalTimer = null;
  }

  public view(): UpdateView {
    return { ...this.state };
  }

  /** Checks both fixed manifest endpoints while enforcing one update operation at a time. */
  public async check(): Promise<UpdateView> {
    if (!this.state.supported || this.operation) {
      return this.view();
    }
    this.state = { ...this.state, state: "checking", error: null };
    this.operation = this.performCheck().finally(() => {
      this.operation = null;
    });
    await this.operation;
    return this.view();
  }

  /** Starts a background download and install without accepting a caller-provided URL or path. */
  public beginInstall(): UpdateView {
    if (!this.state.supported || this.operation) {
      return this.view();
    }
    this.state = {
      ...this.state,
      state: this.currentManifest ? "downloading" : "checking",
      downloadedBytes: 0,
      error: null,
    };
    this.operation = this.performInstall()
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.operation = null;
      });
    return this.view();
  }

  private async performCheck(): Promise<void> {
    try {
      const manifest = await this.fetchLatestManifest();
      this.currentManifest = manifest;
      const available = compareVersions(manifest.version, this.config.APP_VERSION) > 0;
      this.state = {
        ...this.state,
        latestVersion: manifest.version,
        state: available ? "available" : "up-to-date",
        notes: manifest.notes,
        publishedAt: manifest.publishedAt,
        downloadedBytes: 0,
        totalBytes: manifest.size,
        lastCheckedAt: this.now().toISOString(),
        error: null,
      };
    } catch (error) {
      await this.fail(error);
    }
  }

  private async performInstall(): Promise<void> {
    const manifest = this.currentManifest ?? await this.fetchLatestManifest();
    this.currentManifest = manifest;
    if (compareVersions(manifest.version, this.config.APP_VERSION) <= 0) {
      this.state = {
        ...this.state,
        latestVersion: manifest.version,
        state: "up-to-date",
        notes: manifest.notes,
        publishedAt: manifest.publishedAt,
        lastCheckedAt: this.now().toISOString(),
        error: null,
      };
      return;
    }

    this.state = {
      ...this.state,
      latestVersion: manifest.version,
      state: "downloading",
      notes: manifest.notes,
      publishedAt: manifest.publishedAt,
      totalBytes: manifest.size,
      lastCheckedAt: this.now().toISOString(),
      error: null,
    };
    const installerPath = await this.downloadInstaller(manifest);
    const pending: PendingUpdate = {
      version: manifest.version,
      installerPath,
      startedAt: this.now().toISOString(),
    };
    await this.writeJsonAtomically(join(this.updatesDir, PENDING_FILE), pending);
    await this.log(`Launching signed installer ${basename(installerPath)}.`);
    this.state = { ...this.state, state: "installing", downloadedBytes: manifest.size };
    try {
      await this.launchInstaller(installerPath);
    } catch (error) {
      await unlink(join(this.updatesDir, PENDING_FILE));
      throw error;
    }
  }

  private async fetchLatestManifest(): Promise<UpdateManifest> {
    const fetcher = this.proxySettings.createFetch();
    const sources = [this.config.UPDATE_PRIMARY_MANIFEST_URL, this.config.UPDATE_FALLBACK_MANIFEST_URL];
    const failures: string[] = [];
    for (const source of sources) {
      try {
        const manifestUrl = new URL(source);
        if (manifestUrl.protocol !== "https:" || !ALLOWED_DOWNLOAD_HOSTS.has(manifestUrl.hostname)) {
          throw new Error("更新清单地址不在允许列表中");
        }
        const signatureUrl = new URL(manifestUrl);
        signatureUrl.pathname = signatureUrl.pathname.replace(/\.json$/, ".sig");
        const [manifestResponse, signatureResponse] = await Promise.all([
          fetcher(manifestUrl, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) }),
          fetcher(signatureUrl, { headers: { "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(30_000) }),
        ]);
        if (!manifestResponse.ok || !signatureResponse.ok) {
          throw new Error(`清单返回 HTTP ${manifestResponse.status}/${signatureResponse.status}`);
        }
        return verifyUpdateManifest(await manifestResponse.text(), await signatureResponse.text(), this.publicKey);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "未知错误");
      }
    }
    throw new Error(`检查更新失败：${failures.join("；")}`);
  }

  private async downloadInstaller(manifest: UpdateManifest): Promise<string> {
    await mkdir(this.updatesDir, { recursive: true });
    const filename = `OzonGMV-Setup-${manifest.version}.exe`;
    const targetPath = join(this.updatesDir, filename);
    const partialPath = `${targetPath}.part`;
    if (await existingSize(partialPath) > manifest.size) {
      await writeFile(partialPath, new Uint8Array());
    }

    const failures: string[] = [];
    for (const source of manifest.urls) {
      try {
        await this.downloadFromSource(source, partialPath, manifest.size);
        const size = await existingSize(partialPath);
        const hash = await sha256File(partialPath);
        if (size !== manifest.size || hash !== manifest.sha256) {
          await writeFile(partialPath, new Uint8Array());
          throw new Error("更新包大小或 SHA-256 校验失败");
        }
        await unlink(targetPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        });
        await rename(partialPath, targetPath);
        await this.log(`Verified installer ${filename} (${manifest.size} bytes, ${manifest.sha256}).`);
        return targetPath;
      } catch (error) {
        failures.push(error instanceof Error ? error.message : "未知错误");
      }
    }
    throw new Error(`下载安装包失败：${failures.join("；")}`);
  }

  private async downloadFromSource(source: string, partialPath: string, expectedSize: number): Promise<void> {
    let offset = await existingSize(partialPath);
    if (offset === expectedSize) {
      this.state = { ...this.state, downloadedBytes: offset };
      return;
    }
    const response = await this.proxySettings.createFetch()(source, {
      ...(offset > 0 ? { headers: { Range: `bytes=${offset}-` } } : {}),
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.status === 416 && offset === expectedSize) {
      return;
    }
    if (!response.ok || (offset > 0 && response.status !== 206 && response.status !== 200)) {
      throw new Error(`下载源返回 HTTP ${response.status}`);
    }
    if (offset > 0 && response.status === 200) {
      await writeFile(partialPath, new Uint8Array());
      offset = 0;
    }
    if (!response.body) {
      throw new Error("下载源没有返回文件内容");
    }

    const output = await open(partialPath, offset > 0 ? "a" : "w");
    let downloaded = offset;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        downloaded += chunk.byteLength;
        if (downloaded > expectedSize) {
          throw new Error("下载内容超过清单声明大小");
        }
        await output.write(chunk);
        this.state = { ...this.state, downloadedBytes: downloaded };
      }
    } finally {
      await output.close();
    }
  }

  private async reconcilePendingUpdate(): Promise<void> {
    const pendingPath = join(this.updatesDir, PENDING_FILE);
    try {
      const pending = JSON.parse(await readFile(pendingPath, "utf8")) as PendingUpdate;
      const succeeded = compareVersions(this.config.APP_VERSION, pending.version) >= 0;
      const result: UpdateResult = {
        version: pending.version,
        status: succeeded ? "succeeded" : "failed",
        finishedAt: this.now().toISOString(),
        message: succeeded ? "更新已完成" : "新版本未能启动，安装器已恢复旧版本",
      };
      await this.writeJsonAtomically(join(this.updatesDir, RESULT_FILE), result);
      await unlink(pendingPath);
      await this.log(`${result.status}: ${result.version} - ${result.message}`);
      if (succeeded) {
        this.state = { ...this.state, state: this.state.supported ? "up-to-date" : "unsupported" };
      } else {
        this.state = { ...this.state, state: "failed", error: result.message };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.log(`Pending update reconciliation failed: ${String(error)}`);
      }
    }
  }

  private async cleanupExpiredFiles(): Promise<void> {
    const cutoff = this.now().getTime() - RETENTION_MS;
    for (const entry of await readdir(this.updatesDir, { withFileTypes: true })) {
      if (!entry.isFile() || [PENDING_FILE, RESULT_FILE, LOG_FILE].includes(entry.name)) {
        continue;
      }
      const path = join(this.updatesDir, entry.name);
      if ((await stat(path)).mtimeMs < cutoff) {
        await unlink(path);
      }
    }
  }

  private async fail(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "更新任务失败";
    await this.log(`failed: ${message}`);
    // Only expose the terminal state after all failure side effects are durable.
    this.state = { ...this.state, state: "failed", error: message };
  }

  private async writeJsonAtomically(path: string, value: unknown): Promise<void> {
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }

  private async log(message: string): Promise<void> {
    await mkdir(this.updatesDir, { recursive: true });
    await appendFile(join(this.updatesDir, LOG_FILE), `${this.now().toISOString()} ${message}\n`, "utf8");
  }
}
