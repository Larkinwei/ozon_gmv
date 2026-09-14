import { z } from "zod";

export const aiProductContextSchema = z.object({
  name: z.string().trim().max(500).default(""),
  category: z.string().trim().max(300).default(""),
  attributes: z.record(z.string(), z.unknown()).default({}),
  material: z.string().trim().max(300).default(""),
  color: z.string().trim().max(200).default(""),
  targetMarket: z.string().trim().max(200).default(""),
  imagePurpose: z.string().trim().max(200).default("场景图"),
  style: z.string().trim().max(300).default("真实电商摄影"),
  aspectRatio: z.string().trim().max(20).default("1:1"),
});

export const aiPromptCandidateSchema = z.object({
  prompt: z.string().min(1),
  negativePrompt: z.string(),
  subjectProtection: z.array(z.string().min(1)).min(1),
  composition: z.string(),
  lighting: z.string(),
  background: z.string(),
  style: z.string(),
  aspectRatio: z.string(),
  intendedUse: z.string(),
  warnings: z.array(z.string()),
});

export const aiPromptOutputSchema = z.object({
  candidates: z.array(aiPromptCandidateSchema).length(3),
});

/** JSON Schema sent to the relay so supported providers can constrain their response. */
export const aiPromptOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["candidates"],
  properties: {
    candidates: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["prompt", "negativePrompt", "subjectProtection", "composition", "lighting", "background", "style", "aspectRatio", "intendedUse", "warnings"],
        properties: {
          prompt: { type: "string" },
          negativePrompt: { type: "string" },
          subjectProtection: { type: "array", items: { type: "string" } },
          composition: { type: "string" },
          lighting: { type: "string" },
          background: { type: "string" },
          style: { type: "string" },
          aspectRatio: { type: "string" },
          intendedUse: { type: "string" },
          warnings: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

export const aiGeneralChatOutputSchema = z.object({ reply: z.string() });

export const aiGeneralChatOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reply"],
  properties: { reply: { type: "string" } },
} as const;
