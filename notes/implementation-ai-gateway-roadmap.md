# GMV AI Relay 与 GMV AI 能力分阶段实现计划

> 计划状态：提案
>
> 当前 GMV 版本基线：`1.5.13`
>
> 目标：先为 `ozon-gmv-dashboard` 增加“商品信息自动生成生图提示词”能力；图片生成、商品草稿、Ozon 上架和自动化执行放到后续版本。AI 中转既能作为局域网安装包运行，也能迁移到服务器。

## 1. 总体决策

### 1.1 两个独立发行物

建议把系统拆成两个可以独立升级的发行物：

```text
GMV Dashboard
├─ 商品、店铺、数据、草稿、审批、Ozon/WB 业务
└─ 通过内部接口调用 GMV AI Relay

GMV AI Relay
├─ 模型路由、供应商密钥、Token、限流、用量、日志
├─ LiteLLM / New API 运行时
└─ OpenAI、DeepSeek、GLM、Kimi、本地模型
```

Relay 不读取 GMV SQLite，不持有 Ozon 店铺凭据，也不能执行商品发布。GMV 后端不保存上游模型 Key，只持有 Relay Token。两者初期可以在同一个代码仓库中用独立目录/包开发，但构建、配置、数据目录和版本号应保持独立。

### 1.2 统一的模型别名

GMV 业务代码和页面不直接写供应商模型名，统一使用能力别名：

| 别名 | 能力 | 第一阶段用途 |
| --- | --- | --- |
| `text.fast` | 快速文本生成 | 简单文案、字段改写、批量任务 |
| `text.quality` | 高质量文本生成 | 商品标题、卖点、俄语详情 |
| `vision.extract` | 图片理解/结构化抽取 | 图片识别商品事实和缺失字段 |
| `image.generate` | 文字生成商品图 | 场景图、背景图、营销图 |
| `image.edit` | 图片编辑 | 换背景、修图、尺寸适配 |

Relay 维护别名到真实模型的映射和能力矩阵。业务模块只请求能力，不关心具体厂商；但每次 AI 运行必须记录实际模型、网关版本和工作流版本。

### 1.3 必须保留的业务原则

- AI 输出默认是候选或草稿，不是事实。
- 价格、库存、条码、尺寸、重量、品牌、合规属性优先来自业务数据或人工确认。
- Ozon 上架必须经过字段校验、请求预览和审批。
- AI 不允许直接调用“任意发布商品”工具。
- AI Relay 不记录完整商品 Prompt、客户信息和原始图片，默认只记录审计摘要、耗时、用量、错误和 request ID。
- Relay 不可用时，GMV 原有数据看板和人工发布流程仍能工作。
- 首个业务版本只生成提示词和参数建议，不调用图片生成接口，不创建商品，不修改价格/库存，不提交 Ozon。

## 2. 版本总览

| 版本 | 发行物 | 目标 | 是否允许平台写操作 |
| --- | --- | --- | --- |
| R0 | 设计与验证 | 完成网关选型、能力矩阵、安装包可行性验证 | 否 |
| Relay `0.1.0` | AI Relay | 局域网/Compose POC，打通官方 API Key 和团队 Token | 否 |
| GMV `1.6.0` | GMV Dashboard | AI 基础模块、状态页、运行记录和统一接口 | 否 |
| Relay `0.2.0` | AI Relay | Windows 局域网安装包，支持服务化、配置和升级 | 否 |
| GMV `1.7.0` | GMV Dashboard | 生图提示词工作流增强：多方案、模板、反馈和历史 | 否 |
| GMV `1.8.0` | GMV Dashboard | GPT Image 2.5 生图/编辑和素材管理 | 否 |
| GMV `1.9.0` | GMV Dashboard | AI 商品文案、图片转商品信息和商品草稿 | 否 |
| GMV `2.0.0` | GMV Dashboard | Ozon 类目/属性映射、发布预检和请求预览 | 否 |
| GMV `2.1.0` | GMV Dashboard | 人工确认后的 Ozon 提交和异步状态回查 | 仅审批后 |
| Relay `1.0.0` + GMV `2.2.0` | 两者 | 服务器部署、备份、HTTPS、正式运维 | 仅审批/策略后 |
| GMV `2.3.0` | GMV Dashboard | 批量草稿、批量校验、有限白名单自动提交 | 仅白名单 |

版本号是建议的发布线，不要求一次跨越多个现有业务版本；每个版本完成并回归后再进入下一个版本。

## 3. R0：架构与可行性验证

### 目标

先确认“模型能力、网关能力、安装方式”都可行，再进入 GMV 业务开发。

### 工作项

1. 建立模型能力矩阵：文本、视觉、结构化输出、工具调用、流式和图片接口逐项验证。
2. 用 LiteLLM 和 New API 各做最小 POC，比较：
   - OpenAI/DeepSeek/GLM/Kimi 的接入难度；
   - 多成员 Token、限流、用量和成本；
   - `/chat/completions`、`/responses`、视觉和 `/images` 支持；
   - 错误映射、超时、重试和故障切换；
   - 许可证、升级和日志脱敏。
3. 暂不验证 GPT Image 2.5 生图接口；只记录它作为后续版本的独立能力和验收项。
4. 验证 Windows 干净环境的安装路线：
   - 固定版本运行时直接服务化；
   - 或安装器管理固定版本容器运行时/Compose。
5. 输出一份配置 schema、模型别名清单、Provider 能力表和恢复手册。

### 验收条件

- 四个测试 Token 可以分别调用指定模型，并能撤销或限流。
- 至少两家文本供应商和一个视觉模型可正常调用。
- 文本结构化输出可以稳定生成提示词候选；GPT Image 2.5 不属于本阶段验收范围。
- Gateway 重启后配置、Token、用量记录不丢失。
- 未配置 AI 或 Gateway 不可用时，GMV 旧功能不受影响。
- 在没有明确结论前，不把 LiteLLM 或 New API 写死进 GMV 业务代码。

## 4. Relay `0.1.0`：网关 POC

### Relay 侧模块

建议初期使用独立目录 `ai-relay/`，内部至少包含：

```text
ai-relay/
├─ config/              配置 schema、模型别名、Provider 映射
├─ gateway/             LiteLLM 或 New API 的启动与适配
├─ control-plane/       初始化、Token、健康状态、诊断
├─ storage/             PostgreSQL/本地配置和备份
├─ security/            密钥注入、脱敏、来源限制
└─ deployment/          Compose、环境模板、升级脚本
```

### 第一版只提供的接口

```text
GET  /health
GET  /ready
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
```

管理接口和数据面接口分开。管理接口默认只允许回环访问；数据面启用局域网后才开放，并为每个使用者生成独立 Token。

### 验收条件

- Relay 可通过 OpenAI 兼容客户端调用文本和视觉能力。
- 业务端只需要修改 `baseURL` 和 Token，不需要知道上游 Key。
- provider Key 不出现在 GMV 浏览器、Git、镜像层和普通日志中。
- 所有请求都有 request ID；日志包含模型别名、实际模型、延迟、结果状态和用量摘要。
- 结构化输出失败时返回可识别错误，不把错误 JSON 当作成功结果。

## 5. GMV `1.6.0`：AI 基础模块（与提示词功能同版本）

### 目标

先让 GMV 有稳定、可测试、可替换的 AI 接口，不立即做复杂 Agent。

### 推荐模块与 seam

```text
src/server/ai/
├─ gateway-client.ts       GMV 唯一的 Relay 调用接口
├─ capability-registry.ts  能力别名和模型能力
├─ workflow-runner.ts       工作流执行、超时、request ID
├─ output-schemas.ts        Zod 结构化输出
├─ redaction.ts             脱敏和最小上下文
├─ run-repository.ts        AI 运行记录
└─ workflows/               各业务工作流
```

`AiGatewayClient` 是 GMV 的外部 seam，调用方只需要知道输入、输出、超时、错误模式和能力要求；供应商协议、重试、鉴权和模型路由全部藏在实现后面。这样后续替换 LiteLLM、New API 或自研 Relay 时，不需要修改商品业务模块。

### 初始接口建议

```ts
interface AiGatewayClient {
  completeText(input: TextGenerationInput): Promise<TextGenerationResult>;
  analyzeImage(input: ImageAnalysisInput): Promise<ImageAnalysisResult>;
  generateImage(input: ImageGenerationInput): Promise<ImageGenerationResult>;
  getCapabilities(): Promise<AiCapabilities>;
}
```

业务工作流不直接接收任意 Prompt，而是接收结构化输入并返回结构化候选。所有输出进入 Zod 校验，失败进入 `needs_review` 或 `failed`，不能静默降级成业务数据。

### 数据模型

新增独立 AI 运行记录，避免把完整 Prompt 塞进现有商品表：

```text
ai_runs
├─ workflow_name / workflow_version
├─ model_alias / actual_model
├─ input_hash / source_refs
├─ status / error_code
├─ output_summary / usage_summary
├─ created_by / created_at
└─ request_id
```

图片和大文件继续使用现有图片资产/对象存储链路，数据库只保存资产引用、生成参数摘要和来源关系。

### GMV 页面

新增一个轻量“AI 设置/状态”区域：Gateway 地址、连接状态、可用能力、当前模型别名和最近失败原因。第一版不做完整 AI 对话页面，避免先引入一个与业务脱节的聊天入口。

## 6. Relay `0.2.0`：Windows 局域网安装包

### 目标

让团队成员可以在一台闲置 Windows 电脑上安装、配置和运行中转服务。

### 安装包职责

发行物建议命名为 `GMV-AI-Relay-Setup-x.y.z.exe`，复用当前 GMV 的 WinSW、Inno Setup、健康检查、ACL、升级前备份和失败回滚经验，但不与 GMV 安装包强耦合。

安装器应提供：

- 首次配置向导；
- 固定版本 Gateway 运行时和依赖；
- 服务安装、启动、停止、重启和状态检查；
- 默认回环监听，显式开启后才允许局域网访问；
- Private 网络 + Local Subnet 防火墙规则；
- 每个成员/客户端独立 Token；
- Provider Key 写入受 ACL 保护的数据目录；
- 端口冲突检查、健康检查、日志导出；
- 配置/数据库备份、升级和失败回滚；
- 卸载时默认保留数据，明确确认后才删除。

### 关键决策门

在 R0 的干净 Windows 测试中决定“内置运行时”还是“容器前置条件”。安装包不能只在开发机成功，必须验证未安装 Node、Python、Docker 和 PostgreSQL 的干净机器。

如果 LiteLLM 的原生运行时难以稳定打包，则第一版仍可先发布 Compose 运维包，暂缓面向普通成员的一键安装器；不要为了追求单文件安装包而引入两套长期维护的网关实现。

## 7. GMV `1.6.0` 功能：第一步——自动生成生图提示词

### 7.1 生图提示词工作流

本版本不做商品文案、不做图片生成、不做 Ozon 上架，只在现有商品发布工作台增加“生成生图提示词”入口：

```text
商品事实：名称、类目、属性、材质、颜色、目标人群
    ↓
选择图片用途、场景、风格、比例和平台要求
    ↓
AI 生成多套生图提示词候选
    ↓
查看主提示词、负面提示词、构图、灯光、背景和尺寸参数
    ↓
选择、复制、编辑或重新生成；保存到提示词历史
```

每个商品建议生成 3 套候选，输出结构固定为：

```text
PromptCandidate
├─ prompt                 主提示词
├─ negativePrompt         负面提示词
├─ subjectProtection      商品外观不可改变的约束
├─ composition            构图和镜头
├─ lighting               灯光
├─ background             背景/场景
├─ style                  视觉风格
├─ aspectRatio            推荐比例
├─ intendedUse            主图/场景图/详情页/广告图
└─ warnings[]             需要人工确认的事项
```

必须保存：来源商品、输入事实摘要、工作流版本、模型、生成时间、候选值、人工修改值和警告。提示词历史与商品草稿关联，但不改变商品最终字段。

### 7.2 不在本版本做的事情

- 不调用 `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare`。
- 不上传生成图片，不接入对象存储图片结果。
- 不创建 `resell_tasks`，不调用 Ozon 商品导入、图片、价格或库存接口。
- 不让模型执行任何业务工具，只允许返回经过 Zod 校验的提示词 JSON。

### 验收条件

- 同一商品的不同类目、用途和风格能够生成不同提示词，而不是简单替换商品名称。
- 每次至少返回 3 套结构完整、可复制的候选。
- 商品事实中的品牌、颜色、结构和不可改变项会出现在商品保护约束中。
- 无法从商品事实确定的内容进入 `warnings[]`，不由模型擅自补成商品事实。
- AI 失败或超时可以重试，不影响原有商品发布工作台。
- 用户可以编辑和复制提示词，刷新页面后仍能查看历史版本。

## 8. GMV `1.7.0`：提示词工作流增强

在第一版提示词生成稳定后，再增加：

- 俄语商品事实到英文生图提示词的稳定转换；
- 按主图、场景图、详情页、广告图提供模板；
- 按店铺品牌风格保存可复用规则；
- 用户反馈“更像真实商品/更适合白底/更生活化”等偏好；
- 批量为选中的商品生成提示词，但仍不生成图片。

## 9. GMV `1.8.0`：GPT Image 2.5 图片工作流

### 目标

接入 `gpt-image-2.5-sunburst` / `gpt-image-2.5-flare`，但把生图作为独立的异步素材任务，不混入普通文本请求。

### 工作流

```text
商品事实 + 原图 + 生图要求
    ↓
生成/编辑任务
    ↓
任务状态：queued → running → completed/failed
    ↓
保存到对象存储和商品图片资产
    ↓
人工选择主图/删除/重新生成
```

### 必须验证

- Image API 和 Responses API 的实际调用方式；
- Gateway 对图片接口、参考图、多图输入和返回格式的支持；
- 图片大小、耗时、费用和并发限制；
- 生成图片上传到 Ozon 前的格式、尺寸、URL 可访问性和压缩；
- 生成失败、供应商限流、重复提交和任务恢复。

如果所选 Gateway 对 GPT Image 2.5 的图片接口支持不完整，可以由 Relay 自己提供图片适配器，但 GMV 仍只访问 Relay，不能把 OpenAI Key 下放到 GMV。

## 10. GMV `1.9.0`：AI 商品文案与商品草稿

### 目标

把“文案、生图、图片理解”组合成平台无关的商品草稿，并复用现有发布工作台和 Ozon 预检能力。

### 草稿流程

```text
来源商品/图片
    ↓
规范化商品事实 canonical product
    ↓
AI 候选：标题、描述、类目、属性、图片
    ↓
平台适配器：Ozon schema/属性/图片/价格/库存
    ↓
发布预检和差异预览
    ↓
人工确认
```

### 与现有代码的结合点

- 复用 `publish_drafts` 保存来源快照和人工覆盖，不重复建一套商品编辑器。
- 复用 `ResellModule` 的预检、任务状态、幂等键和 Ozon 导入链路。
- 复用 `src/server/ozon/client.ts` 已有的商品导入、属性、图片、价格、库存和任务回查能力。
- 新增 AI 来源、字段来源、校验警告和生成记录关联；不要把 AI 输出直接写入 `resell_tasks` 的最终执行字段。

### 建议接口

```text
POST /api/ai/product-copy
POST /api/ai/product-vision
POST /api/ai/product-image
POST /api/ai/publish-drafts/:id/generate
POST /api/ai/publish-drafts/:id/validate
GET  /api/ai/runs/:id
```

这些接口全部要求 GMV 管理员会话。接口返回候选或任务，不执行 Ozon 写操作。

## 11. GMV `2.0.0`：Ozon 发布预检

### 目标

开放真正的上架，但把审批、校验和平台状态拆成可审计的步骤。

```text
草稿
  ↓
字段差异 + 校验结果 + Ozon payload 预览
  ↓
管理员确认
  ↓
创建发布任务 + 幂等键
  ↓
Ozon 商品导入/图片/价格/库存接口
  ↓
任务和审核状态回查
  ↓
created / moderating / sellable / needs_input / failed
```

提交接口必须满足：

- 只允许管理员会话或一次性审批令牌；
- 审批内容与实际提交 payload 有 hash 关联；
- 重新编辑草稿后旧审批自动失效；
- 有幂等键，重复点击不会重复创建商品；
- 记录 Ozon endpoint、响应摘要、任务 ID、回查结果和失败原因；
- 成功 HTTP 响应不直接显示为“已上架”，必须等待平台状态回查。

第一版不开放 AI 直接修改价格、库存、品牌、条码、尺寸重量和合规字段。

## 12. GMV `2.1.0`：人工审批后提交 Ozon

本版本才开放真正的 Ozon 写操作：

- 商品草稿必须经过字段差异、平台规则和 payload 预览；
- 只允许管理员会话或一次性审批令牌；
- 记录 Ozon endpoint、幂等键、任务 ID、回查结果和失败原因；
- 成功 HTTP 响应不直接等于已上架，必须等待平台状态回查。

## 13. Relay `1.0.0` + GMV `2.2.0`：服务器部署和正式运维

### 服务器形态

使用与本地 POC 相同的镜像和配置模型：

```text
reverse proxy / HTTPS
        ↓ internal network
ai-gateway
        ├─ PostgreSQL
        ├─ optional object storage
        └─ optional metrics/log collector
```

服务器版需要：

- Docker Compose 单机部署；
- 固定镜像版本或 digest，不使用生产 `latest`；
- PostgreSQL 备份和恢复演练；
- Provider Key 通过 secrets/环境注入；
- API 和管理页面的访问控制；
- 反向代理 HTTPS，模型 API 路径绕过缓存；
- 健康检查、自动重启、告警、升级和回滚；
- 图片对象存储的生命周期和权限控制。

只有出现多副本、跨节点高可用、集中 Secret、弹性扩容等需求时，才考虑 Kubernetes/Helm。

## 14. GMV `2.3.0`：批量和有限自动化

在人工审批链路稳定后，增加：

- 批量生成草稿；
- 批量规则校验；
- 按错误类型分组修复；
- 分批审批和分批提交；
- 白名单商品的策略化自动提交；
- 失败暂停、重试、回滚和审计。

自动化资格至少基于：平台必填字段通过率、审核拒绝率、人工修改率、重复提交率、图片失败率和历史撤回率。不能只根据文案质量决定是否自动上架。

## 15. Skill 的工程化接入

不把 ChatGPT/Codex 中已有 Skill 当作 GMV 可直接调用的远程函数。建议在项目中建立可审查、可版本化的工作流目录：

```text
skills/
├─ product-copy/
│  ├─ SKILL.md
│  ├─ input.schema.json
│  ├─ output.schema.json
│  └─ examples/
├─ product-vision/
├─ product-image/
└─ product-listing/
```

每个 Skill 只描述输入事实、输出结构、提示模板、示例和校验规则；真正的 Ozon 查询、图片存储、发布预检和提交工具由 GMV 后端实现。这样可以把“上架 Skill”映射成 `product-listing` 工作流，把“生图 Skill”映射成 `product-image` 工作流，同时保持对不同模型供应商的可移植性。

## 16. 测试与发布门禁

每个版本必须满足：

- `npm run typecheck` 通过；
- `npm test` 通过；
- Relay 契约测试覆盖成功、超时、限流、错误 JSON、供应商不可用和重启恢复；
- AI 输出 Schema 测试覆盖缺字段、越界、枚举错误和恶意文本；
- Ozon 适配器测试覆盖 payload 预览、幂等、异步回查和重复提交；
- 图片任务测试覆盖对象存储失败、重复生成和失败重试；
- Gateway 宕机时原有 GMV 数据和人工发布流程可用；
- Windows 干净机、Private/Public 网络、服务重启、升级失败回滚各验证一次；
- 服务器完成备份恢复演练后才能标记正式部署。

## 17. 当前下一步

建议先执行 R0 和 GMV `1.6.0`，不开发 AI 聊天页面、生图和自动上架：

1. 建立 LiteLLM/New API 对比配置和模型能力矩阵。
2. 打通 OpenAI、DeepSeek、GLM、Kimi 中至少两家文本模型和结构化输出；视觉、生图接口留到后续版本。
3. 在闲置 Windows 电脑验证网关运行时的安装包可行性。
4. 确认 Relay 的认证、日志、数据目录和备份格式。
5. R0 通过后，实现 GMV `1.6.0` 的 `src/server/ai` 基础模块、AI 状态页和生图提示词工作流。

本计划基于项目当前的 Windows 服务安装链路、Docker Compose、`publish_drafts`、Ozon 商品接口和既有任务状态设计；实施时仍需以当日供应商接口、许可证和 Ozon 官方文档为准。
