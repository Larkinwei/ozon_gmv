import type { AppConfig } from "../config";

export interface AiStructuredRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface AiTextRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export interface AiTextStreamChunk {
  text: string;
  requestId: string | null;
  actualModel: string | null;
  usage: unknown;
}

export interface AiStructuredResponse {
  value: unknown;
  requestId: string | null;
  actualModel: string | null;
  usage: unknown;
}

export interface AiGatewayClient {
  generateStructured(request: AiStructuredRequest, signal?: AbortSignal): Promise<AiStructuredResponse>;
  streamText(request: AiTextRequest, signal?: AbortSignal): AsyncIterable<AiTextStreamChunk>;
  checkHealth(): Promise<boolean>;
}

export class AiGatewayError extends Error {
  public constructor(public readonly code: "UNAVAILABLE" | "UNAUTHORIZED" | "RATE_LIMITED" | "UPSTREAM_ERROR" | "INVALID_RESPONSE", message: string) {
    super(message);
    this.name = "AiGatewayError";
  }
}

/** Small HTTP seam around the local OpenAI-compatible relay. */
export class HttpAiGatewayClient implements AiGatewayClient {
  public constructor(private readonly config: AppConfig, private readonly fetchImplementation: typeof fetch = fetch) {}

  public async checkHealth(): Promise<boolean> {
    try {
      const response = await this.fetchWithTimeout(`${this.config.AI_RELAY_BASE_URL}/health`, { method: "GET" });
      return response.ok;
    } catch {
      return false;
    }
  }

  public async generateStructured(request: AiStructuredRequest, signal?: AbortSignal): Promise<AiStructuredResponse> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.config.AI_RELAY_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.config.AI_RELAY_API_KEY ? { Authorization: `Bearer ${this.config.AI_RELAY_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.AI_RELAY_MODEL_ALIAS,
          messages: [
            { role: "system", content: `Return only valid JSON matching this schema: ${JSON.stringify(request.schema)}` },
            ...request.messages,
          ],
          temperature: 0.7,
          response_format: { type: "json_object" },
        }),
      }, signal);
    } catch {
      if (signal?.aborted) throw new DOMException("The request was aborted", "AbortError");
      throw new AiGatewayError("UNAVAILABLE", "AI Relay 不可用，请确认本机服务已启动");
    }

    if (response.status === 401 || response.status === 403) {
      throw new AiGatewayError("UNAUTHORIZED", "AI Relay 密钥无效或未配置");
    }
    if (response.status === 429) {
      throw new AiGatewayError("RATE_LIMITED", "AI Relay 请求过于频繁，请稍后重试");
    }
    if (!response.ok) {
      throw new AiGatewayError("UPSTREAM_ERROR", `AI Relay 请求失败（${response.status}）`);
    }

    const payload = await response.json().catch(() => null) as {
      id?: string;
      model?: string;
      usage?: unknown;
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new AiGatewayError("INVALID_RESPONSE", "AI Relay 返回了无法解析的结果");
    }
    try {
      return { value: JSON.parse(content), requestId: payload?.id ?? null, actualModel: payload?.model ?? null, usage: payload?.usage ?? null };
    } catch {
      throw new AiGatewayError("INVALID_RESPONSE", "AI Relay 返回的 JSON 无效");
    }
  }

  public async *streamText(request: AiTextRequest, signal?: AbortSignal): AsyncIterable<AiTextStreamChunk> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(`${this.config.AI_RELAY_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Accept": "text/event-stream",
          "Content-Type": "application/json",
          ...(this.config.AI_RELAY_API_KEY ? { Authorization: `Bearer ${this.config.AI_RELAY_API_KEY}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.AI_RELAY_MODEL_ALIAS,
          messages: request.messages,
          temperature: 0.7,
          stream: true,
          stream_options: { include_usage: true },
        }),
      }, signal);
    } catch {
      if (signal?.aborted) throw new DOMException("The request was aborted", "AbortError");
      throw new AiGatewayError("UNAVAILABLE", "AI Relay 不可用，请确认本机服务已启动");
    }

    if (response.status === 401 || response.status === 403) {
      throw new AiGatewayError("UNAUTHORIZED", "AI Relay 密钥无效或未配置");
    }
    if (response.status === 429) {
      throw new AiGatewayError("RATE_LIMITED", "AI Relay 请求过于频繁，请稍后重试");
    }
    if (!response.ok) {
      throw new AiGatewayError("UPSTREAM_ERROR", `AI Relay 请求失败（${response.status}）`);
    }
    if (!response.body) {
      throw new AiGatewayError("INVALID_RESPONSE", "AI Relay 没有返回流式内容");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const chunk = parseStreamChunk(line);
          if (chunk) yield chunk;
        }
      }
      buffer += decoder.decode();
      const finalChunk = parseStreamChunk(buffer);
      if (finalChunk) yield finalChunk;
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      throw new AiGatewayError("UNAVAILABLE", "AI Relay 流式连接已中断");
    } finally {
      reader.releaseLock();
    }
  }

  private async fetchWithTimeout(input: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.config.AI_RELAY_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    return this.fetchImplementation(input, { ...init, signal: requestSignal });
  }
}

function parseStreamChunk(line: string): AiTextStreamChunk | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const payload = JSON.parse(data) as {
      id?: string;
      model?: string;
      usage?: unknown;
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    const text = payload.choices?.[0]?.delta?.content;
    return {
      text: typeof text === "string" ? text : "",
      requestId: payload.id ?? null,
      actualModel: payload.model ?? null,
      usage: payload.usage ?? null,
    };
  } catch {
    throw new AiGatewayError("INVALID_RESPONSE", "AI Relay 返回了无法解析的流式内容");
  }
}
