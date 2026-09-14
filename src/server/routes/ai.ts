import { Readable } from "node:stream";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { listAiApplications } from "../ai/application-registry";
import type { AiConversationModule } from "../ai/conversation-module";
import { aiProductContextSchema } from "../ai/prompt-schemas";
import type { AiRelayStatusView } from "../../shared/contracts";
import type { AiProductSourceView } from "../../shared/contracts";
import type { AiConversationStreamEvent } from "../../shared/contracts";
import { readSession, requireSession } from "../security/session";

const idParamsSchema = z.object({ id: z.string().uuid() });
const createConversationSchema = z.object({ applicationId: z.string().min(1), productContext: aiProductContextSchema.default({ name: "", category: "", attributes: {}, material: "", color: "", targetMarket: "", imagePurpose: "场景图", style: "真实电商摄影", aspectRatio: "1:1" }) });
const messageSchema = z.object({ content: z.string() });

function sessionUsername(request: Parameters<typeof readSession>[0]): string {
  return readSession(request) ?? "";
}

/** Registers the authenticated AI workbench API; no provider API key reaches the browser. */
export function registerAiRoutes(app: FastifyInstance, conversations: AiConversationModule, checkRelay: () => Promise<boolean>, modelAlias: string, listSources: () => AiProductSourceView[]): void {
  app.get("/api/ai/apps", { preHandler: requireSession }, async () => ({ applications: listAiApplications() }));
  app.get("/api/ai/status", { preHandler: requireSession }, async (): Promise<AiRelayStatusView> => ({ available: await checkRelay(), modelAlias }));
  app.get("/api/ai/sources", { preHandler: requireSession }, async () => ({ sources: listSources() }));

  app.post("/api/ai/conversations", { preHandler: requireSession }, async (request, reply) => {
    const input = createConversationSchema.parse(request.body);
    return reply.code(201).send(conversations.createConversation(input.applicationId, input.productContext, sessionUsername(request)));
  });

  app.get("/api/ai/conversations", { preHandler: requireSession }, async (request) => conversations.listConversations(sessionUsername(request)));

  app.get("/api/ai/conversations/:id", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const conversation = conversations.getConversation(id, sessionUsername(request));
    if (!conversation) return reply.code(404).send({ error: "AI_CONVERSATION_NOT_FOUND", message: "对话不存在" });
    return conversation;
  });

  app.post("/api/ai/conversations/:id/messages", { preHandler: requireSession }, async (request, reply) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = messageSchema.parse(request.body);
    const username = sessionUsername(request);
    if (!conversations.getConversation(id, username)) return reply.code(404).send({ error: "AI_CONVERSATION_NOT_FOUND", message: "对话不存在" });

    const abortController = new AbortController();
    const abortOnDisconnect = (): void => {
      if (!reply.raw.writableEnded) abortController.abort();
    };
    const stream = Readable.from(encodeAiEvents(conversations.streamMessage(id, username, input.content, abortController.signal)));
    const cleanup = (): void => {
      request.raw.removeListener("aborted", abortOnDisconnect);
      reply.raw.removeListener("close", abortOnDisconnect);
    };
    request.raw.once("aborted", abortOnDisconnect);
    reply.raw.once("close", abortOnDisconnect);
    stream.once("close", cleanup);
    return reply
      .type("text/event-stream; charset=utf-8")
      .header("Cache-Control", "no-cache, no-transform")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no")
      .send(stream);
  });
}

async function* encodeAiEvents(events: AsyncIterable<AiConversationStreamEvent>): AsyncIterable<string> {
  const iterator = events[Symbol.asyncIterator]();
  let nextEvent = iterator.next();
  try {
    while (true) {
      const result = await Promise.race([
        nextEvent.then((value) => ({ kind: "event" as const, value })),
        new Promise<{ kind: "heartbeat" }>((resolve) => setTimeout(() => resolve({ kind: "heartbeat" }), 15_000)),
      ]);
      if (result.kind === "heartbeat") {
        yield ": keep-alive\n\n";
        continue;
      }
      if (result.value.done) return;
      const event = result.value.value;
      yield `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
      nextEvent = iterator.next();
    }
  } finally {
    await iterator.return?.();
  }
}
