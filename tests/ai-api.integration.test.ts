import { describe, expect, it } from "vitest";

import { buildAdminApp } from "../src/server/app";
import type { AiGatewayClient } from "../src/server/ai/gateway-client";
import type { AiConversationStreamEvent } from "../src/shared/contracts";
import { PostingsRepository } from "../src/server/db/postings-repository";
import { ProductImagesRepository } from "../src/server/db/product-images-repository";
import { SettingsRepository } from "../src/server/db/settings-repository";
import { StoresRepository } from "../src/server/db/stores-repository";
import { SyncCheckpointsRepository } from "../src/server/db/sync-checkpoints-repository";
import { DashboardEventBus } from "../src/server/realtime/event-bus";
import { ProxySettingsService } from "../src/server/services/proxy-settings-service";
import { ProductImageService } from "../src/server/services/product-image-service";
import { SyncService } from "../src/server/services/sync-service";
import { UpdateService } from "../src/server/services/update-service";
import { createTestDatabase } from "./test-context";

const candidate = (index: number) => ({
  prompt: `prompt-${index}`, negativePrompt: "distorted product", subjectProtection: ["keep shape"], composition: "center", lighting: "soft", background: "home", style: "photo", aspectRatio: "1:1", intendedUse: "场景图", warnings: [],
});

function parseEvents(body: string): AiConversationStreamEvent[] {
  return body.split("\n\n").filter(Boolean).map((block) => {
    const event = block.match(/^event: (.+)$/m)?.[1] ?? "";
    const data = block.match(/^data: (.+)$/m)?.[1] ?? "{}";
    return { type: event, data: JSON.parse(data) } as AiConversationStreamEvent;
  });
}

describe("AI workbench API", () => {
  it("protects the registry, persists a conversation, and validates structured output", async () => {
    const context = createTestDatabase();
    const events = new DashboardEventBus();
    const settings = new SettingsRepository(context.database);
    settings.set("network.proxy_mode", "direct");
    const proxySettings = new ProxySettingsService(context.config, settings);
    const syncService = new SyncService(context.config, new StoresRepository(context.database), new PostingsRepository(context.database), new SyncCheckpointsRepository(context.database), events, proxySettings, new ProductImageService(new ProductImagesRepository(context.database)));
    const gateway: AiGatewayClient = {
      checkHealth: async () => true,
      generateStructured: async () => ({ value: { candidates: [candidate(1), candidate(2), candidate(3)] }, requestId: "req-test", actualModel: "gpt-test", usage: { total_tokens: 12 } }),
      async *streamText() {
        yield { text: "你好，", requestId: "req-chat", actualModel: "gpt-test", usage: null };
        yield { text: "我可以陪你聊天。", requestId: "req-chat", actualModel: "gpt-test", usage: { total_tokens: 8 } };
      },
    };
    const app = await buildAdminApp({ config: context.config, database: context.database, events, syncService, proxySettings, updates: new UpdateService(context.config, proxySettings), aiGateway: gateway });
    try {
      expect((await app.inject({ method: "GET", url: "/api/ai/apps" })).statusCode).toBe(401);
      const setup = await app.inject({ method: "POST", url: "/api/setup/initialize", payload: { username: "admin", password: "correct-horse-battery-staple" } });
      const cookie = setup.cookies.find((item) => item.name === "ozon_session")?.value ?? "";
      const apps = await app.inject({ method: "GET", url: "/api/ai/apps", cookies: { ozon_session: cookie } });
      expect(apps.json().applications).toEqual(expect.arrayContaining([expect.objectContaining({ id: "product-image-prompt", status: "enabled" }), expect.objectContaining({ id: "product-listing", status: "coming_soon" })]));
      const created = await app.inject({ method: "POST", url: "/api/ai/conversations", cookies: { ozon_session: cookie }, payload: { applicationId: "product-image-prompt", productContext: { name: "收纳盒", category: "家居", attributes: {}, material: "塑料", color: "白色", targetMarket: "俄罗斯", imagePurpose: "场景图", style: "真实电商摄影", aspectRatio: "1:1" } } });
      expect(created.statusCode).toBe(201);
      const generated = await app.inject({ method: "POST", url: `/api/ai/conversations/${created.json().id}/messages`, cookies: { ozon_session: cookie }, payload: { content: "生成三套生活场景图提示词" } });
      expect(generated.statusCode).toBe(200);
      const productEvents = parseEvents(generated.body);
      expect(productEvents.map((event) => event.type)).toEqual(["run_started", "user_message", "status", "completed"]);
      const productCompleted = productEvents.find((event): event is Extract<AiConversationStreamEvent, { type: "completed" }> => event.type === "completed");
      expect(productCompleted?.data.conversation.messages.at(-1)?.content).toHaveProperty("candidates");
      expect((productCompleted?.data.conversation.messages.at(-1)?.content as { candidates: unknown[] }).candidates).toHaveLength(3);
      const chatCreated = await app.inject({ method: "POST", url: "/api/ai/conversations", cookies: { ozon_session: cookie }, payload: { applicationId: "general-chat" } });
      expect(chatCreated.statusCode).toBe(201);
      const chatReply = await app.inject({ method: "POST", url: `/api/ai/conversations/${chatCreated.json().id}/messages`, cookies: { ozon_session: cookie }, payload: { content: "你好" } });
      expect(chatReply.statusCode).toBe(200);
      const chatEvents = parseEvents(chatReply.body);
      expect(chatEvents.map((event) => event.type)).toEqual(["run_started", "user_message", "status", "delta", "delta", "completed"]);
      expect(chatEvents.filter((event) => event.type === "delta").map((event) => event.data.text).join("")).toBe("你好，我可以陪你聊天。");
      expect((await app.inject({ method: "GET", url: "/api/ai/conversations", cookies: { ozon_session: cookie } })).json()).toHaveLength(2);
    } finally {
      await app.close();
      context.cleanup();
    }
  });
});
