# MY 数据发货模式识别调研

> 调研日期：2026-08-18（Asia/Shanghai）  
> 范围：Ozon Seller API 官方文档入口与 Ozon Seller API 官方更新频道。  
> 目标：确认 FBO、FBS、rFBS 能否从订单、商品库存和仓库接口可靠识别。

## 结论

可以从 Ozon 官方 API 补充发货/履约模式，但可靠性取决于数据对象：

1. **订单/Posting：最可靠。** 调用 FBO 专用 posting 列表接口时，来源接口本身就是 FBO；调用 FBS 专用 posting 列表接口时，来源接口覆盖 FBS 与 rFBS，需要继续读取 posting 返回的配送/履约字段（当前版本重点关注 `delivery_schema`，以及 Ozon 在 2026-07-22 新增到 FBS posting 响应的 `integration_type_flow`）。不要只根据仓库名称猜测。
2. **仓库：可用于确认仓库属于哪种履约体系。** FBS/rFBS 仓库通过 `/v2/warehouse/list` 获取，FBO 仓库通过 `/v1/warehouse/fbo/seller/list`（或同一文档中当前有效的 FBO seller warehouse 方法）获取。仓库列表适合建立 `warehouse_id -> mode` 映射，但不能在没有商品/库存绑定关系时单独判断某个 MY SKU。
3. **商品信息：不能单独可靠判断。** `/v3/product/info/list` 主要提供商品、Offer、SKU、图片和商品状态等信息；它不是一个“返回商品履约模式”的统一接口。必须结合商品库存所在仓库、订单 posting 或专门的 FBS 库存接口。
4. **MY 导出的 CSV/XLSX 没有模式字段时不能可靠补齐。** 只能显示“未知”，不能通过 SKU、商品 URL、商品标题、价格或状态推断 FBO/FBS，否则会把跨境和本土商品误标。

## 官方接口依据

以下链接均为 Ozon 官方 Seller API 文档或官方更新频道；文档页面使用单一 Seller API 入口，具体版本以页面当前契约为准。

### 1. Posting 接口

- [Ozon Seller API 文档入口](https://docs.ozon.ru/api/seller/)
- FBO：`POST /v3/posting/fbo/list`。接口语义是获取 FBO 发货/订单，调用成功即可将该 posting 的来源模式标记为 `FBO`。
- FBS/rFBS：`POST /v4/posting/fbs/list`（旧版 `/v3/posting/fbs/list` 已进入淘汰迁移）。FBS posting 需要读取响应中的配送/履约信息来区分普通 FBS 与 rFBS，不能仅把所有 FBS endpoint 返回都标成 FBS。
- [Ozon Seller API 官方更新频道](https://t.me/s/OzonSellerAPI)：2026-07-10 的更新说明 `/v2/posting/fbo/list` 将迁移到 `/v3/posting/fbo/list`，`/v3/posting/fbs/list` 将迁移到 `/v4/posting/fbs/list`；2026-07-22 的更新说明在 `/v3` 和 `/v4` FBS posting list/get 响应中加入 `integration_type_flow` 和 `sorting_center`，可作为新版 FBS/rFBS 识别辅助字段。

### 2. 仓库和配送方式接口

- [Seller API 文档入口](https://docs.ozon.ru/api/seller/)
- FBS/rFBS 仓库列表：`POST /v2/warehouse/list`。官方更新频道在 2026-03-24 明确说明 `/v1/warehouse/list` 迁移到 `/v2/warehouse/list`。
- FBO seller 仓库列表：`POST /v1/warehouse/fbo/seller/list`。它返回卖家可用的 Ozon FBO 仓库/供应点信息，可用来建立 FBO 仓库集合。
- FBS/rFBS 配送方法：`POST /v2/delivery-method/list`。官方更新频道在 2026-03-24 明确说明 `/v1/delivery-method/list` 迁移到 `/v2/delivery-method/list`。配送方法与仓库关联后，可辅助识别 rFBS 的卖家/第三方配送配置。
- rFBS 专用仓库管理接口：官方更新频道列出的 `/v1/warehouse/rfbs/pause`、`/v1/warehouse/rfbs/unpause` 以及 rFBS Express 相关仓库接口，证明 rFBS 仓库是单独的 Seller API 对象；但这些接口不是按 SKU 查询模式的替代方案。

### 3. 商品库存和商品信息接口

- 商品详情：`POST /v3/product/info/list`。可按商品 ID、Offer ID 等取得商品信息，但不应把商品信息响应当作履约模式的唯一来源。
- FBS/rFBS 库存：`POST /v2/product/info/stocks-by-warehouse/fbs`。官方更新频道 2025-12-02 将其列为获取卖家 FBS/rFBS 仓库库存的接口；2026-03-24 又说明旧 `/v1/product/info/stocks-by-warehouse/fbs` 将迁移到 `/v2`。
- 库存/仓库信息可以说明 SKU 在哪些卖家仓库有库存；若同一 SKU 同时存在 FBO 和 FBS 仓库库存，必须按仓库集合分别展示，不能压成单一模式。

## 推荐的实现判定顺序

### 订单同步

```text
FBO endpoint (/v3/posting/fbo/list) -> FBO
FBS endpoint (/v4/posting/fbs/list) -> 读取 delivery_schema / integration_type_flow
  明确标记为 RFBS -> RFBS
  明确标记为 FBS -> FBS
  字段缺失或枚举未知 -> unknown，不猜测
```

当前项目已经按“调用来源 + FBS posting 的 `delivery_schema`”处理订单模式；升级时应继续保留原始 `delivery_schema` 和新版 `integration_type_flow`，在出现新枚举时记录为未知并告警，而不是静默归类。

### MY CSV/XLSX 导入

- 若文件存在“发货模式/履约模式/物流模式/仓库类型/Fulfillment/Shipping mode”等明确字段，做有限映射：`FBO`、`FBS`、`RFBS`、`跨境`、`本土`。
- 若没有这些字段：显示“未知”，并在导入说明中提示可通过目标 Ozon 店铺的 API 做 SKU/Offer 交叉查询。
- 仅凭 SKU、Offer ID、商品链接或标题不能判断模式；同一 SKU 可能在多个模式的仓库中都有库存。

## 后续可实现的补充方案

### 方案 A：按已同步订单补齐（优先）

使用已有 posting 数据为 SKU 建立观察结果：`store_id + sku + fulfillment_mode + observed_at`。同一 SKU 出现多种模式时显示“多模式”，而不是覆盖为最后一次结果。

### 方案 B：按库存仓库补齐（次优）

针对目标店铺调用 `/v2/product/info/stocks-by-warehouse/fbs`，并调用 `/v2/warehouse/list`、FBO seller warehouse list 建立仓库集合；根据 SKU 的仓库库存分别标记 FBS/rFBS/FBO。该方案适用于没有近期订单的商品，但需要处理 SKU 分页、仓库状态和同 SKU 多仓库并存。

### 方案 C：MY 表格人工字段（最稳妥的导入补充）

如果人工导出工具能增加一列模式，直接导入该列。没有模式列的历史文件保持未知，不回溯猜测。

## 风险和注意事项

- Ozon 会更新接口版本和枚举；必须以 Seller API 文档和官方更新频道为基线。2026-07-10 官方已公布 FBO/FBS posting 旧版本迁移，当前不应新接入旧接口。
- rFBS 是 FBS 体系下的特殊履约方式，不能因为 endpoint 名称是 `fbs` 就一律显示为 FBS。
- 仅从 `warehouse_id` 的数值范围、仓库名称或国家推断模式不可靠。
- 目前 MY 数据没有模式字段时，正确的产品行为是“未知 + 可通过 API 补齐”，而不是显示一个看似确定但可能错误的 FBO/FBS。
