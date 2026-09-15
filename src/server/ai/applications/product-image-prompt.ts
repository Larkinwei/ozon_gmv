import type { AiProductContext, AiPromptCandidate } from "../../../shared/contracts";
import { aiPromptOutputSchema, aiPromptOutputJsonSchema } from "../prompt-schemas";
import type { AiGatewayClient } from "../gateway-client";

export interface ProductImagePromptInput {
  productContext: AiProductContext;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  request: string;
}

/** Implements only the registered product-image-prompt workflow for R0. */
export async function generateProductImagePrompts(client: AiGatewayClient, input: ProductImagePromptInput, signal?: AbortSignal): Promise<{ candidates: AiPromptCandidate[]; requestId: string | null; actualModel: string | null; usage: unknown }> {
  const response = await client.generateStructured({
    applicationId: "product-image-prompt",
    schemaName: "product_image_prompt_candidates",
    schema: aiPromptOutputJsonSchema,
    messages: [
      {
        role: "system",
        content: "你是电商商品摄影提示词专家。只根据商品资料生成3套候选，不能虚构商品结构、材质和颜色。prompt 与 negativePrompt 使用适合图片模型的英文，warnings 使用中文。每套必须明确商品保护、构图、灯光、背景、风格、比例和用途。不得生成图片、不得调用外部工具。",
      },
      {
        role: "user",
        content: JSON.stringify({
          productContext: input.productContext,
          conversationHistory: input.history,
          request: input.request,
          constraints: { candidateCount: 3, aspectRatio: input.productContext.aspectRatio || "1:1" },
        }),
      },
    ],
    variables: {
      "product.name": input.productContext.name,
      "product.category": input.productContext.category,
      "product.material": input.productContext.material,
      "product.color": input.productContext.color,
      "product.targetMarket": input.productContext.targetMarket,
      "product.imagePurpose": input.productContext.imagePurpose,
      "product.style": input.productContext.style,
      "product.aspectRatio": input.productContext.aspectRatio,
      "user.request": input.request,
    },
  }, signal);
  const parsed = aiPromptOutputSchema.parse(response.value);
  return { ...parsed, requestId: response.requestId, actualModel: response.actualModel, usage: response.usage };
}
