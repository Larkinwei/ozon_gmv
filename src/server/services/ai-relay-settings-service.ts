import type { AiRelaySettingsView, AiRelayTestResult } from "../../shared/contracts";
import type { AppConfig } from "../config";
import type { AppDatabase } from "../db/database";
import { SettingsRepository } from "../db/settings-repository";
import { decryptSecret, encryptSecret } from "../security/encryption";

const BASE_URL_KEY = "ai.relay.base_url";
const API_KEY_KEY = "ai.relay.api_key_ciphertext";
const MODEL_ALIAS_KEY = "ai.relay.model_alias";
const TIMEOUT_MS_KEY = "ai.relay.timeout_ms";

export interface AiRelaySettingsUpdateInput {
  baseUrl: string;
  apiKey?: string | undefined;
  modelAlias: string;
  timeoutMs: number;
}

export interface AiRelayRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  modelAlias: string;
  timeoutMs: number;
}

function maskCredential(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}${"•".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("AI Relay 地址只支持 HTTP 或 HTTPS 协议");
  }
  if (url.username || url.password) {
    throw new Error("AI Relay 地址不能包含用户名或密码");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/** Persists the local AI Relay connection without exposing its key to the browser. */
export class AiRelaySettingsService {
  private readonly settings: SettingsRepository;

  public constructor(
    private readonly config: AppConfig,
    database: AppDatabase,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.settings = new SettingsRepository(database);
  }

  public view(): AiRelaySettingsView {
    const runtime = this.runtime();
    return {
      baseUrl: runtime.baseUrl,
      apiKeyConfigured: Boolean(runtime.apiKey),
      apiKeyMasked: runtime.apiKey ? maskCredential(runtime.apiKey) : null,
      modelAlias: runtime.modelAlias,
      timeoutMs: runtime.timeoutMs,
    };
  }

  public update(input: AiRelaySettingsUpdateInput): AiRelaySettingsView {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const modelAlias = input.modelAlias.trim();
    const currentApiKey = this.runtime().apiKey;
    if (!modelAlias) throw new Error("模型别名不能为空");
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 5_000 || input.timeoutMs > 300_000) {
      throw new Error("超时时间必须在 5000 到 300000 毫秒之间");
    }
    if (!input.apiKey?.trim() && !currentApiKey) throw new Error("首次配置必须填写 AI Relay 访问 Key");

    this.settings.set(BASE_URL_KEY, baseUrl);
    this.settings.set(MODEL_ALIAS_KEY, modelAlias);
    this.settings.set(TIMEOUT_MS_KEY, String(input.timeoutMs));
    if (input.apiKey?.trim()) {
      this.settings.set(API_KEY_KEY, encryptSecret(input.apiKey.trim(), this.config.ENCRYPTION_KEY));
    }
    return this.view();
  }

  public runtime(): AiRelayRuntimeConfig {
    const encryptedApiKey = this.settings.get(API_KEY_KEY);
    return {
      baseUrl: this.settings.get(BASE_URL_KEY) ?? this.config.AI_RELAY_BASE_URL,
      apiKey: encryptedApiKey ? decryptSecret(encryptedApiKey, this.config.ENCRYPTION_KEY) : this.config.AI_RELAY_API_KEY,
      modelAlias: this.settings.get(MODEL_ALIAS_KEY) ?? this.config.AI_RELAY_MODEL_ALIAS,
      timeoutMs: Number(this.settings.get(TIMEOUT_MS_KEY) ?? this.config.AI_RELAY_TIMEOUT_MS),
    };
  }

  /** Checks both LAN reachability and the authenticated Relay API. */
  public async test(): Promise<AiRelayTestResult> {
    const runtime = this.runtime();
    const signal = AbortSignal.timeout(Math.min(runtime.timeoutMs, 15_000));
    try {
      const health = await this.fetchImplementation(`${runtime.baseUrl}/health`, { method: "GET", signal });
      if (!health.ok) throw new Error(`健康检查失败（HTTP ${health.status}）`);
      const response = await this.fetchImplementation(`${runtime.baseUrl}/v1/models`, {
        method: "GET",
        ...(runtime.apiKey ? { headers: { Authorization: `Bearer ${runtime.apiKey}` } } : {}),
        signal,
      });
      if (response.status === 401 || response.status === 403) throw new Error("AI Relay 访问 Key 无效");
      if (!response.ok) throw new Error(`API 检查失败（HTTP ${response.status}）`);
      return { ok: true, message: `AI Relay 连接正常，当前模型：${runtime.modelAlias}` };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("健康检查失败")) throw error;
      if (error instanceof Error && error.message.endsWith("无效")) throw error;
      if (error instanceof Error && error.message.startsWith("API 检查失败")) throw error;
      throw new Error("无法连接 AI Relay，请检查地址、端口和局域网防火墙");
    }
  }
}
