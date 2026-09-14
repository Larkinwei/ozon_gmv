import type { AiTextRequest } from "../gateway-client";

/** Builds the provider-neutral request for unrestricted day-to-day conversation. */
export function createGeneralChatRequest(input: { history: Array<{ role: "user" | "assistant"; content: string }>; request: string }): AiTextRequest {
  return {
    messages: [
      { role: "system", content: "你是 GMV 工作台中的通用 AI 助手。可以进行日常聊天、解释问题和协助思考。不要强制用户填写商品信息，不要调用外部工具。" },
      { role: "user", content: JSON.stringify({ conversationHistory: input.history, request: input.request }) },
    ],
  };
}
