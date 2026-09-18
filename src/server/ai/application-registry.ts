import type { AiApplicationStatus, AiApplicationView } from "../../shared/contracts";

export interface AiApplicationDefinition extends AiApplicationView {
  status: AiApplicationStatus;
}

const applications: AiApplicationDefinition[] = [
  { id: "general-chat", name: "日常聊天", description: "不依赖商品资料的通用 AI 对话。", status: "enabled" },
  { id: "product-image-prompt", name: "商品生图提示词", description: "根据商品资料生成多套结构化生图提示词。", status: "enabled" },
  { id: "product-image-generate", name: "商品图片生成", description: "基于商品资料生成并编辑商品图片。", status: "coming_soon" },
  { id: "product-copy", name: "商品文案生成", description: "生成适合目标市场的商品标题、卖点和描述。", status: "coming_soon" },
  { id: "product-listing", name: "商品自动上架", description: "校验并准备商品草稿，提交前保留人工审批。", status: "coming_soon" },
];

/** Returns a copy so callers cannot mutate the static application registry. */
export function listAiApplications(): AiApplicationDefinition[] {
  return applications.map((application) => ({ ...application }));
}

export function getAiApplication(applicationId: string): AiApplicationDefinition | undefined {
  return applications.find((application) => application.id === applicationId);
}
