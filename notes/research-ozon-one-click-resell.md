# Ozon 一键跟卖/复用商品卡调研

> 调研日期：2026-08-17  
> 范围：Ozon Seller API 是否支持通过已有商品 SKU 在自己的店铺创建商品，并进一步设置价格、库存和上架状态。  
> 说明：Ozon API 文档站在当前环境存在重定向，下面把 Ozon 官方文档和官方 Seller API 更新频道作为一手依据；请求/响应示例的细节使用公开的 Postman/Apifox 文档镜像交叉核对，并在文中明确标注。

## 结论

可行，但产品名称更准确地说应是“按 Ozon 商品 SKU 复用商品卡并创建本店报价”，而不是复制某个卖家的完整商品记录。

Ozon 官方 Seller API 提供了 `POST /v1/product/import-by-sku`，用于按照 Ozon SKU 创建商品；该请求需要为目标店铺提供自己的 `offer_id`、价格、币种、VAT 等信息，并返回异步任务 ID。创建后还需要查询任务状态，必要时设置价格和仓库库存。目标店铺使用的是自己的商品报价、价格、库存和履约配置，不能直接复用源卖家的 `offer_id`、库存或成交价格。

因此，用户提出的流程可以实现：

1. 在 MY 数据或选品结果中点击“一键跟卖”。
2. 选择一个已配置的目标 Ozon 店铺。
3. 用源商品的 Ozon SKU、标题、图片和基础信息预填表单。
4. 自动生成或让用户确认目标店铺的 `offer_id`、销售价、VAT、币种、库存和仓库。
5. 选择“直接上架”或“编辑后上架”。
6. 后端通过 Seller API 创建商品，轮询异步任务，创建成功后设置价格和库存，并展示 Ozon 返回的审核/校验错误。

但是，Ozon 不保证所有商品都能被一键复制或立即可售。源商品的复制权限、目标店铺的类目资质、必填属性、证书/标记要求、审核状态、仓库和履约方式都会影响结果。

## 关键 API 能力

### 1. 按 SKU 创建商品

正式接口：

```text
POST https://api-seller.ozon.ru/v1/product/import-by-sku
```

官方文档入口：

- [Ozon Seller API 文档](https://docs.ozon.ru/api/seller/)
- [官方 Seller API 更新频道](https://t.me/s/OzonSellerAPI)
- [官方频道对 import-by-sku 的更新记录（2024-11）](https://t.me/s/OzonSellerAPI?before=446)

公开文档镜像给出的请求核心字段为 `sku`、`name`、`offer_id`、`currency_code`、`old_price`、`price`、`vat`，返回 `task_id` 和 `unmatched_sku_list`。镜像对该接口的描述是“创建指定 SKU 的商品卡片副本”，并指出“如果卖家禁止复制，将无法创建卡片副本；无法通过 SKU 更新商品”。这段“复制权限”描述来自镜像，不应替代目标店铺实际调用验证。

- [Postman 接口镜像：创建商品 по Ozon ID](https://www.postman.com/googlesheets/ozon-seller-api/request/bo8ioy1/ozon-id)
- [Apifox 接口镜像：通过 SKU 创建商品](https://s.apifox.cn/apidoc/docs-site/3531025/api-121998315)

重要含义：

- `sku` 是 Ozon 目录商品的识别信息；它不是源卖家的 `offer_id`。
- `offer_id` 是目标店铺自己的店铺货号，应在目标店铺内唯一。
- 不能把源店铺的价格、库存、仓库 ID 或 `offer_id` 原样复制到另一个店铺。
- 该接口是异步创建，不能把 HTTP 200 直接当作“已经上架成功”。

### 2. 查询创建任务

```text
POST https://api-seller.ozon.ru/v1/product/import/info
```

请求 `task_id`，返回每个商品的 `offer_id`、`product_id`、状态和错误列表。只有任务进入可继续处理的状态后，才能进行库存更新。

- [Postman 接口镜像：查询商品创建状态](https://www.postman.com/googlesheets/ozon-seller-api/request/ljbzeay/)

### 3. 完整创建/编辑商品

```text
POST https://api-seller.ozon.ru/v3/product/import
```

这是编辑模式的主要接口：适用于不能直接按 SKU 复用、需要修改标题/属性/图片，或需要完整提交类目字段的场景。它需要 `offer_id`、类目、价格、VAT、尺寸重量、图片和属性等字段，具体必填字段由类目决定。

Ozon 官方更新频道在 2026-07 明确记录：`/v3/product/import` 请求中的 `items.offer_id` 已标记为必填，并删除了 `items.images360`；这说明该接口契约会变动，开发时必须以当前 Seller API 文档为准。

- [官方频道 2026-07 商品接口更新](https://t.me/s/OzonSellerAPI?before=673)
- [Ozon Seller API 文档中的商品接口](https://docs.ozon.ru/api/seller/#tag/Product-API)

### 4. 价格

```text
POST https://api-seller.ozon.ru/v1/product/import/prices
```

用于设置目标店铺自己的价格、划线价和最低价。公开接口镜像说明一次最多处理 1000 个商品，并对价格变化和 `old_price`/`premium_price` 清零有约束；实际实现应读取当前官方契约和错误响应，不应把镜像的限额硬编码成永久规则。

- [Postman 接口镜像：更新价格](https://www.postman.com/googlesheets/ozon-seller-api/request/fb9geye/)
- [官方 Seller API 更新频道](https://t.me/s/OzonSellerAPI)

### 5. 库存

```text
POST https://api-seller.ozon.ru/v2/products/stocks
```

请求包括目标店铺的 `offer_id`、`product_id`、`warehouse_id` 和库存量。公开接口镜像记录了单次请求、请求频率和“商品状态处理完成后才能设置库存”等限制；官方频道在 2026-07 还补充了 `PRODUCT_IS_ARCHIVED` 等常见错误。

- [Postman 接口镜像：更新仓库库存](https://www.postman.com/googlesheets/ozon-seller-api/request/b99auvh/)
- [官方频道 2026-07 库存错误更新](https://t.me/s/OzonSellerAPI)

库存不是单纯的“上架开关”。需要先为目标店铺选择正确的仓库和履约模式（FBO/FBS/rFBS），并确保商品创建状态允许库存更新。

### 6. 商品信息、图片和属性

可配套使用：

```text
POST /v3/product/info/list
POST /v1/product/pictures/import
POST /v1/product/attributes/update
POST /v1/description-category/tree
POST /v3/category/attribute 或当前文档对应的类目属性接口
POST /v1/description-category/attribute/values
```

其中商品信息接口可以用于确认 SKU、商品图片、状态和目录信息；类目属性接口用于编辑模式中的动态表单，不能把所有类目共用一套固定字段。

## “跟卖”与 Ozon 商品卡的边界

### 可以实现的部分

- 通过 Ozon 商品 SKU 为目标店铺创建自己的商品记录/报价。
- 自动预填标题、图片、目录 SKU、部分基础信息。
- 为不同目标店铺使用不同的 `offer_id`、价格、VAT、库存和仓库。
- 创建后轮询审核/校验状态，显示失败字段和错误原因。
- 对已有目标店铺商品执行价格和库存更新。
- 在页面上提供“快速创建”和“编辑后创建”两条路径。

### 不能承诺的部分

- 不能直接复用源卖家的 `offer_id`、库存、仓库、佣金或价格。
- 不能保证源商品允许被复制。公开镜像明确写有复制限制，但当前官方文档实际字段和策略应以调用结果为准。
- 不能保证创建后立即在买家端可见。Ozon 官方帮助说明商品需要通过审核，并且价格、库存等条件满足后才会进入可售状态；创建和审核可能需要几分钟到一天。
- 不能绕过类目、品牌、认证、标记、海关和知识产权要求。
- 不能把“拿到 SKU”理解为可以修改源卖家商品；`import-by-sku` 不是对源商品的编辑接口。

## 官方合规和审核约束

Ozon 官方帮助中心说明，商品卡片经过创建后还会进入审核/错误状态管理，商品可以编辑图片、属性、描述、价格和库存；复制自己的商品卡时也要求至少有一个属性与原卡不同。虽然该帮助页主要讲卖家后台操作，但它反映了 Ozon 对卡片、审核和可售状态的产品规则。

- [Ozon 官方帮助：商品和价格管理](https://docs.ozon.com/global/ozon-seller-app/product-management/)

Seller API 官方更新频道还记录了以下会直接影响“跟卖”的动态约束：

- 大量类目要求填写 `22232`（ТН ВЭД ЕАЭС）属性，不填写无法创建 SKU。
- 属性 `23536`（是否需要标记码）的校验规则会调整。
- 类目属性、保证期等字段可能从自由文本转为严格参考值。
- `/v4/product/info/limit` 用于查询总商品数、每日创建数、每日更新数等限制。

- [官方频道：ТН ВЭД 属性扩大为必填](https://t.me/s/OzonSellerAPI?before=639)
- [官方频道：Seller API 更新和类目/属性变更](https://t.me/s/OzonSellerAPI)
- [商品创建和更新限制（官方文档入口）](https://docs.ozon.ru/api/seller/#operation/ProductAPI_ProductInfoLimitV4)

实际产品必须把以下情况作为可见的失败状态，而不是自动重试：

- 源商品不允许复制或 SKU 无法匹配。
- 目标店铺缺少必填属性、证书、品牌授权或标记信息。
- 商品被拒审、归档、类目不匹配或尺寸重量校验失败。
- 目标店铺没有对应 FBS/rFBS 仓库，或 FBO 供应链配置不完整。
- 达到总商品数、每日创建/更新数或接口频率限制。

## 推荐实现流程

### 快速创建模式

1. 从 MY 数据行读取 `ozonSku`、标题、图片、商品链接和价格参考。
2. 选择目标店铺；不要让前端接触 API Key。
3. 后端用目标店铺凭据调用商品信息接口，确认 SKU 可导入，并读取目标店铺已有商品状态。
4. 预填目标 `offer_id`、销售价、币种、VAT；offer ID 建议由应用生成可读且唯一的草稿值，提交前允许编辑。
5. 用户确认后调用 `/v1/product/import-by-sku`。
6. 轮询 `/v1/product/import/info`，展示 `pending/processed/failed` 等状态及字段错误。
7. 创建成功后按目标店铺仓库调用 `/v2/products/stocks`，必要时调用价格接口。
8. 最终结果明确区分“创建成功”“审核中”“已设置库存”“可售”“失败”，不要把创建成功直接显示为已上架。

### 编辑后创建模式

1. 先根据 SKU 填充商品卡草稿。
2. 根据类目动态加载必填和可选属性，允许编辑标题、图片、描述、尺寸、重量、VAT、品牌和合规字段。
3. 用 `/v3/product/import` 提交完整商品数据。
4. 通过任务状态接口获取审核和校验结果。
5. 通过价格和库存接口完成目标店铺的报价配置。

### 数据与安全要求

- 店铺凭据继续使用现有加密存储；所有创建、价格、库存请求只在后端发起。
- 记录 `store_id + source_sku + target_offer_id` 的幂等关系，避免重复点击产生多个商品。
- 保存 Ozon `task_id`、`product_id`、接口错误码和最后状态，便于人工重试。
- 不复制源店铺的 API Key、订单或客户信息。
- 上架前显示最终价格、库存、币种、履约模式和目标店铺，要求二次确认。

## 难度评估

| 模块 | 难度 | 主要原因 |
| --- | --- | --- |
| MY/选品行增加入口和目标店铺选择 | 低 | 现有页面和店铺管理可复用 |
| SKU 预填和快速创建 | 中 | 需要新建商品接口、任务轮询和幂等 |
| 价格/库存/仓库配置 | 中 | 需要按店铺读取仓库和履约配置，处理限流和状态前置条件 |
| 编辑模式动态类目表单 | 中高 | 类目属性数量多、必填项动态变化、枚举值和合规字段复杂 |
| 直接“上架成功”保证 | 高且不可完全控制 | 受 Ozon 审核、复制权限、证书、标记、品牌和库存状态影响 |
| 多店铺批量跟卖 | 中高 | 每店独立凭据、报价、仓库、币种和失败隔离 |

粗略工期（以当前项目、单开发者、先实现一个目标店铺为前提）：

- 可验证 MVP（一个 SKU、一个目标店铺、快速创建、状态和错误展示）：约 4–7 个开发日。
- 可交付版本（多店铺、编辑模式、仓库选择、幂等、审计、重试和测试）：约 2–3 周。
- 复杂类目自动填充、证书/品牌材料管理和批量发布：需要单独评估，不能按简单表单估算。

## 建议的第一阶段边界

建议先做“按 SKU 创建 + 目标店铺选择 + 自定义价格/库存 + 状态追踪”，不要第一版就承诺所有商品一键直接售卖：

1. 选一件允许复制、无特殊证书要求的普通商品做真实店铺灰度。
2. 验证 `import-by-sku` 返回的商品是否进入目标店铺、商品卡是否正确关联、图片/属性是否完整。
3. 验证目标店铺的 FBS 仓库和库存更新流程。
4. 观察审核时间和失败码，再决定哪些属性可以安全自动填充。
5. 在结果页把“已创建”“审核中”“可售”“失败”分开显示。

## 不确定项与上线前必须确认

1. Ozon 当前官方文档对 `import-by-sku` 的复制权限、允许复制的来源范围和部分字段语义可能随版本调整；需要用目标店铺 API Key 做一次真实沙盒/小范围调用。
2. 不同类目是否完整保留源卡图片、属性、品牌和 rich content，不能仅凭 SKU 假设，需以任务结果和目标店铺商品详情确认。
3. “立即上架”是否还需要可见性、仓库/履约设置或后台额外确认，需按 FBO/FBS/rFBS 分别验证。
4. 目标店铺的币种、VAT、仓库和商品资质不能从源店铺直接继承。
5. 当前官方 API 文档是唯一实现基线；Postman/Apifox 仅用于阅读示例，不应作为长期契约或错误码数据库。

## 研究来源

### 一手来源

- [Ozon Seller API 官方文档](https://docs.ozon.ru/api/seller/)
- [Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI)
- [官方商品和价格管理帮助](https://docs.ozon.com/global/ozon-seller-app/product-management/)
- [官方商品接口文档入口](https://docs.ozon.ru/api/seller/#tag/Product-API)
- [官方商品创建限制接口入口](https://docs.ozon.ru/api/seller/#operation/ProductAPI_ProductInfoLimitV4)

### 用于核对字段和示例的公开镜像（非一手规范）

- [Postman：按 Ozon ID/SKU 创建商品](https://www.postman.com/googlesheets/ozon-seller-api/request/bo8ioy1/ozon-id)
- [Postman：创建/更新商品](https://www.postman.com/googlesheets/ozon-seller-api/request/luve23z/)
- [Postman：查询创建状态](https://www.postman.com/googlesheets/ozon-seller-api/request/ljbzeay/)
- [Postman：更新价格](https://www.postman.com/googlesheets/ozon-seller-api/request/fb9geye/)
- [Postman：更新库存](https://www.postman.com/googlesheets/ozon-seller-api/request/b99auvh/)
- [Apifox：通过 SKU 创建商品（字段镜像）](https://s.apifox.cn/apidoc/docs-site/3531025/api-121998315)

