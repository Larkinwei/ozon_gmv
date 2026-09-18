# 电商运营后台接入 AI：官方能力、上架边界与统一网关调研

> 独立资料调研
>
> 调研/检索日期：2026-09-11
>
> 来源约束：只采用平台厂商官方文档、官方博客/帮助中心、官方 API 更新频道，以及 GitHub 上游仓库 README/文档源码。未采用媒体报道、第三方教程、论坛转述或非官方 SDK 作为事实依据。
>
> 本文中的“已证实”表示一手来源明确写出；“推断”表示基于一手来源能力边界形成的工程判断，不等同于平台承诺。

## 结论先行

1. **成熟的 AI 运营后台不是让模型直接“发布商品”，而是让模型生成候选动作，再由平台适配器完成字段映射、权限校验、规则校验、幂等控制和异步结果跟踪。** Shopify Sidekick、Amazon 的 AI listing 流程都把“生成/填充”与“人工 review/approve/submit”分开；Ozon 和 Wildberries 的官方 API 则把真实上架定义成带类目属性、尺寸、图片、标识和审核/同步状态的结构化 API 流程。[推断，依据：[Shopify Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)、[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)、[Ozon Seller API](https://docs.ozon.ru/api/seller/)、[WB API 商品文档](https://dev.wildberries.ru/openapi//work-with-products)，检索日期：2026-09-11]
2. **AI 最适合先做“理解与补全”，不适合直接决定合规事实。** 可以让 AI 负责标题/描述/关键词候选、类目候选、属性值候选、异常解释和运营分析；品牌授权、条码/标识、真实包装尺寸重量、危险品/合规字段、价格与库存、最终提交应保留确定性校验和人工确认。[推断，依据：[Amazon listing review/compliance](https://sell.amazon.com/blog/amazon-listing-ai)、[Ozon Seller API](https://docs.ozon.ru/api/seller/)、[WB API release notes](https://dev.wildberries.ru/release-notes)，检索日期：2026-09-11]
3. **Shopify 是“平台内原生 agent”范式，Amazon 是“卖家工作台内的生成式 listing + agent”范式；Rufus 主要是买家侧购物助手，不能等同于 Seller Assistant。** Shopify Sidekick 能理解店铺上下文并执行商品、折扣、集合、报告和工作流等任务，但会展示修改供 review；Amazon Seller Assistant 面向卖家，Rufus/后续 Alexa for Shopping 面向购物者。[已证实，依据：[Shopify Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)、[Amazon Seller Central](https://sell.amazon.com/tools/seller-central)、[Amazon Rufus](https://www.aboutamazon.com/news/retail/amazon-rufus-ai-assistant-personalized-shopping-features)，检索日期：2026-09-11]
4. **Ozon/Wildberries 的官方开放接口已经足以支撑“AI 草稿 → 平台 API 创建/更新 → 异步状态/错误回查”，但官方接口本身不是通用 AI 上架接口。** Ozon 的商品导入需要平台字段与类目属性，并以任务/审核状态收敛；WB 的创建/编辑接口需要 subject/characteristics 等结构化数据，创建后还存在异步同步窗口和错误回查。[已证实，依据：[Ozon Seller API 文档](https://docs.ozon.ru/api/seller/)、[Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI)、[WB API 商品文档](https://dev.wildberries.ru/openapi//work-with-products)、[WB API 更新日志](https://dev.wildberries.ru/release-notes)，检索日期：2026-09-11]
5. **统一网关解决的是模型供应商、密钥、路由、费用和观测问题，不会替代电商平台适配器。** LiteLLM 更偏“LLM SDK + API Gateway/Proxy”，强调统一 OpenAI 格式、虚拟 key、费用、限流、日志、guardrails 和负载均衡；New API/One API 还提供用户/令牌/渠道/配额/计费等管理面。它们都不能自动获得 Ozon、WB、Shopify 或 Amazon 的业务权限。[已证实与推断，依据：[LiteLLM README](https://github.com/BerriAI/litellm)、[LiteLLM 官方文档](https://docs.litellm.ai/)、[New API README](https://github.com/QuantumNous/new-api)、[New API 文档源码](https://github.com/QuantumNous/new-api-docs-v1/blob/main/content/docs/en/guide/wiki/basic-concepts/project-introduction.mdx)、[One API README](https://github.com/songquanpeng/one-api/blob/main/README.en.md)，检索日期：2026-09-11]

## 1. 适合运营后台的 AI 接入分层

### 1.1 建议采用四层职责

| 层 | AI 可以做什么 | 必须由确定性系统做什么 | 输出/状态 |
| --- | --- | --- | --- |
| 理解层 | 读取自然语言、图片、源商品页、表格；抽取标题、品牌、规格、卖点和疑似类目 | 输入来源记录、文件/URL 权限、内容版权与脱敏 | 结构化候选字段 + 置信度 + 来源 |
| 生成层 | 生成标题、描述、要点、关键词、多语言版本、属性候选、异常解释 | 长度/枚举/单位/字符/禁止词/必填规则校验 | 可编辑草稿，不直接视为事实 |
| 决策层 | 给出类目匹配、价格/库存/广告/补货建议，解释原因 | 审批策略、角色权限、阈值、预算和合规规则 | 待审批动作或拒绝原因 |
| 执行层 | 根据已批准动作选择工具并组织调用 | 平台 OAuth/API key、幂等、限流、重试、任务轮询、回滚/补偿 | 草稿、提交中、平台已接收、审核中、失败、可售 |

> [推断 | 检索日期：2026-09-11] 这是对官方产品形态和 API 生命周期的归纳。依据是 Shopify 的“生成/执行后 review”、Amazon 的“draft → review/edit/approve → submit”，以及 Ozon/WB 的结构化、异步、错误回查接口：[Shopify 生成内容](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/generate-content)、[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)、[Ozon Seller API](https://docs.ozon.ru/api/seller/)、[WB API 商品文档](https://dev.wildberries.ru/openapi//work-with-products)。

### 1.2 运营后台的最小闭环

```text
商品/订单/库存/类目上下文
          ↓
AI 抽取与候选生成
          ↓
字段映射 + 平台规则/权限校验
          ↓
人工确认或符合策略的自动审批
          ↓
平台 API 执行
          ↓
异步任务、审核、错误与可售状态回查
          ↓
运营看板、审计记录、再次修正
```

> [推断 | 检索日期：2026-09-11] “AI 只产出候选动作，平台适配器才拥有执行权”是本调研最重要的架构结论。它直接对应 Shopify 要求 review changes、Amazon 要求 review/edit/approve，以及 Ozon/WB 的异步结果和错误查询设计。[Shopify AI-powered tools](https://help.shopify.com/en/manual/ai-powered-tools)、[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)、[Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI)、[WB API 官方更新日志](https://dev.wildberries.ru/release-notes)

## 2. Shopify：Sidekick 与 Shopify Magic

### 2.1 已证实能力

- [已证实 | 检索日期：2026-09-11] Shopify Sidekick 是 Shopify admin 内的 AI commerce assistant，可用自然语言提供指导、生成内容、构建应用和完成任务；官方说明它在店铺上下文中工作，并在应用修改前提供 review 机会。[Shopify Help Center—Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)
- [已证实 | 检索日期：2026-09-11] Sidekick 可处理分析数据、管理订单、编辑商品，并可与第三方应用协作完成任务；官方还列出生成博客文章、商品描述、图片和自定义应用的能力。[Shopify Help Center—Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)
- [已证实 | 检索日期：2026-09-11] Sidekick 的内容能力包括创建/编辑商品、折扣和集合，填写 admin 页面中的字段/表单，创建或编辑 metafield/metaobject，生成报告及 ShopifyQL，并创建/更新 Shopify Flow 工作流。[Shopify Help Center—Generating content with Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/generate-content)
- [已证实 | 检索日期：2026-09-11] Shopify Magic 是跨 Shopify 产品和工作流的免费 AI 能力集合；官方列出商品描述、邮件、Inbox 回复、媒体生成、主题/主题块生成、客户分群描述等场景。[Shopify Help Center—Shopify Magic](https://help.shopify.com/en/manual/ai-powered-tools/shopify-magic)
- [已证实 | 检索日期：2026-09-11] Shopify 允许商家连接 ChatGPT、Claude、Perplexity 等第三方 AI 工具来查询和管理产品、订单、客户数据，并由商家控制共享数据和工具权限。[Shopify Help Center—AI-powered tools](https://help.shopify.com/en/manual/ai-powered-tools)
- [已证实 | 检索日期：2026-09-11] Shopify Magic 的官方说明称，Shopify 不会使用某个商家的店铺级数据为其他商家提供 Shopify Magic；在为该商家提供结果时可以使用其自身店铺级数据，但不会与其他商家共享。[Shopify Help Center—Shopify Magic](https://help.shopify.com/en/manual/ai-powered-tools/shopify-magic)

### 2.2 对运营后台的启示

- [推断 | 检索日期：2026-09-11] Shopify 的核心不是一个“AI 写文案按钮”，而是把自然语言绑定到已有 admin 动作和数据上下文：查询、生成、修改、报告、工作流都落到平台已有对象和权限模型上。[依据：[Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)、[Sidekick 内容生成](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/generate-content)]
- [推断 | 检索日期：2026-09-11] 如果为 Ozon GMV Dashboard 引入 agent，应优先设计成“运营动作编排器”：例如“找出近 7 天 GMV 下滑且库存不足的商品”“生成商品草稿”“列出缺少的 Ozon 属性”“将已审批草稿提交”，而不是允许模型自由拼装外部 HTTP 请求。[依据：[Shopify Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)、[Ozon Seller API](https://docs.ozon.ru/api/seller/)]
- [推断 | 检索日期：2026-09-11] Shopify 的 review 机制可转译为本项目的“变更预览”：显示字段原值、AI 候选值、来源、置信度、规则检查结果、将要调用的 marketplace endpoint 和审批人，然后才执行。[依据：[Shopify Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)、[Shopify Sidekick 内容生成](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/generate-content)]

## 3. Amazon：Seller Assistant、AI listing 与 Rufus

### 3.1 不要混淆卖家侧和买家侧

- [已证实 | 检索日期：2026-09-11] Amazon Seller Central 官方页面把 Seller Assistant 描述为 Seller Central 内的 agentic AI expert，卖家可以在后台咨询；Seller Central 还以 actions panel 呈现提醒、个性化建议和 Ask Seller Assistant 入口。[Amazon Seller Central](https://sell.amazon.com/tools/seller-central)
- [已证实 | 检索日期：2026-09-11] Amazon 官方 Rufus 文章将 Rufus 定义为 Amazon Shopping app/website 中的 AI shopping assistant，用于购物者的产品问答、推荐、比较和购物动作；该页面还说明 2026-05-13 将 Rufus 更名为 Alexa for Shopping。[Amazon 官方 Rufus 介绍](https://www.aboutamazon.com/news/retail/amazon-rufus-ai-assistant-personalized-shopping-features)
- [推断 | 检索日期：2026-09-11] 因此，在电商运营后台调研中，Rufus 应作为“买家侧 AI 影响商品发现/转化的参考”，而不是卖家后台接入点；卖家侧的直接参考对象是 Seller Assistant、Add Products 的 AI listing 和 A+ Content Manager。[依据：[Amazon Seller Central](https://sell.amazon.com/tools/seller-central)、[Amazon Rufus](https://www.aboutamazon.com/news/retail/amazon-rufus-ai-assistant-personalized-shopping-features)、[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)]

### 3.2 Amazon 官方 AI 上架流程

- [已证实 | 检索日期：2026-09-11] Amazon 官方博客称，卖家可以用少量文字、产品图片或现有网站 URL 生成产品 listing；也可以上传 catalog spreadsheet，让 AI 将数据转换成 Amazon 格式的 draft listings。[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)
- [已证实 | 检索日期：2026-09-11] 官方列出的 Add Products AI 入口包括从产品图片、现有网页或 spreadsheet 生成；URL 场景要求页面公开可访问，且使用者应拥有或获授权使用该 URL 内容。[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)
- [已证实 | 检索日期：2026-09-11] Amazon 的 AI listing 不是无审查发布：官方流程要求卖家 review、edit、approve 生成的 listing 后，再提交以供 Amazon approval；官方还明确卖家对准确、完整和符合政策负责。[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)
- [已证实 | 检索日期：2026-09-11] 批量 AI listing 也以 draft 为中间状态：上传 spreadsheet、生成/增强数据、review draft、编辑，然后 submit 创建 listings；官方注明该批量功能只适用于添加到 catalog 的新商品。[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)
- [已证实 | 检索日期：2026-09-11] Amazon 还将 AI 用于 A+ Content 的文本和图片生成；卖家可以从自有提示或类目洞察生成内容，但仍需由卖家确认内容准确、完整和合规。[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)

### 3.3 Amazon SP-API 给第三方后台的确定性边界

- [已证实 | 检索日期：2026-09-11] Amazon SP-API 的官方 listing 生命周期包括 discovery、creation、maintenance：先发现 catalog/类目/要求/资格，再创建并检查提交是否接受，之后继续维护 buyable/discoverable 状态和问题。[SP-API—Manage Product Listings](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)
- [已证实 | 检索日期：2026-09-11] Product Type Definitions API 用于获取产品类型的数据要求；Listings Items API 用于创建、查询、更新、删除 SKU；Catalog Items API 用于搜索 catalog、匹配现有 listing；Notifications API 可接收 listing 状态和问题变化。[SP-API—Manage Product Listings](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)
- [已证实 | 检索日期：2026-09-11] `putListingsItem` 可以创建 SKU 并更新价格/库存等属性，`patchListingsItem` 可以更新 SKU 属性，`getListingsItem`/`searchListingsItems` 可以读取 listing 数据；批量场景可以使用与 Listings Items API 数据格式兼容的 `JSON_LISTINGS_FEED`。[SP-API—Manage Product Listings](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)
- [推断 | 检索日期：2026-09-11] Amazon 允许第三方把“AI 草稿”接到 SP-API，但不应把“模型生成了字段”当作“Amazon 已接受/可售”。适配器至少要保存 product type schema 版本、提交响应、issues、listing status 和通知事件。[依据：[SP-API listing lifecycle](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)、[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)]

## 4. Ozon：官方 Seller API 与自动上架边界

### 4.1 官方接口能做什么

- [已证实 | 检索日期：2026-09-11] Ozon 官方 Seller API 文档提供商品、类目、属性、图片、价格、库存、订单等卖家侧接口；商品相关能力包括商品导入/更新、商品信息和属性查询等。[Ozon Seller API 官方文档](https://docs.ozon.ru/api/seller/)
- [已证实 | 检索日期：2026-09-11] Ozon 官方 Seller API 更新频道在 2026-07-10 记录了 `/v3/product/import` 的字段变更，并将 `items.offer_id` 标为请求中的必填字段；同一更新还涉及商品图片和商品信息接口。[Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI?before=685)
- [已证实 | 检索日期：2026-09-11] Ozon 官方更新频道记录了 `/v3/product/import`、`/v1/product/import-by-sku`、`/v1/product/attributes/update`、`/v1/product/pictures/import` 等商品接口在 2026-03-26 更新了描述，说明这些接口仍是官方商品管理链路的一部分。[Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI?before=639)
- [已证实 | 检索日期：2026-09-11] Ozon 官方文档入口本身以 Seller API 的操作定义为准；商品创建/更新所需字段、类目属性、接口版本和弃用状态应以请求当日文档为准，不应把历史字段表硬编码成长期契约。[Ozon Seller API 官方文档](https://docs.ozon.ru/api/seller/)、[Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI)

### 4.2 自动上架的真实边界

- [已证实 | 检索日期：2026-09-11] Ozon 的商品导入并不等于“只传标题和价格”：商品请求需要服从 Seller API 当前的类目、属性、图片、价格、货币、包装尺寸重量、标识等字段约束；具体字段以官方接口定义为准。[Ozon Seller API 官方文档](https://docs.ozon.ru/api/seller/)
- [已证实 | 检索日期：2026-09-11] Ozon 官方更新记录显示 Seller API 会持续调整字段必填性和接口描述，例如 `offer_id` 被标为必填；这意味着 AI 不能根据旧模板静默补齐或省略关键字段。[Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI?before=685)
- [已证实 | 检索日期：2026-09-11] Ozon 官方更新频道还记录 Seller API 的商品操作限额/描述变化，以及商品创建和更新相关接口的持续变更；自动化流程必须保存请求版本、任务 ID/响应和最终状态。[Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI?before=639)
- [推断 | 检索日期：2026-09-11] 对 Ozon 来说，“AI 自动上架”最多应定义为：AI 生成并映射商品草稿，确定性校验器根据当前类目/属性/店铺配置生成缺失清单，用户或策略审批后调用 Seller API，随后轮询导入/审核结果。它不能定义为“AI 直接保证商品已审核、可售或能获得流量”。[依据：[Ozon Seller API](https://docs.ozon.ru/api/seller/)、[Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI)]

### 4.3 对 Ozon GMV Dashboard 的落地建议

- [推断 | 检索日期：2026-09-11] 做商品草稿时，AI 输出应至少包含：`source_evidence`（来源文本/图片/URL）、候选标题/描述、类目候选、属性候选、置信度、未确认字段、禁止自动填写字段、平台规则检查结果。
- [推断 | 检索日期：2026-09-11] 真实包装尺寸、重量、条码/标识、品牌和合规信息应标成“需来源证明/人工确认”；模型可以提示缺失或给出候选，但不能凭常识编造。
- [推断 | 检索日期：2026-09-11] GMV 看板中的 agent 应把“分析/建议”和“执行”分开：例如可以自动分析销量、价格、库存、退货和异常；修改价格、提交商品、归档商品等动作需要权限和审批策略。

## 5. Wildberries：官方 WB API 与自动上架边界

### 5.1 官方商品 API 能力

- [已证实 | 检索日期：2026-09-11] WB API 官方“工作与商品”文档列出能力：创建和编辑商品卡、获取类别/ предмет/ характеристика/品牌、上传媒体、设置搜索标签、设置价格和折扣，以及在卖家仓发货模型下管理库存和仓库。[WB API—工作与商品](https://dev.wildberries.ru/openapi//work-with-products)
- [已证实 | 检索日期：2026-09-11] 官方文档列出创建商品卡的接口 `POST /content/v2/cards/upload`、带关联创建的 `POST /content/v2/cards/upload/add`、编辑商品卡的 `POST /content/v2/cards/update`，并提供商品卡列表和错误列表接口。[WB API—工作与商品](https://dev.wildberries.ru/openapi//work-with-products)
- [已证实 | 检索日期：2026-09-11] WB 官方文档说明创建商品卡是异步的，新的卡片与服务同步可能需要最多 30 分钟；在此期间不能添加仓库库存或设置价格。[WB API—工作与商品](https://dev.wildberries.ru/openapi//work-with-products)
- [已证实 | 检索日期：2026-09-11] WB 官方文档说明编辑商品卡会整体覆盖，因此请求中还要带上不打算修改的参数；编辑返回 HTTP 200 也不代表卡片一定已修改，仍要检查错误列表。[WB API—工作与商品](https://dev.wildberries.ru/openapi//work-with-products)、[WB API 官方新闻/业务流程](https://dev.wildberries.ru/en/news/101)
- [已证实 | 检索日期：2026-09-11] WB 官方文档规定商品卡创建/编辑所需 token 类别和接口限流；官方变更日志还记录了某些 предмет 的关键特征会变成必填，以及 `needKiz`/`kizMarked` 等强制标识相关字段会影响审核/阻断。[WB API 官方文档](https://dev.wildberries.ru/openapi//work-with-products)、[WB API 官方更新日志](https://dev.wildberries.ru/release-notes)

### 5.2 自动上架的真实边界

- [已证实 | 检索日期：2026-09-11] WB 的商品卡创建 API 接受结构化的 subject、特征、尺寸、条码、价格等数据；接口不会替 AI 判断商品属于哪个 предмет，也不会替卖家证明标识、品牌或合规事实。[WB API—工作与商品](https://dev.wildberries.ru/openapi//work-with-products)
- [已证实 | 检索日期：2026-09-11] WB 官方创建/编辑接口的成功响应不能单独作为最终成功信号：创建后有异步同步时间，编辑后需检查错误列表，部分强制标识缺失会导致商品卡无法通过审核或被阻断。[WB API 官方文档](https://dev.wildberries.ru/openapi//work-with-products)、[WB API 官方更新日志](https://dev.wildberries.ru/release-notes)
- [推断 | 检索日期：2026-09-11] 对 WB 来说，AI 自动上架的安全定义应是“生成符合当前 subject/characteristics schema 的可审查草稿 + 调用 Content API + 等待同步 + 回查错误/审核状态”，而不是“一次 POST 200 就显示已上架”。[依据：[WB API 商品文档](https://dev.wildberries.ru/openapi//work-with-products)、[WB API 官方新闻](https://dev.wildberries.ru/en/news/101)]
- [推断 | 检索日期：2026-09-11] 由于 WB 编辑接口是整体覆盖，AI 的局部修改必须先读取完整商品卡，再合并变更，最后提交完整 payload；这是适配器的确定性要求，不应交给模型自行决定。[依据：[WB API 商品文档](https://dev.wildberries.ru/openapi//work-with-products)]

## 6. 三个平台的能力对照

| 平台 | 官方 AI 入口/形态 | 官方 API/后台执行能力 | 明确边界 | 对本项目的启示 |
| --- | --- | --- | --- | --- |
| Shopify | Sidekick + Shopify Magic；自然语言、内容生成、admin 任务、报告、Flow | 平台内直接作用于商品、订单、折扣、集合、报告和工作流 | 修改前 review；第三方工具权限由商家控制 | agent 可绑定业务动作，但要有预览、权限和确认。来源：[Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)、[Shopify Magic](https://help.shopify.com/en/manual/ai-powered-tools/shopify-magic)；检索日期：2026-09-11 |
| Amazon | Seller Assistant；Add Products/A+ Content 的生成式 AI；Rufus 是买家侧 | SP-API 可读写 listings、获取 product type schema、catalog、issues、notifications | listing 生成后仍需 review/approve/submit；Amazon approval/状态独立存在 | 生成与提交解耦，schema/issue/status 是一等数据。来源：[Amazon Seller Central](https://sell.amazon.com/tools/seller-central)、[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)、[Amazon SP-API](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)；检索日期：2026-09-11 |
| Ozon | 本次一手来源核对到 Seller API 商品管理能力，未把通用 AI 生成能力视为 Seller API 契约 | 商品导入/更新、属性/图片/信息等 Seller API 链路 | 当前字段/必填性/限额会变化；导入/审核/可售不是同一状态 | AI 只做草稿和解释，Ozon 适配器负责当前 schema 与任务回查。来源：[Ozon Seller API](https://docs.ozon.ru/api/seller/)、[Ozon 官方更新频道](https://t.me/s/OzonSellerAPI)；检索日期：2026-09-11 |
| Wildberries | 本次一手来源核对到 WB API 商品卡、卖家后台说明和更新日志，未把通用 AI 生成功能视为 WB API 契约 | 创建/关联创建/编辑卡片、媒体、价格、库存等 API | 创建异步；编辑整体覆盖；200 仍需错误回查；标识/关键特征影响审核 | 全量读取-合并-提交-回查，禁止模型直接覆盖卡片。来源：[WB API](https://dev.wildberries.ru/openapi//work-with-products)、[WB API 更新日志](https://dev.wildberries.ru/release-notes)；检索日期：2026-09-11 |

> [推断 | 检索日期：2026-09-11] 三个平台共同的可复用抽象是“候选内容/候选动作 → 平台 schema/权限校验 → 审批 → 执行 → 异步状态”，而不是统一各平台的字段名。统一的是流程状态和审计模型，平台字段映射仍应隔离在 adapter 中。[依据：[Shopify](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)、[Amazon](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)、[Ozon](https://docs.ozon.ru/api/seller/)、[WB](https://dev.wildberries.ru/openapi//work-with-products)]

## 7. LiteLLM、New API、One API：统一网关核对

### 7.1 LiteLLM

- [已证实 | 检索日期：2026-09-11] LiteLLM 上游 README 将项目定义为可自托管的开源 AI Gateway，用统一接口调用 100+ LLM provider，并兼容 OpenAI 格式；既可作为 Python SDK，也可部署为团队/组织的集中式 Proxy Server。[LiteLLM 上游 README](https://github.com/BerriAI/litellm)
- [已证实 | 检索日期：2026-09-11] LiteLLM Proxy 官方文档列出的能力包括 auth hooks、logging hooks、cost tracking 和 rate limiting；README 还列出 virtual keys、spend tracking、guardrails、load balancing、admin dashboard 等生产化能力。[LiteLLM 官方文档](https://docs.litellm.ai/)、[LiteLLM 上游 README](https://github.com/BerriAI/litellm)
- [已证实 | 检索日期：2026-09-11] LiteLLM 官方 quick start 以 `base_url=http://0.0.0.0:4000` 的 OpenAI client 访问 Proxy，并在配置中声明模型、上游 API base/key、master key 和 database URL。[LiteLLM 官方文档](https://docs.litellm.ai/)
- [推断 | 检索日期：2026-09-11] LiteLLM 更适合作为“模型调用基础设施层”：在商品 agent 上游统一模型、路由、重试、成本和日志；Ozon/WB/Shopify/Amazon 的业务工具仍应由应用自己的 adapter/权限层提供。[依据：[LiteLLM README](https://github.com/BerriAI/litellm)、[LiteLLM Proxy 文档](https://docs.litellm.ai/)]

### 7.2 New API

- [已证实 | 检索日期：2026-09-11] New API 上游 README 将其定义为新一代 LLM Gateway 和 AI Asset Management System，并明确用途是合法授权场景下的 AI API gateway、组织级认证、多模型管理、使用分析、成本核算和私有部署。[New API 上游 README](https://github.com/QuantumNous/new-api)
- [已证实 | 检索日期：2026-09-11] New API 官方文档源码列出的核心能力包括 OpenAI 标准格式兼容的统一入口、多通道路由/故障转移/加权分发、内部成本分摊、token 权限/模型访问控制/API 审计、实时用量和成本分析、多租户架构。[New API 文档源码](https://github.com/QuantumNous/new-api-docs-v1/blob/main/content/docs/en/guide/wiki/basic-concepts/project-introduction.mdx)
- [已证实 | 检索日期：2026-09-11] New API README 声明项目采用 AGPLv3，并要求修改后的带 UI 版本保留原项目链接/署名；同时明确使用者需要合法取得上游 API key、账户、模型服务和接口权限。[New API 上游 README](https://github.com/QuantumNous/new-api)
- [推断 | 检索日期：2026-09-11] New API 适合需要内部团队/客户 token、额度、渠道、路由和成本管理的场景，但 AGPLv3 和其合规/授权要求会进入架构评审；不能只把它当作一个无状态的“换 base URL”组件。[依据：[New API README](https://github.com/QuantumNous/new-api)、[New API 文档源码](https://github.com/QuantumNous/new-api-docs-v1/blob/main/content/docs/en/guide/wiki/basic-concepts/project-introduction.mdx)]

### 7.3 One API

- [已证实 | 检索日期：2026-09-11] One API 上游 README 的定位是以标准 OpenAI API 格式访问多种大模型，支持多个模型/渠道、负载均衡、流式响应、token 管理、渠道/用户分组、配额详情和管理 API。[One API 上游 README](https://github.com/songquanpeng/one-api/blob/main/README.en.md)
- [已证实 | 检索日期：2026-09-11] One API 的使用方式是后台配置渠道 API key，再生成访问 token；客户端把 API base 指向 One API 部署地址。若请求没有指定渠道 ID，系统会在多个渠道间做负载均衡。[One API 上游 README](https://github.com/songquanpeng/one-api/blob/main/README.en.md)
- [已证实 | 检索日期：2026-09-11] One API README 声明项目采用 MIT license，并要求页面保留署名和项目链接；README 同时提示 Docker 最新镜像可能是 alpha，要求稳定性时应手动指定版本。[One API 上游 README](https://github.com/songquanpeng/one-api/blob/main/README.en.md)
- [推断 | 检索日期：2026-09-11] One API 更像轻量的多渠道中转、token/配额和运营管理面；若需求重点是模型调用的 provider 适配、路由与观测，LiteLLM 的官方定位更贴近；若需求重点是内部用户/额度/渠道管理，New API/One API 的管理面更直接，但应分别评估许可证、维护状态和安全边界。[依据：[LiteLLM README](https://github.com/BerriAI/litellm)、[New API README](https://github.com/QuantumNous/new-api)、[One API README](https://github.com/songquanpeng/one-api/blob/main/README.en.md)]

### 7.4 网关不能替代 marketplace adapter

- [已证实 | 检索日期：2026-09-11] 三类网关的官方材料描述的对象是 LLM provider/channel、API key、token、路由、配额、日志和成本，并没有声明会处理 Shopify/Amazon/Ozon/WB 的商品类目、属性、库存、审核或卖家权限。[LiteLLM README](https://github.com/BerriAI/litellm)、[New API README](https://github.com/QuantumNous/new-api)、[One API README](https://github.com/songquanpeng/one-api/blob/main/README.en.md)
- [推断 | 检索日期：2026-09-11] 推荐的依赖关系是：

  ```text
  运营后台 / Agent
          ↓
  业务工具层：商品草稿、类目匹配、价格建议、发布审批、状态查询
          ↓
  Marketplace adapters：Shopify / Amazon / Ozon / WB
          ↓
  平台官方 API

  Agent 的模型调用 ──→ LiteLLM 或 New API/One API
  ```

  网关只位于“Agent 的模型调用”一侧，不能把外部平台凭证、平台字段校验和发布审计全部藏在网关里。[依据：[LiteLLM Proxy](https://docs.litellm.ai/)、[Amazon SP-API](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)、[Ozon Seller API](https://docs.ozon.ru/api/seller/)、[WB API](https://dev.wildberries.ru/openapi//work-with-products)]

## 8. 推荐的 AI 运营后台产品边界

### 8.1 第一阶段：只做读和草稿

- [推断 | 检索日期：2026-09-11] 读取商品、订单、库存、价格、广告和审核错误；支持自然语言问数、异常解释、类目/属性候选和文案草稿。
- [推断 | 检索日期：2026-09-11] 每个候选字段必须显示来源、生成时间、模型/网关请求 ID、置信度和是否需要人工确认。
- [推断 | 检索日期：2026-09-11] 将草稿保存为平台无关的 canonical draft，同时保存各平台 adapter 生成的 payload preview；不要只保存最终 JSON。

### 8.2 第二阶段：受控执行

- [推断 | 检索日期：2026-09-11] 低风险动作可按权限自动执行，例如生成报告、打标签、创建内部任务；价格、库存、商品提交、删除/归档、广告预算等动作需要审批或明确的策略阈值。
- [推断 | 检索日期：2026-09-11] 执行前显示“字段差异 + 平台规则检查 + API endpoint + 影响范围”；执行后显示平台任务、审核、同步和可售状态，而不是只显示“请求成功”。
- [推断 | 检索日期：2026-09-11] 为 Ozon/WB 特别保留“平台结果回查”队列：Ozon 关注商品导入/审核状态；WB 关注异步同步、错误列表、标识和关键特征要求。

### 8.3 第三阶段：批量与闭环优化

- [推断 | 检索日期：2026-09-11] 批量发布先支持“批量生成草稿 + 批量校验 + 分批审批 + 可重试提交”，不要直接做无人工闸门的全量自动上架。
- [推断 | 检索日期：2026-09-11] 只有当平台回查结果、人工修改率、错误率和撤回率稳定后，才考虑对低风险字段开放策略化自动提交。
- [推断 | 检索日期：2026-09-11] 模型质量指标不应只看文本好不好看，还应看必填字段通过率、平台拒绝率、人工改动率、审核通过率、GMV/转化变化和错误可解释性。

## 9. 统一事实模型建议（非代码）

### 9.1 草稿字段

```text
Draft
├─ sourceEvidence[]       来源文本、图片、URL、文件及引用片段
├─ normalizedProduct      平台无关的规范化商品信息
├─ marketplaceCandidates  各平台类目/属性/价格/图片候选
├─ validation[]            必填、枚举、单位、权限、合规检查
├─ approval                审批人、审批时间、审批范围、过期时间
├─ execution               endpoint、请求摘要、幂等键、任务 ID
└─ outcome                 accepted / moderating / syncing / rejected / buyable
```

> [推断 | 检索日期：2026-09-11] 该模型把“AI 生成值”和“平台确认值”分开，能够表达 Amazon 的 draft/approval、Ozon 的导入/审核、WB 的创建/同步/错误等不同生命周期；不应把一个布尔型 `published` 当成跨平台真相。[依据：[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)、[Amazon SP-API](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)、[Ozon Seller API](https://docs.ozon.ru/api/seller/)、[WB API](https://dev.wildberries.ru/openapi//work-with-products)]

### 9.2 工具权限

- [推断 | 检索日期：2026-09-11] 将工具拆成读工具、生成工具、预检工具和写工具：`read_catalog`、`read_orders`、`draft_listing`、`validate_listing`、`preview_publish`、`submit_listing`、`poll_listing_status`。模型默认只拥有读/生成/预检权限。
- [推断 | 检索日期：2026-09-11] 写工具要绑定平台、店铺、资源范围、字段白名单、审批策略和幂等键；不能只依赖自然语言提示中的“请谨慎操作”。
- [推断 | 检索日期：2026-09-11] 网关的虚拟 key/团队预算用于控制模型调用成本；marketplace token/OAuth 用于控制平台数据和写入权限，两套凭证必须分离。

## 10. 已证实与推断清单

### 已证实

- Shopify Sidekick/Magic 已将 AI 嵌入 admin 工作流，可生成内容、执行部分任务、生成报告/工作流，并提供 review/权限控制。[Shopify Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)、[Shopify Magic](https://help.shopify.com/en/manual/ai-powered-tools/shopify-magic)
- Amazon 已提供 Seller Assistant、AI listing、批量 draft listing 和 A+ Content 生成；官方流程要求 review/edit/approve，卖家负责准确性和合规。[Amazon Seller Central](https://sell.amazon.com/tools/seller-central)、[Amazon AI listing](https://sell.amazon.com/blog/amazon-listing-ai)
- Rufus 是 Amazon Shopping 的买家侧购物助手；Seller Assistant 是 Seller Central 的卖家侧工具。[Amazon Rufus](https://www.aboutamazon.com/news/retail/amazon-rufus-ai-assistant-personalized-shopping-features)、[Amazon Seller Central](https://sell.amazon.com/tools/seller-central)
- Amazon SP-API 已提供 listing schema、catalog、创建/更新/删除/查询和通知能力，但 listing 生命周期仍包含资格、问题和可售状态维护。[Amazon SP-API](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)
- Ozon 官方 Seller API 具备商品导入/更新、属性/图片/信息等开放接口，官方更新频道显示字段必填性、接口描述和限额会持续变化。[Ozon Seller API](https://docs.ozon.ru/api/seller/)、[Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI)
- WB 官方 API 具备商品卡创建/编辑/关联创建、属性/品牌/媒体/价格/库存相关接口；创建有异步同步窗口，编辑需完整覆盖并回查错误。[WB API](https://dev.wildberries.ru/openapi//work-with-products)、[WB API 官方更新日志](https://dev.wildberries.ru/release-notes)
- LiteLLM、New API、One API 都是围绕 LLM 供应商/渠道/模型调用的统一网关或中转管理项目，不是 marketplace 商品发布适配器。[LiteLLM](https://github.com/BerriAI/litellm)、[New API](https://github.com/QuantumNous/new-api)、[One API](https://github.com/songquanpeng/one-api/blob/main/README.en.md)

### 推断

- AI 运营后台应采用“候选生成 + 确定性校验 + 审批 + 平台执行 + 异步回查”，而不是让模型直接拥有 marketplace 写权限。
- 统一网关应与 marketplace adapter 解耦：网关管理模型调用，adapter 管理平台字段、权限、限流、幂等、审核和状态。
- Ozon/WB 的自动上架边界是“自动化调用官方 API”而非“绕过类目、属性、标识、审核和同步规则”。
- 对当前项目，最有价值的第一步是建立跨平台草稿/验证/执行状态和差异预览，再选择 LiteLLM 或 New API/One API 作为模型基础设施。

## 11. 来源索引（均为一手来源）

### Shopify

- [Shopify Help Center：AI-powered tools](https://help.shopify.com/en/manual/ai-powered-tools)（官方帮助中心；检索日期：2026-09-11）
- [Shopify Help Center：Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick)（官方帮助中心；检索日期：2026-09-11）
- [Shopify Help Center：Generating content with Sidekick](https://help.shopify.com/en/manual/ai-powered-tools/sidekick/generate-content)（官方帮助中心；检索日期：2026-09-11）
- [Shopify Help Center：Shopify Magic](https://help.shopify.com/en/manual/ai-powered-tools/shopify-magic)（官方帮助中心；检索日期：2026-09-11）

### Amazon

- [Amazon Seller Central](https://sell.amazon.com/tools/seller-central)（官方卖家站点；检索日期：2026-09-11）
- [Amazon：How to use Amazon AI to create product listings](https://sell.amazon.com/blog/amazon-listing-ai)（官方博客；检索日期：2026-09-11）
- [Amazon SP-API：Manage Product Listings](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)（官方开发者文档；检索日期：2026-09-11）
- [Amazon：Rufus / Alexa for Shopping](https://www.aboutamazon.com/news/retail/amazon-rufus-ai-assistant-personalized-shopping-features)（官方博客；检索日期：2026-09-11）

### Ozon

- [Ozon Seller API 官方文档](https://docs.ozon.ru/api/seller/)（官方 API 文档入口；检索日期：2026-09-11）
- [Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI)（官方 Telegram 更新频道；检索日期：2026-09-11）
- [Ozon Seller API 官方更新频道：2026-07-10 商品接口变更](https://t.me/s/OzonSellerAPI?before=685)（官方更新；检索日期：2026-09-11）

### Wildberries

- [WB API：工作与商品](https://dev.wildberries.ru/openapi//work-with-products)（官方 API 文档；检索日期：2026-09-11）
- [WB API：官方更新日志](https://dev.wildberries.ru/release-notes)（官方 API 更新日志；检索日期：2026-09-11）
- [WB API：商品业务流程说明](https://dev.wildberries.ru/en/news/101)（官方开发者新闻/流程说明；检索日期：2026-09-11）
- [WB Seller：如何创建商品卡](https://seller.wildberries.ru/instructions/uz/ru/material/how-to-create-card)（官方卖家帮助；检索日期：2026-09-11）

### 统一网关

- [LiteLLM 上游仓库 README](https://github.com/BerriAI/litellm)（GitHub 上游仓库；检索日期：2026-09-11）
- [LiteLLM 官方文档](https://docs.litellm.ai/)（官方文档；检索日期：2026-09-11）
- [New API 上游仓库 README](https://github.com/QuantumNous/new-api)（GitHub 上游仓库；检索日期：2026-09-11）
- [New API 官方文档源码：Project Introduction](https://github.com/QuantumNous/new-api-docs-v1/blob/main/content/docs/en/guide/wiki/basic-concepts/project-introduction.mdx)（GitHub 上游文档仓库；检索日期：2026-09-11）
- [One API 上游仓库 README](https://github.com/songquanpeng/one-api/blob/main/README.en.md)（GitHub 上游仓库；检索日期：2026-09-11）
