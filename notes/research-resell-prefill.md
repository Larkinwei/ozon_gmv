# 一键跟卖：按 SKU 自动回填商品详情调研

> 调研日期：2026-08-20
> 范围：进入一键跟卖页面时，是否可以按 Ozon SKU 自动补齐标题、图片、描述、属性等商品信息；同时核对 Ozon Seller API 和 GitHub 开源实现。
> 结论性质：本文件是调研结果，不代表已经修改业务代码。

## 结论

可以实现，但需要把“商品信息来源”分成两种情况：

1. **SKU 已经属于自己的某个 Ozon 店铺**：可以用该源店铺的 Seller API 查询完整商品卡，再把结果作为跟卖页面草稿。这个方案最可靠，适合自动补齐标题、图片、描述、类目和已提交的属性。
2. **SKU 只是公开市场商品，未属于自己的店铺**：Ozon Seller API 没有一个明确承诺“按任意公开 SKU 读取完整商品卡”的预览接口。官方支持的动作是 `import-by-sku`，即直接向目标店铺创建商品副本并返回异步任务；它不是只读查询，不能在用户编辑前安全地当作预览调用。

因此，当前一键跟卖页可以做到“自动回填”，但推荐采用分层策略：

- 先用现有 MY 快照立即填充标题、SKU、商品链接、主图和价格参考；
- 如果用户选择了源店铺，再通过源店铺 Seller API 补齐完整商品卡；
- 如果没有源店铺，允许从公开商品链接读取可见的标题和图片作为补充，但这属于网页解析，不是官方 Seller API，必须显示为“公开页补充”，并允许用户逐项修改；
- 正式提交仍使用目标店铺自己的 `offer_id`、价格、VAT、图片 URL、仓库和库存；不能复制源店铺的报价或凭据。

## 官方 Seller API 能力矩阵

官方文档入口：

- [Ozon Seller API 文档](https://docs.ozon.ru/api/seller/)
- [Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI)

| 能力 | 接口 | 能否用于自动回填 | 关键边界 |
| --- | --- | --- | --- |
| 按 Ozon SKU 创建目标店铺商品 | `POST /v1/product/import-by-sku` | 能用于“快速创建”，不能当作无副作用预览 | 返回异步 `task_id`；实际复制哪些字段、是否允许复制，以 Ozon 任务结果和目标店铺规则为准 |
| 查询自己店铺的商品主信息 | `POST /v3/product/info/list` | 可以 | 主要面向当前 API Key 所属卖家的商品；可用于确认商品名、SKU、价格、状态、类目标识和图片等 |
| 查询自己店铺的商品属性 | `POST /v4/product/info/attributes` | 可以 | 返回的是卖家商品属性；动态属性必须按类目加载，不能使用一套固定字段 |
| 查询商品描述 | `POST /v1/product/info/description` | 可以 | 适合补齐自己店铺已有商品的描述，不能保证任意公开 SKU 都能查询 |
| 查询图片处理状态/图片信息 | `POST /v2/product/pictures/info` | 可以 | 主要用于确认已提交到目标店铺的图片状态 |
| 更新商品图片 | `POST /v1/product/pictures/import` | 提交阶段可以 | 传入全部图片列表会替换当前图片集合；图片必须是 Ozon 可访问的公开 HTTPS 图片 |
| 完整创建或编辑商品 | `POST /v3/product/import` | 可以 | 适用于编辑后上架；标题、类目、属性、尺寸、重量、价格和图片等字段受类目规则约束 |
| 内容评分/评价指标 | `POST /v1/product/rating-by-sku` | 只能补充评分指标 | 这是内容评分相关接口，不等同于完整的买家评价文本或媒体，不应作为商品发布必填数据 |

Ozon 官方更新频道在 2026 年 7 月记录了商品接口契约调整：`/v3/product/info/list` 删除了响应中的 `items.images360`，`/v1/product/pictures/import` 删除了请求中的 `images360`，`/v2/product/pictures/info` 删除了 `photo_360`。实现时必须以当前 Seller API 契约为准，不能照搬旧示例。

来源：[Ozon Seller API 官方更新频道（2026-07 商品接口更新）](https://t.me/s/OzonSellerAPI?after=394&q=%23operation)

### SKU、Offer ID 和 Product ID 不能混用

- `sku`：Ozon 商品目录/展示卡的 SKU；
- `offer_id`：当前卖家自己的店铺货号；
- `product_id`：目标店铺创建成功后返回的商品 ID。

跟卖页的源 SKU 可以用于匹配或创建，但目标店铺的 `offer_id` 必须独立生成；不能把源店铺的 `offer_id`、库存、仓库和价格直接复制到目标店铺。

## 图片是否可以自动补齐

可以，但不同来源的可靠性不同。

### 源店铺 API

如果源 SKU 在自己的源店铺中，可以由源店铺 API 返回图片列表，读取当前图片顺序，再将图片作为目标店铺跟卖草稿。正式提交时建议把图片下载后重新上传到当前项目配置的 OSS 前缀 `ozon/resell-images/`，再把稳定的 HTTPS 地址传给 Ozon。

这样做的原因：

- Ozon 创建/更新商品接口要求图片地址来自公开可访问的云存储；
- Ozon CDN 的图片虽然可能能在浏览器展示，但不能把长期可访问、无防盗链、无过期作为工程保证；
- 自有 OSS 便于去重、压缩、排序、失败重试和审计。

官方文档的商品导入说明了：商品图片以公开云存储直链传入，图片数组顺序就是站内展示顺序；若不单独传 `primary_image`，通常以图片数组第一张作为主图。当前图片数量和字段限制应以实际版本文档为准。

来源：[Ozon 商品导入和图片接口说明（公开文档镜像，字段用于核对，非替代官方规范）](https://github.com/Slimpers/Ozon-API-parser-MD/blob/main/md/seller/operations/ProductAPI/POST%20v3-product-import.md)

### 公开商品页

如果只有商品链接，可以通过商品页的结构化数据、页面脚本状态或已登录浏览器上下文提取标题和图片。GitHub 上的 `aleonov57/parser-ozon` 展示了用 Playwright 打开公开商品页、收集画廊缩略图并转换为高清 CDN 地址的做法。

但这是网页解析方案，不是 Ozon 官方 Seller API：

- 页面结构、字段名和嵌入 JSON 可能随时变化；
- 需要处理懒加载、登录、验证码、地区、代理和反爬；
- 图片直链可能存在 CDN 防盗链或访问策略变化；
- 页面中“推荐商品/广告/相似商品”不能当作当前商品图片，必须按当前商品 SKU 和主卡片边界过滤。

来源：[aleonov57/parser-ozon：用 Playwright 抓取商品图片](https://github.com/aleonov57/parser-ozon)

## 推荐的自动回填流程

### 方案 A：源店铺优先（推荐）

1. 在 MY 商品行进入跟卖页时先展示本地快照，页面立即可用。
2. 增加“源店铺”可选项，只列出当前管理员配置的店铺。
3. 选择源店铺后，后端用源店铺凭据按 SKU 查询商品主信息、属性和描述。
4. 用源店铺返回结果补齐标题、图片、类目、属性、重量/尺寸和描述；仅补齐空字段，不覆盖用户已经编辑的值。
5. 图片先下载并上传到 `ozon/resell-images/`，页面记录资产 ID；最终提交只使用后端重新解析出的资产，不信任前端直接传入的 URL。
6. 用户切换目标店铺后，重新校验目标店铺的货币、VAT、仓库、类目属性和库存规则。

### 方案 B：公开链接补充

1. 没有源店铺时，使用 MY 中已有的商品链接作为唯一输入。
2. 由浏览器/扩展或后端受控解析商品页，严格校验页面商品 SKU 与输入 SKU 一致。
3. 只提取当前商品卡的标题、图片和可验证的结构化字段，不采集推荐、广告和相似商品。
4. 解析失败时保留 MY 快照，不阻塞跟卖；页面明确显示“公开页未补齐”。
5. 图片下载后上传 OSS，不将页面 CDN 链接直接作为长期发布依赖。

### 方案 C：快速创建后回读

适用于用户不需要在创建前编辑全部字段的场景：

1. 用户确认目标店铺、Offer ID、价格、VAT、履约模式、仓库和库存。
2. 调用官方 `import-by-sku` 创建商品并轮询 `import/info`。
3. 获取目标店铺返回的 `product_id` 后，再调用商品信息、属性和图片接口回读结果。
4. 结果页展示 Ozon 实际接收的标题、图片、属性、审核状态和缺失字段。

这个方案更接近 Ozon 官方支持路径，但不能满足“先完整编辑再提交”的所有需求；适合快速创建模式。

## 当前项目的差距

当前 `ResellModule.getSource()` 主要读取 MY 最新快照：

- `productName`
- `productUrl`
- 单个 `imageUrl`
- 价格、销量、采集日

因此当前页面只有一张主图是符合现有数据契约的，不是图片编辑器本身丢失了其他图片。要补齐多图，需要新增“源商品详情”读取流程和图片资产绑定，而不是只改前端展示。

## GitHub 开源案例

以下项目可以借鉴接口封装和解析思路，但都不能替代 Ozon 官方契约：

| 项目 | 可借鉴内容 | 局限 |
| --- | --- | --- |
| [a-ulianov/OzonAPI](https://github.com/a-ulianov/OzonAPI) | Python 异步 Seller API 客户端；覆盖 `import-by-sku`、商品信息、属性、描述、图片和评分接口 | SDK 版本和字段可能落后于当前官方契约；没有完整的本项目跟卖 UI/幂等流程 |
| [irenicaa/ozon-seller](https://github.com/irenicaa/ozon-seller) | 通过独立模块封装商品信息、属性、描述、图片、价格和库存接口 | 主要是接口库，不是公开商品详情抓取器 |
| [Oxonomy/ozon-seller-mcp](https://github.com/Oxonomy/ozon-seller-mcp) | 将 `product_info`、`product_info_list`、属性、描述和图片导入能力封装成可调用工具 | 面向 MCP/卖家自有商品；不能证明任意公开 SKU 都能被 Seller API 只读读取 |
| [salacoste/ozon-daytona-seller-api](https://github.com/salacoste/ozon-daytona-seller-api) | TypeScript SDK 的商品管理、图片、属性和评分接口示例 | 需要核对其版本与当前官方接口；不能直接复制到本项目 |
| [aleonov57/parser-ozon](https://github.com/aleonov57/parser-ozon) | Playwright 抓公开商品页图片，处理懒加载和图片尺寸 | 非官方网页解析，受验证码、页面结构和 CDN 策略影响 |

这些项目中没有发现一个可以稳定地用“任意公开 SKU + Seller API”返回完整商品卡并直接完成预填的官方级方案。可复用的是接口客户端、图片 URL 解析、分页/重试和 Playwright 页面采集模式。

## 难度评估

| 范围 | 难度 | 估计 |
| --- | --- | --- |
| 源店铺 API 查询并回填标题/图片/属性 | 中 | 需要源店铺选择、凭据隔离、SKU 匹配和字段合并 |
| 快速创建后回读 Ozon 实际商品信息 | 中 | 现有创建任务和轮询流程可复用，需增加回读和结果展示 |
| 公开商品链接解析标题/多图 | 中高 | 需要处理懒加载、反爬、地区、代理和结构变化 |
| 编辑模式动态属性表单 | 高 | 类目属性、字典值、合规字段和图片规则是动态的 |
| 保证“提交后已上架” | 不可完全保证 | 受复制权限、类目、审核、证书、标记、仓库和库存状态影响 |

建议先做一个 SKU、一个源店铺、一个目标店铺的灰度验证，再扩展到公开页补充。先验证三类商品：普通无证书商品、需要类目属性的商品、图片数量超过一张的商品。

## 实施建议（后续开发时）

1. 新增只读接口 `GET /api/selection/resell/source/:sku?sourceStoreId=...`，返回来源、字段置信度和图片列表；不返回 API Key。
2. 新增“刷新源商品详情”按钮，自动回填前只覆盖空字段；用户编辑过的字段保留。
3. 图片统一进入现有 OSS 资产流程，保存图片顺序和主图标记。
4. 预检时再次校验 SKU、图片 HTTPS 可访问、目标店铺类目字段和币种/VAT。
5. 快速创建任务完成后用 `product_id` 回读 Ozon 实际卡片，页面明确区分“已创建”“审核中”“可售”。
6. 对官方 Seller API 请求使用当前 OpenAPI/官方更新频道契约；开源库只作为实现参考，不直接复制接口版本或固定字段。

## 研究来源汇总

### 一手来源

- [Ozon Seller API](https://docs.ozon.ru/api/seller/)
- [Ozon Seller API 更新频道](https://t.me/s/OzonSellerAPI)
- [2026-07 商品接口变更](https://t.me/s/OzonSellerAPI?after=394&q=%23operation)

### 开源实现/字段核对

- [DragonSigh/ozon-seller-api-docs](https://github.com/DragonSigh/ozon-seller-api-docs)
- [Slimpers/Ozon-API-parser-MD](https://github.com/Slimpers/Ozon-API-parser-MD)
- [a-ulianov/OzonAPI](https://github.com/a-ulianov/OzonAPI)
- [irenicaa/ozon-seller](https://github.com/irenicaa/ozon-seller)
- [Oxonomy/ozon-seller-mcp](https://github.com/Oxonomy/ozon-seller-mcp)
- [salacoste/ozon-daytona-seller-api](https://github.com/salacoste/ozon-daytona-seller-api)
- [aleonov57/parser-ozon](https://github.com/aleonov57/parser-ozon)
