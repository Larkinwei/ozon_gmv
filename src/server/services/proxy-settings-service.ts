import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

import type { NetworkSettingsView, ProxyMode, ProxyTestResult } from "../../shared/contracts";
import type { AppConfig } from "../config";
import type { SettingsRepository } from "../db/settings-repository";
import { decryptSecret, encryptSecret } from "../security/encryption";

const MODE_KEY = "network.proxy_mode";
const MANUAL_PROXY_KEY = "network.manual_proxy_ciphertext";
const DETECTED_PROXY_KEY = "network.detected_proxy_ciphertext";

interface DetectedProxyFile {
  proxy?: string;
}

function normalizeProxyUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("代理地址只支持 HTTP 或 HTTPS 协议");
  }
  if (!url.hostname) {
    throw new Error("代理地址缺少主机名");
  }
  return url.toString();
}

function safeProxyLabel(value: string | null): { label: string | null; hasCredentials: boolean } {
  if (!value) {
    return { label: null, hasCredentials: false };
  }
  const url = new URL(value);
  const hasCredentials = Boolean(url.username || url.password);
  url.username = hasCredentials ? "***" : "";
  url.password = "";
  return { label: url.toString(), hasCredentials };
}

/** Owns persisted proxy selection and creates the dispatcher used by every Ozon request. */
export class ProxySettingsService {
  private cachedProxy: string | null | undefined;
  private cachedFetch: typeof fetch | undefined;
  private cachedDispatcher: Dispatcher | undefined;

  public constructor(
    private readonly config: AppConfig,
    private readonly settings: SettingsRepository,
  ) {
    this.initializeDetectedProxy();
  }

  public view(): NetworkSettingsView {
    const manual = this.readSecret(MANUAL_PROXY_KEY);
    const detected = this.readSecret(DETECTED_PROXY_KEY);
    const manualLabel = safeProxyLabel(manual);
    return {
      mode: this.mode(),
      manualProxy: manualLabel.label,
      detectedProxy: safeProxyLabel(detected).label,
      hasManualCredentials: manualLabel.hasCredentials,
    };
  }

  public update(mode: ProxyMode, manualProxy?: string): NetworkSettingsView {
    if (mode === "manual" && manualProxy !== undefined) {
      this.settings.set(MANUAL_PROXY_KEY, encryptSecret(normalizeProxyUrl(manualProxy), this.config.ENCRYPTION_KEY));
    }
    if (mode === "manual" && !this.readSecret(MANUAL_PROXY_KEY)) {
      throw new Error("手动代理模式需要填写代理地址");
    }
    this.settings.set(MODE_KEY, mode);
    this.invalidateDispatcher();
    return this.view();
  }

  public createFetch(): typeof fetch {
    const proxy = this.activeProxy();
    if (proxy === this.cachedProxy && this.cachedFetch) {
      return this.cachedFetch;
    }
    this.invalidateDispatcher();
    this.cachedProxy = proxy;
    if (!proxy) {
      this.cachedFetch = fetch;
      return this.cachedFetch;
    }
    const dispatcher = new ProxyAgent(proxy);
    this.cachedDispatcher = dispatcher;
    this.cachedFetch = ((input: URL | RequestInfo, init?: RequestInit) =>
      undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...(init as Parameters<typeof undiciFetch>[1]),
        dispatcher,
      }) as unknown as Promise<Response>) as typeof fetch;
    return this.cachedFetch;
  }

  /** Confirms that the selected path can reach Ozon, even when credentials are intentionally absent. */
  public async test(): Promise<ProxyTestResult> {
    const startedAt = Date.now();
    const mode = this.mode();
    const proxy = safeProxyLabel(this.activeProxy()).label;
    const response = await this.createFetch()(new URL("/v1/roles", this.config.OZON_API_BASE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 407 || response.status >= 500) {
      throw new Error(`代理或 Ozon 网关返回 HTTP ${response.status}`);
    }
    return {
      ok: true,
      mode,
      proxy,
      latencyMs: Date.now() - startedAt,
      message: `已连接 Ozon（HTTP ${response.status}）`,
    };
  }

  private mode(): ProxyMode {
    const value = this.settings.get(MODE_KEY);
    return value === "manual" || value === "direct" ? value : "auto";
  }

  private activeProxy(): string | null {
    const mode = this.mode();
    if (mode === "direct") {
      return null;
    }
    return this.readSecret(mode === "manual" ? MANUAL_PROXY_KEY : DETECTED_PROXY_KEY);
  }

  private readSecret(key: string): string | null {
    const ciphertext = this.settings.get(key);
    return ciphertext ? decryptSecret(ciphertext, this.config.ENCRYPTION_KEY) : null;
  }

  private initializeDetectedProxy(): void {
    if (this.settings.get(DETECTED_PROXY_KEY)) {
      return;
    }
    const detectedFile = join(this.config.DATA_DIR, "config", "detected-proxy.json");
    let proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? null;
    if (!proxy && existsSync(detectedFile)) {
      const parsed = JSON.parse(readFileSync(detectedFile, "utf8")) as DetectedProxyFile;
      proxy = parsed.proxy ?? null;
    }
    if (proxy) {
      this.settings.set(DETECTED_PROXY_KEY, encryptSecret(normalizeProxyUrl(proxy), this.config.ENCRYPTION_KEY));
    }
  }

  private invalidateDispatcher(): void {
    if (this.cachedDispatcher) {
      void this.cachedDispatcher.close().catch(() => undefined);
    }
    this.cachedDispatcher = undefined;
    this.cachedFetch = undefined;
    this.cachedProxy = undefined;
  }
}
