import { createHash, randomUUID } from "node:crypto";

import type { AiConversationStreamEvent, AiConversationView, AiMessageView, AiProductContext } from "../../shared/contracts";
import type { AppDatabase } from "../db/database";
import { getAiApplication } from "./application-registry";
import { createGeneralChatRequest } from "./applications/general-chat";
import { generateProductImagePrompts } from "./applications/product-image-prompt";
import type { AiGatewayClient } from "./gateway-client";
import { AiGatewayError } from "./gateway-client";

interface ConversationRow { id: string; application_id: string; title: string; product_context_json: string; created_by: string; created_at_ms: number; updated_at_ms: number }
interface MessageRow { id: string; conversation_id: string; role: "user" | "assistant"; content_json: string; run_id: string | null; created_at_ms: number }

/** Owns AI conversation persistence and dispatches only registered workflows. */
export class AiConversationModule {
  public constructor(private readonly database: AppDatabase, private readonly gateway: AiGatewayClient) {}

  public createConversation(applicationId: string, productContext: AiProductContext, username: string): AiConversationView {
    const application = getAiApplication(applicationId);
    if (!application || application.status !== "enabled") throw new Error("AI 应用尚未上线");
    const now = Date.now();
    const id = randomUUID();
    this.database.prepare("INSERT INTO ai_conversations (id, application_id, title, product_context_json, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, applicationId, productContext.name || application.name, JSON.stringify(productContext), username, now, now);
    return this.getConversation(id, username) as AiConversationView;
  }

  public listConversations(username: string): AiConversationView[] {
    const rows = this.database.prepare<unknown[], ConversationRow>("SELECT * FROM ai_conversations WHERE created_by = ? ORDER BY updated_at_ms DESC").all(username);
    return rows.map((row) => this.toConversation(row, []));
  }

  public getConversation(id: string, username: string): AiConversationView | null {
    const row = this.database.prepare<unknown[], ConversationRow>("SELECT * FROM ai_conversations WHERE id = ? AND created_by = ?").get(id, username);
    if (!row) return null;
    const messages = this.database.prepare<unknown[], MessageRow>("SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at_ms ASC").all(id).map((message) => this.toMessage(message));
    return this.toConversation(row, messages);
  }

  /** Streams one registered application run and commits its final business message. */
  public async *streamMessage(id: string, username: string, request: string, signal?: AbortSignal): AsyncIterable<AiConversationStreamEvent> {
    const conversation = this.getConversation(id, username);
    if (!conversation) throw new Error("对话不存在");

    const runId = randomUUID();
    const now = Date.now();
    const history = conversation.messages.map((message) => ({ role: message.role, content: "text" in message.content ? message.content.text : JSON.stringify(message.content) }));
    const userMessage = this.insertUserMessage(id, request, now);
    const inputHash = createHash("sha256").update(JSON.stringify({ applicationId: conversation.applicationId, productContext: conversation.productContext, history, request })).digest("hex");
    this.database.prepare("INSERT INTO ai_runs (id, workflow_name, workflow_version, model_alias, status, input_hash, created_at_ms) VALUES (?, ?, ?, ?, 'running', ?, ?)").run(runId, conversation.applicationId, "r0", "text.quality", inputHash, now);

    let assistantText = "";
    let assistantSaved = false;
    yield { type: "run_started", data: { runId } };
    yield { type: "user_message", data: { message: userMessage } };
    yield { type: "status", data: { status: "thinking", label: "正在思考…" } };

    try {
      if (conversation.applicationId === "product-image-prompt") {
        const result = await generateProductImagePrompts(this.gateway, { productContext: conversation.productContext, history, request }, signal);
        this.database.prepare("UPDATE ai_runs SET status = 'completed', actual_model = ?, output_json = ?, usage_json = ?, request_id = ? WHERE id = ?").run(result.actualModel, JSON.stringify({ candidates: result.candidates }), JSON.stringify(result.usage), result.requestId, runId);
        this.insertAssistantMessage(id, { candidates: result.candidates }, runId);
        assistantSaved = true;
      } else if (conversation.applicationId === "general-chat") {
        let requestId: string | null = null;
        let actualModel: string | null = null;
        let usage: unknown = null;
        for await (const chunk of this.gateway.streamText(createGeneralChatRequest({ history, request }), signal)) {
          requestId = chunk.requestId ?? requestId;
          actualModel = chunk.actualModel ?? actualModel;
          usage = chunk.usage ?? usage;
          if (!chunk.text) continue;
          assistantText += chunk.text;
          yield { type: "delta", data: { text: chunk.text } };
        }
        if (!assistantText) throw new AiGatewayError("INVALID_RESPONSE", "AI Relay 没有返回有效文本");
        this.database.prepare("UPDATE ai_runs SET status = 'completed', actual_model = ?, output_json = ?, usage_json = ?, request_id = ? WHERE id = ?").run(actualModel, JSON.stringify({ reply: assistantText }), JSON.stringify(usage), requestId, runId);
        this.insertAssistantMessage(id, { text: assistantText }, runId);
        assistantSaved = true;
      } else {
        throw new Error("AI 应用尚未上线");
      }

      yield { type: "completed", data: { conversation: this.getConversation(id, username) as AiConversationView } };
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        this.finishInterruptedRun(runId, id, assistantText, assistantSaved, "aborted");
        yield { type: "aborted", data: { conversation: this.getConversation(id, username) as AiConversationView } };
      } else {
        const errorCode = error instanceof AiGatewayError ? error.code : "WORKFLOW_FAILED";
        this.finishInterruptedRun(runId, id, assistantText, assistantSaved, "failed", errorCode);
        yield { type: "error", data: { code: errorCode, message: error instanceof Error ? error.message : "AI 生成失败，请稍后重试" } };
      }
    } finally {
      this.database.prepare("UPDATE ai_conversations SET updated_at_ms = ? WHERE id = ?").run(Date.now(), id);
    }
  }

  private insertUserMessage(conversationId: string, text: string, createdAtMs: number): AiMessageView {
    const message: AiMessageView = { id: randomUUID(), conversationId, role: "user", content: { text }, runId: null, createdAtMs };
    this.database.prepare("INSERT INTO ai_messages (id, conversation_id, role, content_json, created_at_ms) VALUES (?, ?, 'user', ?, ?)").run(message.id, conversationId, JSON.stringify(message.content), createdAtMs);
    return message;
  }

  private insertAssistantMessage(conversationId: string, content: AiMessageView["content"], runId: string): void {
    this.database.prepare("INSERT INTO ai_messages (id, conversation_id, role, content_json, run_id, created_at_ms) VALUES (?, ?, 'assistant', ?, ?, ?)").run(randomUUID(), conversationId, JSON.stringify(content), runId, Date.now());
  }

  private finishInterruptedRun(runId: string, conversationId: string, assistantText: string, assistantSaved: boolean, status: "aborted" | "failed", errorCode?: string): void {
    if (assistantText && !assistantSaved) this.insertAssistantMessage(conversationId, { text: assistantText }, runId);
    this.database.prepare("UPDATE ai_runs SET status = ?, error_code = ?, output_json = ? WHERE id = ?").run(status, errorCode ?? null, assistantText ? JSON.stringify({ reply: assistantText }) : null, runId);
  }

  private toConversation(row: ConversationRow, messages: AiMessageView[]): AiConversationView {
    return { id: row.id, applicationId: row.application_id, title: row.title, productContext: JSON.parse(row.product_context_json) as AiProductContext, createdBy: row.created_by, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, messages };
  }

  private toMessage(row: MessageRow): AiMessageView {
    return { id: row.id, conversationId: row.conversation_id, role: row.role, content: JSON.parse(row.content_json) as AiMessageView["content"], runId: row.run_id, createdAtMs: row.created_at_ms };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
