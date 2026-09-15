import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/server/config";
import { HttpAiGatewayClient } from "../src/server/ai/gateway-client";

const config = {
  AI_RELAY_BASE_URL: "http://relay.test",
  AI_RELAY_API_KEY: "relay-key",
  AI_RELAY_MODEL_ALIAS: "text.quality",
  AI_RELAY_TIMEOUT_MS: 5000,
} as AppConfig;

function streamedResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("HttpAiGatewayClient streaming", () => {
  it("sends stream=true and parses SSE JSON split across network chunks", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return streamedResponse([
        'data: {"id":"req-1","model":"deepseek-test","choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"id":"req-1","model":"deepseek-test","choices":[{"delta":{"content":"好"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    };
    const client = new HttpAiGatewayClient(config, fetchImplementation);
    const chunks = [];
    for await (const chunk of client.streamText({ applicationId: "general-chat", messages: [{ role: "user", content: "你好" }] })) chunks.push(chunk);

    expect(requestBody).toMatchObject({ stream: true });
    expect(requestBody).not.toHaveProperty("model");
    expect(chunks.map((chunk) => chunk.text).join("")).toBe("你好");
    expect(chunks.at(-1)).toMatchObject({ requestId: "req-1", actualModel: "deepseek-test" });
  });

  it("maps Relay authorization failures to an actionable gateway error", async () => {
    const client = new HttpAiGatewayClient(config, async () => streamedResponse([], 401));
    const stream = client.streamText({ applicationId: "general-chat", messages: [{ role: "user", content: "你好" }] });

    await expect((async () => {
      for await (const _chunk of stream) {
        // Consume the stream to trigger the HTTP status check.
      }
    })()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
