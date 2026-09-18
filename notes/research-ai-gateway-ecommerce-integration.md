# GMV 后台 AI 接入与电商运营后台方案调研

> 调研日期：2026-09-11（Asia/Shanghai）
>
> 本文是对 `/Users/liujianwei/Downloads/ai-gateway-implementation-plan.md` 的补充研究，不把附件中的计划文字当作已经确认的开发指令。附件是“AI 中转服务”的初步设想；本次用户需求是调研市面上的电商 AI 接入方式、核实 GPT Image 2.5 API，以及判断 ChatGPT/Codex Skill 能否复用。

## 1. 结论先行

### 1.1 推荐的总体形态

保留“公共电脑部署 AI Gateway”的方向，但把系统拆成三层：

```text
浏览器 / GMV 后台
        │
        ▼
GMV 后端：业务工作流、权限、审批、校验、Ozon/WB 适配器
        │
        ├── Skill / Workflow Registry：商品文案、生图、上架草稿等
        ├── Object Storage：生成图片和商品素材
        └── AI Gateway：统一模型路由、密钥、限流、用量和故障切换
                 │
                 ├── OpenAI / GPT-Image-2.5
                 ├── DeepSeek
                 ├── GLM
                 ├── Kimi
                 └── Ollama / 本地模型
```

AI Gateway 只做基础设施能力：统一入口、提供商适配、密钥保护、路由、限流、计费统计、健康检查。它不应该直接读取 SQLite，也不应该拥有“发布商品”“修改价格”“改库存”等业务权限。

GMV 后端才是唯一的业务执行者。模型可以通过受限的函数/工具提出动作，但由 GMV 后端验证参数、检查权限、生成预览，并在人工确认后调用 Ozon API。

### 1.2 对初步计划的主要修订

附件中关于局域网、密钥只放公共电脑、独立 Token、限流、脱敏、GMV 后端调用 Gateway、结果校验和人工确认的方向基本正确。

需要新增两条边界：

1. “AI 中转”与“业务 Agent/Skill”分层。LiteLLM 或 New API 适合放在 Gateway 层；商品上架工作流、Ozon 字段映射和审批逻辑应留在 `ozon-gmv-dashboard` 后端。
2. 图片生成不是普通文本聊天的一个小参数。GPT Image 2.5 应走独立的图片生成/编辑能力，并采用异步任务、对象存储和素材审核链路。

### 1.3 目前市场上的共同模式

成熟电商产品基本形成了四种模式：

| 模式 | 典型产品 | 具体做法 | 对 GMV 的启发 |
| --- | --- | --- | --- |
| 管理后台 Copilot | Shopify Sidekick | 在管理员上下文中回答问题、分析数据、生成内容、提出动作；动作通过应用扩展进入正确页面或受控 UI，商家仍审阅变更 | “经营助手”与“商品工作台”可以共用一套工具协议，但发布动作保留确认 |
| 字段级生成 | Shopify Magic、Wix、BigCommerce | 在商品标题、描述、SEO、图片等具体字段旁生成多个候选，用户挑选和编辑 | 适合第一期，失败成本低，容易落到现有表单 |
| 多模态商品建档 | Amazon Seller | 输入简短描述、商品图片甚至已有网站 URL，生成标题、卖点、描述和其他属性；先保存草稿，再人工编辑和批准 | “图片/链接 → 商品草稿”可作为 GMV 的高价值入口，但不能让模型猜尺寸、材质、合规属性 |
| Agent + 工具调用 | Shopify Sidekick App Extensions、OpenAI Function Calling | 模型只产生结构化工具调用；应用执行工具并把结果回传模型，工具权限和业务副作用由应用控制 | 上架应拆成校验、预览、提交任务、查询结果等多个工具，禁止一个 `publish_anything` 大工具 |

来源：

- [Shopify Sidekick 帮助文档](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/)
- [Shopify Sidekick App Extensions](https://shopify.dev/docs/apps/build/sidekick)
- [Amazon：How to use Amazon AI to create product listings](https://sell.amazon.com/blog/amazon-listing-ai)
- [Wix：Using AI to create an online store](https://support.wix.com/en/article/using-ai-to-create-an-online-store)
- [BigCommerce：BigAI](https://www.bigcommerce.com/solutions/ai-for-commerce/)
- [OpenAI：Function calling](https://developers.openai.com/api/docs/guides/function-calling)

## 2. 市面方案的关键设计规律

### 2.1 生成结果默认是“草稿”，不是最终事实

Amazon 的官方卖家材料明确描述了从文字或图片生成商品信息后，卖家仍可以 review、edit、approve，再提交审核。Shopify Sidekick 的动作扩展也强调建议变更并把商家带到正确 UI，商家仍控制最终更新。

因此，GMV 的 AI 输出应落在 `publish_drafts` 或等价的草稿实体中，并记录每个字段：

```text
field value
source = ai | seller | marketplace | imported
model / workflow version
generated_at
review_status
warnings[]
```

AI 生成的俄语标题、卖点、描述、SEO 文案、图片说明和属性建议可以进入草稿；价格、库存、尺寸、重量、条码、法定标识、品牌和类目等字段应优先来自卖家输入或平台字典。

### 2.2 模型只负责语言和候选，程序负责数值与平台约束

这与附件中“数值、金额、转化率和排名由程序计算”的要求一致，也应扩展到商品上架：

- 类目和属性必填项由 Ozon/WB 的官方接口或缓存字典决定。
- 尺寸、重量、价格、库存和币种由后端校验和计算。
- AI 只能建议缺失值；不能把猜测的值当成事实提交。
- 平台返回的异步任务状态才是“已创建/审核中/失败”的事实来源。

### 2.3 多平台不是一个统一 JSON，而是统一领域模型加平台适配器

Amazon SP-API 把商品建档拆成目录发现、创建、维护和问题检查，并通过 Product Type Definitions API 获取商品类型定义；其 Listings Items API 支持创建、编辑、删除和查询 SKU。Wildberries 官方 API 也把类目、 предмет、特征、卡片、媒体、价格、折扣和库存拆成不同能力。

Ozon 的商品导入同样需要类目属性和图片链接，并且导入、图片更新、状态查询是不同步骤。Ozon 相关官方文档入口为 [Ozon Seller API](https://docs.ozon.ru/api/seller/)；当前可检索到的接口镜像记录了 `/v3/product/import`、`/v1/product/pictures/import` 和异步 `task_id` 流程，镜像仅作为接口细节的辅助来源：[Ozon Seller API 接口整理](https://github.com/DragonSigh/ozon-seller-api-docs/blob/master/uploading-and-updating-products.md)。

建议维护一个内部的 `CanonicalProductDraft`，再由 `OzonProductAdapter`、`WildberriesProductAdapter` 等把它映射到各平台，而不是让模型直接输出平台请求 JSON。

## 3. 适合本项目的 AI 工作流

### 3.1 商品文案工作流

输入：商品图片、原始标题、卖家提供的事实属性、目标国家/语言、类目、关键词、品牌语气。

输出：

- 俄语标题候选 3 个
- 卖点列表
- 详细描述
- 搜索关键词建议
- 图片 alt 文本
- 未确认事实和风险提示

约束：

- 只允许使用输入事实；无法确认的内容标记为 `unknown`。
- 标题长度、敏感词、禁用承诺和平台字段长度由程序校验。
- 生成结果写入草稿，不能直接覆盖卖家原文。

### 3.2 图片理解 → 文案工作流

先由视觉模型读取图片中的可见内容，再与卖家提供的事实合并。图片可以帮助识别颜色、外观、包装和可见配件，但不能可靠证明材质、尺寸、认证和功能参数。

输出应同时包含：

```json
{
  "observed": [],
  "seller_facts": [],
  "inferred": [],
  "missing_facts": [],
  "draft_copy": {}
}
```

只有 `seller_facts` 和明确可见的 `observed` 才能进入可发布字段；`inferred` 只展示给人工审核。

### 3.3 商品生图/改图工作流

建议拆为：

1. 生成合规的主图候选。
2. 基于原始商品图做背景替换、场景图或细节图。
3. 自动检查主体一致性、文字错误、尺寸比例、平台主图规则和品牌素材规范。
4. 人工选择图片顺序。
5. 上传到稳定对象存储，得到平台可以访问的图片 URL。

不要把“生图完成”视为“可以上架”。图片生成和 Ozon 图片导入之间需要有资产状态：`generated`、`reviewed`、`stored`、`attached_to_draft`、`published`。

### 3.4 自动上架工作流

推荐的工具边界：

```text
resolve_category
        ↓
load_required_attributes
        ↓
generate_product_draft
        ↓
validate_product_draft
        ↓
preview_marketplace_payload
        ↓   人工确认 / 审批令牌
submit_product_import_task
        ↓
poll_product_import_status
        ↓
apply_images_and_verify
        ↓
report_moderation_result
```

第一期可以叫“AI 辅助上架”，而不是无条件全自动上架。后续若要批量自动上架，只允许经过白名单的类目、字段完整、没有风险警告、价格和库存来源明确的商品进入自动队列；仍要有可追溯的批次、操作者、模型版本和平台响应。

## 4. Gateway 选型与提供商兼容性

### 4.1 LiteLLM

LiteLLM 的官方仓库将 Proxy Server 定义为面向团队/组织的集中式 AI Gateway，提供统一的 OpenAI 风格接口，并覆盖多家模型提供商；仓库还列出虚拟 Key、用量统计、预算、Guardrails、负载均衡和日志等能力：[BerriAI/litellm](https://github.com/BerriAI/litellm)。

LiteLLM 的官方文档说明，虚拟 Key 的个人/团队预算和 RPM/TPM 限制需要数据库来可靠执行；无数据库部署不应被当作具备用量封顶能力：[Budgets and Rate Limits](https://github.com/BerriAI/litellm-docs/blob/main/docs/proxy/users.md)。

对四人团队而言，LiteLLM 适合第一版 Gateway，但建议：

- 用稳定版本镜像，不追随 `latest`。
- 若要做成员预算、用量统计和管理 UI，配 Postgres；Redis 是否需要取决于并发和部署形态。
- GMV 生产业务只拿内部服务 Token，不把 LiteLLM 管理 Key 放进前端。
- 单独验证 `/chat/completions`、`/responses`、`/images`、图片输入、工具调用和错误映射，不假设“OpenAI 兼容”代表所有字段都兼容。

### 4.2 New API

New API 更偏中文团队常见的统一模型管理、渠道、额度和运营界面。其官方仓库描述了统一 AI 模型聚合与分发，并支持多家模型服务：[QuantumNous/new-api](https://github.com/QuantumNous/new-api)。

需要特别注意许可证：当前仓库 README 标注为 AGPLv3，并要求修改后分发的带 UI 版本保留归属和原项目链接。若未来把该系统包装成对外商业服务，必须先让团队确认 AGPL 合规边界。

### 4.3 One API

One API 的官方 README 是“多模型统一 OpenAI API 格式 + 频道和 Token 管理”的典型实现：[songquanpeng/one-api](https://github.com/songquanpeng/one-api)。它可以作为理解国内常用中转架构的参考，但新部署前应核对当前维护状态、镜像版本、依赖安全和许可证，不建议在没有验证的情况下直接把它作为生产基础设施。

### 4.4 提供商的“兼容”只是入口兼容

当前官方文档中，DeepSeek 提供 OpenAI/Anthropic 兼容格式，Kimi API 兼容 OpenAI Chat Completions，Ollama 提供部分 OpenAI API 兼容能力；智谱公开平台也提供 OpenAI 协议 Base URL。可作为入口层参考：

- [DeepSeek API](https://api-docs.deepseek.com/)
- [Kimi API Overview](https://platform.kimi.ai/docs/api/overview)
- [Zhipu AI Open Platform](https://open.bigmodel.cn/dev/api)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

但是工具调用、视觉输入、结构化输出、流式、图片生成、错误码、上下文和速率限制仍可能不同。建议在 Gateway 旁维护一份能力矩阵：

| 能力 | OpenAI | DeepSeek | GLM | Kimi | Ollama |
| --- | --- | --- | --- | --- | --- |
| 文本生成 | 需验证具体模型 | 支持 API | 支持 API | 支持 API | 支持部分 OpenAI 接口 |
| 图片理解 | 按模型 | 需按视觉模型验证 | 需按视觉模型验证 | 按模型 | 按模型 |
| 函数/工具调用 | Responses/Chat Completions 按模型 | 需按模型验证 | 需按模型验证 | 需按模型验证 | 官方文档列出 Chat/Responses 工具支持 |
| 图片生成 | GPT Image 2.5 独立能力 | 不应假设有同等能力 | 不应假设有同等能力 | 不应假设有同等能力 | 图片接口仍标为 experimental |
| 结构化输出 | 按模型和端点 | 需按模型验证 | 需按模型验证 | 需按模型验证 | JSON mode 等能力有限制 |

表中的“需验证”是工程结论，不是各厂商对能力的统一承诺。模型切换必须通过业务回归测试，不能只替换 `model` 字符串。

## 5. GPT Image 2.5 是否可以 API 调用

可以。官方名称是 GPT-Image-2.5，而不是“ChatGPT-image 2.5”。当前官方模型页面列出两个模型：

- `gpt-image-2.5-sunburst`：更适合需要编辑精度的生成和编辑任务。
- `gpt-image-2.5-flare`：更快，适合日常高频生成。

两者均接受文本和图片输入并输出图片，可直接使用 Image API 的 `/v1/images/generations`，也可以在 Responses API 中作为 `image_generation` 工具的模型；官方模型页面和图片指南均给出了这一调用方式：

- [GPT-Image-2.5 Sunburst Model](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [GPT-Image-2.5 Flare Model](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
- [OpenAI Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)

选型建议：

- 只有“一次生成/一次编辑”：使用 Image API，链路简单。
- 需要连续修改、参考图、多轮交互：使用 Responses API 的图片生成工具。
- 商品主图、场景图批量生产：优先从 Image API 开始，在 GMV 后端做异步任务和资产管理。
- GPT Image 2.5 模型页当前标注不支持 function calling、structured outputs 和 streaming；不要把图片生成当成普通文本流式响应处理。生成请求应返回任务 ID，前端轮询或订阅任务状态。

官方图片指南当前给出的 GPT Image 2.5 费率为文本输入、图片输入和图片输出按 token 计费，实际单张成本还受到尺寸、质量和参考图影响；上线前应以官方定价页和实际用量为准，不要把本文数字写死进业务规则。

## 6. ChatGPT Skill 能否直接复用

这里必须区分三种东西。

### 6.1 ChatGPT Custom GPT：不能直接嵌入 GMV

如果你说的“skill”实际是 ChatGPT 里的 Custom GPT，那么不能直接把它作为 GMV 后端的一个 API endpoint 调用。OpenAI Help Center 明确说明，GPTs 是设计在 ChatGPT 内使用的，不能作为外部网站或应用的嵌入方式；外部产品应使用 API 重建 assistant/agent：[GPTs in ChatGPT](https://help.openai.com/en/articles/8554407-gpts-faq/)。

### 6.2 OpenAI Skills：可以导出/上传，但不等于所有模型都能直接运行

OpenAI 当前提供 Skills 的 API 管理接口，包括创建、列出、版本、下载内容；Responses API 参考中也出现了 inline skill、local environment 和 skill reference 相关结构：[Skills API Reference](https://developers.openai.com/api/reference/python/resources/skills/methods/create)、[Responses API Reference](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses)。

这说明“可打包的 Skill 工作流”已经有 API 复用方向，但要注意：

- Skill 可以包含指令、辅助文件和代码，上传前必须审计来源和脚本。
- Skill 运行依赖模型、Responses 端点和执行环境；模型目录会标注具体能力，不能默认所有模型支持 Skills。
- DeepSeek、GLM、Kimi 的 OpenAI 兼容接口不会自动获得 OpenAI Skills 能力。
- 一个 Skill 仍然需要真实的业务工具，例如 `preview_product_payload`、`submit_ozon_import_task`；Skill 本身不应保存 Ozon API Key，也不能绕过 GMV 后端权限。

### 6.3 推荐的复用方式：Skill 源码统一，运行时适配

把现在已经验证过的工作流整理成团队自己的、与模型无关的 Skill 包，例如：

```text
skills/
  product-copy/
    SKILL.md
    input.schema.json
    output.schema.json
    examples/
  product-image/
    SKILL.md
    input.schema.json
    output.schema.json
  product-publish/
    SKILL.md
    input.schema.json
    output.schema.json
```

其中：

- `SKILL.md` 保存目标、步骤、禁用行为、示例和人工确认规则。
- JSON Schema 保存输入输出契约。
- 真实的 Ozon 调用、图片存储和权限检查写在 GMV 后端代码中。
- OpenAI 路由可以上传或 inline 使用 Skill。
- DeepSeek/GLM/Kimi 路由由 Gateway/编排器把 Skill 指令编译成 system/developer prompt，并注册同一组工具 schema。

所以用户描述的调用关系可以实现成：

```text
上架模块 → product-publish workflow → GMV tools → Ozon adapter
生图模块 → product-image workflow → image provider → object storage
文案模块 → product-copy workflow → text/vision provider
```

而不是让“上架 Skill”直接调用 Ozon，也不是让“生图 Skill”依赖某一个 ChatGPT 会话。

## 7. 对当前 `ozon-gmv-dashboard` 的落地判断

当前项目已经具备非常适合接入 AI 的边界：

- `src/web/pages/ResellPage.tsx` 已经是商品发布工作台，包含商品标题、描述、类目、属性、图片、店铺、价格和仓库等编辑字段。
- `migrations/015_publish_workbench.sql` 已经有 `publish_drafts`、字段覆盖和来源快照，可以承载 AI 草稿和人工修改。
- `src/server/ozon/client.ts` 已经封装商品导入、商品图片导入、商品导入结果查询、商品属性和库存/价格等能力。
- `src/server/index.ts` 使用 Fastify 组装模块，后续可以增加独立的 AI workflow/service，而不让浏览器直连第三方模型。
- 项目 README 已明确 API Key 不回传浏览器、管理后台和局域网只读大屏分离，这与 AI 接入的安全边界一致。

因此，第一期不需要重做发布模块。建议先新增一个只产生草稿的入口，例如：

```text
POST /api/ai/product-draft
POST /api/ai/product-copy
POST /api/ai/product-image
POST /api/ai/product-draft/:id/validate
POST /api/ai/product-draft/:id/preview
POST /api/ai/product-draft/:id/submit
GET  /api/ai/tasks/:id
```

其中 `submit` 必须要求管理员会话或一次性审批令牌；模型输出不能直接触发该接口。真实的接口命名和 schema 在实施时以现有 Fastify route convention 为准。

## 8. 建议里程碑

### Milestone 0：先验证供应商和网关

在公共电脑上部署 LiteLLM，接入 OpenAI、DeepSeek、GLM、Kimi 中至少两家文本模型和一个本地 Ollama 模型。验证统一文本接口、视觉输入、工具调用、错误映射、四人 Token、用量统计和重启恢复。

图片先单独验证 `gpt-image-2.5-sunburst` 和 `gpt-image-2.5-flare`，确认账号权限、区域、费率、图片返回格式、耗时和对象存储流程。不要等 GMV 页面完成后才发现图片端点无法被当前 Gateway 透传。

### Milestone 1：AI 商品文案草稿

只接入现有发布工作台：用户提供商品事实和图片，AI 生成俄语标题/卖点/描述候选，保存为 `publish_drafts` 的 AI 来源字段，支持逐字段接受、拒绝和人工修改。

### Milestone 2：图片资产工作流

加入生成、编辑、预览、选择主图、上传对象存储、保存生成记录和素材审核。生成失败不能阻塞原有人工上架。

### Milestone 3：AI 辅助上架

AI 负责补全和解释，后端负责属性字典、字段校验、预览平台请求和异步任务。人工确认后复用现有 Ozon 发布链路。

### Milestone 4：有限自动上架

只对明确白名单商品开放批量自动上架，并保留暂停开关、失败重试、幂等键、审计日志和平台审核结果。价格、库存、合规属性和品牌字段不应由自由文本模型自动决定。

## 9. 风险清单

- 公共电脑睡眠、断电、IP 变化会让全团队 AI 不可用；需要服务自启动、固定地址、健康检查和离线失败提示。
- Gateway 一旦暴露到公网，内部 Token 和上游密钥会成为高价值攻击目标；不做端口映射，必要时只允许四台客户端 IP。
- 多模型兼容接口可能只兼容基础 Chat Completions；工具调用、图片、结构化输出和错误码需要单独回归。
- Skill 文件可能包含代码和隐藏指令，必须经过团队审核、版本控制和最小权限执行。
- 商品图片和商品资料可能包含供应商隐私、客户信息或未公开品牌素材；按字段脱敏，默认不记录完整 Prompt 和图片内容。
- AI 生成内容可能捏造材质、尺寸、认证、功效和适用人群；任何进入平台的事实字段都需要来源和规则校验。
- New API 的 AGPLv3 约束和 LiteLLM 的版本/依赖安全需要在正式部署前单独做许可证和安全评估。

## 10. 安装包与服务器部署：建议做成“一套制品、两种运行模式”

### 10.1 推荐产品形态

不要把“安装包”理解为把所有模型和供应商服务打进一个巨大桌面程序。建议将 AI 中转做成一个独立产品，例如 `GMV AI Relay`，发布同一套版本制品，但提供两种启动方式：

| 运行模式 | 目标环境 | 形态 | 网络边界 |
| --- | --- | --- | --- |
| LAN 模式 | 团队闲置电脑 | 一键安装器 + 本地服务/容器 + 管理页面 | 只监听局域网，允许 GMV 后端或指定客户端访问 |
| Server 模式 | 云服务器/团队服务器 | 同一镜像 + Docker Compose/配置文件 | 反向代理 HTTPS，Gateway 不直接暴露到公网 |

LiteLLM 官方同时提供 CLI、Docker 和 Docker Compose 方式；带 Admin UI、虚拟 Key、用量和成本记录时，官方 Compose 方案会配套数据库。New API 官方部署资料也把 Docker Compose 作为推荐方式，并建议生产环境使用 PostgreSQL，SQLite 主要用于本地评估和临时测试。[LiteLLM Quick Start](https://docs.litellm.ai/docs/proxy/docker_quick_start)、[New API Docker 部署](https://docs2.newapi.pro/en/docs/installation/deployment-methods/docker-installation)

### 10.2 安装包中应该包含什么

安装包或安装器应负责“安装、初始化和运维”，而不是重新实现所有模型协议：

```text
GMV AI Relay 安装器
├─ Relay Manager：服务启停、端口、局域网地址、健康状态
├─ Gateway Runtime：固定版本的 LiteLLM 或选定网关镜像
├─ Config：模型别名、路由、限流、Token 权限
├─ Secret Store：本机密钥文件/系统密钥环，不写入前端代码
├─ Data：数据库、审计摘要、备份和恢复
└─ Diagnostics：连通性、供应商鉴权、模型测试、日志导出
```

至少要支持：首次配置向导、开机自启、端口冲突检查、固定模型别名、供应商连通性测试、配置备份/恢复、版本升级、失败回滚、日志脱敏和卸载。

### 10.3 本地安装的两种技术路线

**路线 A：安装器 + 容器运行时，优先推荐。** 安装器负责检查或引导 Docker/兼容容器运行环境，然后启动固定版本的 Gateway、PostgreSQL 和可选对象存储。优点是与服务器部署高度一致，升级、回滚和依赖隔离更容易；缺点是安装包更重，Windows/macOS 的容器运行环境和权限处理更复杂。

**路线 B：安装器 + 原生服务运行时。** 把网关和管理服务作为本机服务直接安装，数据库可使用本地文件数据库或独立 PostgreSQL。优点是用户体验更像普通软件；缺点是需要自行维护 Python/Node 运行时、进程守护、升级回滚、跨平台差异和供应商依赖，且与服务器环境容易出现“本地能跑、服务器不一致”。

对于本项目，建议先采用路线 A 做内部试运行；如果团队电脑不适合安装 Docker，再做一个原生服务安装器，但保持配置格式、健康检查、API 和数据目录与容器模式一致。

### 10.4 服务器模式必须补齐的能力

- 反向代理和 HTTPS；Gateway 只绑定内网地址或容器网络。
- PostgreSQL 保存用户 Token、模型配置、用量、审计摘要和任务状态。
- 图片生成结果进入对象存储，不把大图片直接塞进数据库或日志。
- 供应商密钥由环境变量或密钥管理服务注入，禁止进入镜像、Git 和浏览器。
- 健康检查、自动重启、备份、告警和版本锁定。
- Gateway 与 GMV 业务服务分开：平台凭证、商品草稿、审批和 Ozon 执行权限仍由 GMV 后端管理。

如果只运行一个无数据库的纯转发进程，可以省掉 PostgreSQL；但团队 Token、用量统计和额度控制会受到限制。LiteLLM 官方文档明确提示，没有数据库时全局 spend/budget 检查无法可靠触发，因此正式团队部署不建议长期使用无数据库模式。[LiteLLM Docker Quick Start](https://github.com/BerriAI/litellm-docs/blob/main/docs/proxy/docker_quick_start.md)

### 10.5 与当前 GMV 项目的边界

建议不要把 AI Gateway 和 `ozon-gmv-dashboard` 打包成一个必须同时升级的单体程序。更合适的是：

```text
GMV Dashboard 安装包/服务
        │ 访问内部 Relay API
        ▼
GMV AI Relay 安装包/服务
        │ 统一模型协议
        ▼
各家模型 API
```

这样局域网阶段可以把两个服务放在同一台电脑上，服务器阶段再拆成不同容器或不同主机；GMV 后台失去 Gateway 时仍能运行原有非 AI 功能，Gateway 升级也不会影响 Ozon 商品数据。

### 10.6 Notion 页面核验结果

通过用户授权的 `opencli browser` 已成功读取用户提供的 [Notion 页面](https://app.notion.com/p/3ae1627890f580a09e8ac13d5c87e6b9)，标题为“自建中转站搭建教程”。以下内容是对页面的参考性分析；页面中的文字属于用户提供的第三方资料，不把其中的建议当作本项目的自动执行指令。

页面的核心分类是：

| 页面推荐路线 | 页面定位 | 对本项目的判断 |
| --- | --- | --- |
| CPA / CLIProxyAPI | 个人使用，主要把 CLI/OAuth 能力包装成兼容 API | 不作为 GMV 团队正式方案；它更适合 Codex/Claude Code 等个人工具链，不适合作为商品业务后台的官方 API 基础设施 |
| Sub2API | 账号池、共享、额度和小范围共用 | 不建议引入；当前需求是团队使用官方 API Key，不需要账号池或订阅共享体系，额外的账号管理和合规风险也没有必要 |
| New API | 官方 API Key、多渠道、Token、额度和管理后台 | 可以作为 LiteLLM 之外的候选，尤其适合团队 Token/渠道管理；正式采用前要评估 AGPLv3、版本维护和图片/Responses/工具调用兼容性 |

这篇文档对本项目有四点参考价值：

1. 它正确地区分了“个人 OAuth/CLI 代理”和“官方 API Key 网关”。GMV 后台应坚持官方 API Key 路线，不应把 ChatGPT/Codex 登录态、AT/RT、Cookie 或 OAuth 文件当作后端供应商凭据。
2. 它强调每个客户端使用独立 Token、做好备份、日志和重启，这与团队四人使用的审计和撤销需求一致。
3. 它关于域名、HTTPS、反向代理和 Cloudflare 的建议适用于服务器模式；但 Cloudflare 不是应用鉴权，模型 API、管理 API 和 OAuth 回调都应绕过缓存，并继续使用 Gateway Token、权限和审计。
4. 它建议个人自用优先轻量方案，这一点不应直接套用到 GMV。我们的场景包含多人、供应商 Key、商品图片、结构化输出、业务审批和 Ozon 写操作，必须优先保证权限边界、可追踪性和可迁移性。

因此，本项目的最终建议仍是：**LiteLLM 与 New API 做小规模 POC 对比；不引入 CPA/Sub2API；用自有 `GMV AI Relay` 安装包封装选定 Gateway 的配置、服务管理、Token、健康检查和升级流程。** 页面中提到的域名、Cloudflare 和服务器部署内容可以借鉴，但注册商推荐、价格示例和具体命令需要按当日官方文档重新核验。

## 11. 来源索引

### OpenAI 官方资料

- [GPT-Image-2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [GPT-Image-2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare)
- [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Skills API：Create Skill](https://developers.openai.com/api/reference/python/resources/skills/methods/create)
- [Responses API：Skill reference schemas](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses)
- [Skills in ChatGPT](https://help.openai.com/en/articles/20001066-skills-in-chatgpt/)
- [GPTs in ChatGPT FAQ](https://help.openai.com/en/articles/8554407-gpts-faq/)

### 电商平台和卖家后台资料

- [Shopify Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/)
- [Shopify Sidekick app extensions](https://shopify.dev/docs/apps/build/sidekick)
- [Shopify productCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productCreate)
- [Amazon AI listing creation](https://sell.amazon.com/blog/amazon-listing-ai)
- [Amazon SP-API product listings lifecycle](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)
- [Wix AI tools for online stores](https://support.wix.com/en/article/using-ai-to-create-an-online-store)
- [BigCommerce BigAI](https://www.bigcommerce.com/solutions/ai-for-commerce/)
- [Ozon Seller API](https://docs.ozon.ru/api/seller/)
- [Ozon product upload/API notes mirror](https://github.com/DragonSigh/ozon-seller-api-docs/blob/master/uploading-and-updating-products.md)
- [Wildberries API：Work with products](https://dev.wildberries.ru/openapi/work-with-products)

### Gateway 和模型提供商资料

- [LiteLLM GitHub](https://github.com/BerriAI/litellm)
- [LiteLLM budgets and rate limits](https://github.com/BerriAI/litellm-docs/blob/main/docs/proxy/users.md)
- [New API GitHub](https://github.com/QuantumNous/new-api)
- [One API GitHub](https://github.com/songquanpeng/one-api)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [Kimi API Overview](https://platform.kimi.ai/docs/api/overview)
- [智谱 AI 开放平台](https://open.bigmodel.cn/dev/api)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)
- [LiteLLM Docker Quick Start](https://github.com/BerriAI/litellm-docs/blob/main/docs/proxy/docker_quick_start.md)
- [New API Docker deployment](https://docs2.newapi.pro/en/docs/installation/deployment-methods/docker-installation)
