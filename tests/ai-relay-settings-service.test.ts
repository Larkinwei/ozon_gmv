import { describe, expect, it } from "vitest";

import { AiRelaySettingsService } from "../src/server/services/ai-relay-settings-service";
import { createTestDatabase } from "./test-context";

describe("AI Relay settings", () => {
  it("persists the LAN address and encrypts the access key", async () => {
    const context = createTestDatabase();
    const calls: string[] = [];
    const fetchImplementation = (async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input).endsWith("/health")) return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      const service = new AiRelaySettingsService(context.config, context.database, fetchImplementation);
      expect(service.view()).toMatchObject({ baseUrl: "http://127.0.0.1:4000", modelAlias: "text.quality", apiKeyConfigured: false });
      service.update({ baseUrl: "http://192.168.1.50:4000/", apiKey: "relay-secret", modelAlias: "deepseek.deepseek-chat", timeoutMs: 45_000 });
      expect(service.view()).toMatchObject({ baseUrl: "http://192.168.1.50:4000", modelAlias: "deepseek.deepseek-chat", apiKeyConfigured: true });
      await service.test();
      expect(calls).toEqual(["GET http://192.168.1.50:4000/health", "GET http://192.168.1.50:4000/v1/models"]);
      expect(context.database.prepare("SELECT value FROM app_settings WHERE key = ?").get("ai.relay.api_key_ciphertext")).not.toMatchObject({ value: "relay-secret" });
    } finally {
      context.cleanup();
    }
  });

  it("can update the address while keeping the saved key", () => {
    const context = createTestDatabase();
    try {
      const service = new AiRelaySettingsService(context.config, context.database);
      service.update({ baseUrl: "http://192.168.1.50:4000", apiKey: "relay-secret", modelAlias: "text.quality", timeoutMs: 45_000 });
      service.update({ baseUrl: "http://192.168.1.51:4000", modelAlias: "text.quality", timeoutMs: 60_000 });
      expect(service.view()).toMatchObject({ baseUrl: "http://192.168.1.51:4000", apiKeyConfigured: true, timeoutMs: 60_000 });
    } finally {
      context.cleanup();
    }
  });
});

