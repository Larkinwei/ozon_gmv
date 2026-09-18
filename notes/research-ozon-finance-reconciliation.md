# Ozon 订单回款与费用归集调研

> 调研日期：2026-09-15（Asia/Shanghai）  
> 范围：Ozon Seller API 财务、订单、发运和退货数据；公开开源项目的数据建模方式。  
> 目标：确认能否按发运月份建立订单 cohort，将后续成交、佣金、物流、活动、拒收/退货和其他平台费用归集到订单，再汇总到 SKU × 月份。

## 结论

### 1. 需求整体可做，但要区分“精确归集”和“估算分摊”

可以实现以下核心结果：

- 以 Ozon posting number（发运编号）作为订单财务归集主键。
- 为每个 posting 保存一个稳定的发运月份 `shipment_month`。
- 把后续日期才产生的、但带有 posting number 或 SKU 的费用，重新归入该 posting 原来的发运月份。
- 在 posting 之下继续按 SKU 拆分，最终形成 `店铺 × 发运月份 × SKU` 的回款和费用汇总。
- 展示订单的直接收入、佣金、物流、退货/拒收、活动/服务费用、净应收和未映射项目。
- 将 Ozon 的资金报告作为店铺级总账，与订单明细汇总进行交叉核对。

但不能承诺所有平台费用都能准确归到某一笔订单：Ozon 新财务接口把数据分成 `POSTING`、`ITEM` 和 `NON_ITEM` 三类，其中 `NON_ITEM` 是卖家层面的、不关联商品的费用。广告合同费、部分仓储/账户服务费、罚款、银行/结算类费用等可能只有店铺或服务编号，没有订单号。它们只能单列为“未分摊公共费用”，或者按照明确的分摊规则估算到 SKU/订单；不能把估算结果伪装成 Ozon 原始订单费用。

因此最终产品应同时给出两套口径：

1. **订单直接回款**：只包含 Ozon 能直接关联到 posting/SKU 的金额，金额可追溯、可精确核对。
2. **含公共费用后的经营回款**：在直接回款之上加上按规则分摊的公共费用，必须显示“估算/分摊”标记和分摊规则。

### 2. 当前不能再以旧 `/v3/finance/transaction/list` 为正式基础

Ozon Seller API 官方更新频道在 2026-07-14 公布：`/v3/finance/transaction/list` 和 `/v3/finance/transaction/totals` 将于 2026-09-08 停用，替代接口为：

- `/v1/finance/accrual/by-day`
- `/v1/finance/accrual/postings`
- `/v1/finance/accrual/types`

当前日期已经是 2026-09-15，所以新功能不能照搬仍使用旧交易接口的开源示例。旧接口的文档、字段和很多开源项目仍有参考价值，但只能用于理解旧数据模型或做迁移对照。

依据：[Ozon Seller API 官方更新频道（2026-07-14）](https://t.me/s/OzonSellerAPI?after=655)。

## 推荐的数据获取方式

### A. 订单和发运基表

订单主表继续从当前有效的 posting 接口获取：

- FBO：`POST /v3/posting/fbo/list`
- FBS/rFBS：`POST /v4/posting/fbs/list`

这两个接口都能提供 `posting_number`、`order_number`、商品列表、`sku`、数量和订单状态。FBS v4 还包含 `in_process_at`、`shipment_date`、`delivering_date` 等时间字段；官方文档将 `shipment_date` 描述为建议/截止发运时间，而 `delivering_date` 是转入配送的时间，因此不能把 `shipment_date` 直接当作实际发运完成时间。

依据：[FBS v4 posting list 字段文档](https://github.com/Slimpers/Ozon-API-parser-MD/blob/main/md/seller/operations/FBS/POST%20v4-posting-fbs-list.md)、[FBO v3 posting list 字段文档](https://github.com/Slimpers/Ozon-API-parser-MD/blob/main/md/seller/operations/FBO/POST%20v3-posting-fbo-list.md)、[Ozon 官方迁移通知](https://t.me/s/OzonSellerAPI?before=669)。

### B. 按发生日期读取全部财务增量：`/v1/finance/accrual/by-day`

请求一个自然日的全部财务应计项目：

```text
POST https://api-seller.ozon.ru/v1/finance/accrual/by-day
{
  "date": "YYYY-MM-DD",
  "last_id": ""
}
```

接口按 `last_id` 游标分页，不是 `page/page_size`。每天可能需要连续请求多页，直到返回的 `last_id` 为空或没有新增记录。

响应中的一条应计记录包含：

- `date`：这笔费用/收入实际产生的日期。
- `type_id`：应计类型编号。
- `unit_number`：订单发运编号或服务/广告合同等业务单号。
- `accrued_category`：通常是 `POSTING`、`ITEM` 或 `NON_ITEM`。
- `total_amount`：这条记录的总金额，金额对象中的 `amount` 是字符串，另有 `currency`。
- `posting.products[]`：posting 层商品、佣金和配送服务。
- `item_fees.fees[]`：按 SKU 的费用明细。
- `non_item_fee`：不关联 SKU/订单的卖家层费用。

这是实现“5 月产生的退货费用归回 4 月发运订单”的核心接口：保留财务发生日，同时通过 posting number/SKU 连接到订单的发运月份。

依据：[Ozon `/v1/finance/accrual/by-day` 字段文档整理](https://github.com/Slimpers/Ozon-API-parser-MD/blob/main/md/seller/operations/BetaMethod/POST%20v1-finance-accrual-by-day.md)。该页面标明了接口路径、按日请求、`last_id` 游标、`POSTING/ITEM/NON_ITEM` 结构和金额字段。

### C. 按订单复核和重算：`/v1/finance/accrual/postings`

这个接口按一组 posting number 返回订单维度的全部应计项目：

```text
POST https://api-seller.ozon.ru/v1/finance/accrual/postings
{
  "posting_numbers": ["..."]
}
```

每条订单应计项目提供：

- `posting_number`
- `accrual_date`
- `sku`
- `quantity`
- `type_id`
- `accrued.amount/currency`
- `seller_price`

它适合以下场景：

- 点击某个订单查看完整财务轨迹。
- 重新核算某个月的订单 cohort。
- 对“订单表有、财务表没有”或“财务有、订单表没有”的异常订单做点查。
- 对最近产生退货或费用变化的订单做局部刷新。

它不能替代 `by-day` 作为全量同步来源，因为全店公共的 `NON_ITEM` 费用仍需要按发生日期从 `by-day` 获取。

依据：[Ozon `/v1/finance/accrual/postings` 字段文档整理](https://github.com/Slimpers/Ozon-API-parser-MD/blob/main/md/seller/operations/BetaMethod/POST%20v1-finance-accrual-postings.md)。

### D. 动态解析费用名称：`/v1/finance/accrual/types`

新接口返回数字 `type_id`，不能把数字直接硬编码成佣金、物流或活动费用。应定期请求：

```text
POST https://api-seller.ozon.ru/v1/finance/accrual/types
{}
```

返回 `id`、`name`、`description`。系统应保存类型快照并建立业务分类，例如：

- 销售/成交收入
- 销售佣金
- 配送和物流
- 退货/拒收/取消
- 活动、广告和推广
- 仓储、包装、处理、销毁
- 赔偿
- 罚款和其他
- 未知类型

新类型出现时不能静默并入“其他”。应保留原始 `type_id` 和名称，并在“待确认费用类型”里告警，否则以后会发生总额能对上、分类却错误的问题。

依据：[Ozon `/v1/finance/accrual/types` 字段文档整理](https://github.com/Slimpers/Ozon-API-parser-MD/blob/main/md/seller/operations/BetaMethod/POST%20v1-finance-accrual-types.md)。

### E. 店铺总账和实际付款：`/v1/finance/cash-flow-statement/list`

这个接口用于店铺级资金核对，不用于给每笔订单分配付款：

```text
POST https://api-seller.ozon.ru/v1/finance/cash-flow-statement/list
{
  "page": 1,
  "page_size": 100,
  "date": {
    "from": "...<ISO date-time>...",
    "to": "...<ISO date-time>..."
  },
  "with_details": true
}
```

响应提供 `cash_flows` 和 `details`，其中可看到：

- 期初余额和期末余额。
- 订单、佣金、配送/退货、服务和其他资金变动。
- `payments`：平台实际付款/转账金额。
- 结算期间的开始和结束时间。

该报告的结算周期通常是每月 1–15 日和 16 日至月底，因此“订单应收”与“实际付款”不能按同一个自然月简单相减。建议将它作为总账校验：订单直接应收 + 公共费用 + 其他平台项目，要能和 Ozon 资金报告的期间数据、余额变化解释一致。

依据：[Ozon Seller API 财务报告接口](https://www.postman.com/googlesheets/ozon-seller-api/request/vgu8sgh/)、[财务报告响应字段整理](https://s.apifox.cn/apidoc/docs-site/3531025/api-121998412)。

### F. 退货和拒收的状态信息：`/v1/returns/list`

财务金额以 `finance/accrual` 为准，退货接口主要用于补充生命周期和业务原因：

- `posting_number`、`order_number`、`sku`
- 退货类型和原因
- 退货状态
- 客户退回、入库、转移等时间

这样可以识别“有退货费用但没有退货业务记录”“有退货记录但暂时还没有财务冲正”的情况。后者不能马上判定为 Ozon 少结算，需要等待后续财务应计。

依据：[Ozon `/v1/returns/list` 字段文档整理](https://github.com/Slimpers/Ozon-API-parser-MD/blob/main/md/seller/operations/ReturnsAPI/POST%20v1-returns-list.md)。

## 发运月份的定义建议

要先固定 cohort 规则，否则同一个订单会随着状态变化不断换月，月度报表无法稳定。

建议定义为 `shipment_month`，而不是泛化的“订单月份”：

```text
FBS/rFBS：优先使用实际进入配送的 delivering_date；没有时暂用 in_process_at，后续更新。
FBO：使用 in_process_at 作为进入 Ozon 履约处理的时间。
缺少有效时间：进入“待确定发运月份”，不根据订单创建时间强行猜测。
```

注意：FBS 的 `shipment_date` 在当前文档中的语义是建议/截止发运时间，会影响迟发计费，不等于实际完成发运时间。若业务上希望采用“卖家交给 Ozon 的日期”，应优先使用 `delivering_date` 或后续确认的实际节点，并保留原始时间字段以便复核。

订单表至少要保留：

- `store_id`
- `posting_number`
- `order_number`
- `parent_posting_number`（拆单时使用）
- `fulfillment_mode`
- `shipment_at`
- `shipment_month`
- `status/substatus`
- `sku`
- `quantity`
- `offer_id`
- 原始 posting JSON 或必要字段快照

依据：[FBS v4 中的 `delivering_date`、`in_process_at`、`shipment_date` 说明](https://github.com/Slimpers/Ozon-API-parser-MD/blob/main/md/seller/operations/FBS/POST%20v4-posting-fbs-list.md)。

## 订单财务归集模型

### 原始层：保留 Ozon 原貌

建议增加独立的财务原始表，不要把财务金额直接揉进现有订单金额字段：

`finance_accrual_raw`

- `store_id`
- `accrual_id`（如果接口返回）
- `accrual_date`
- `unit_number`
- `accrued_category`
- `type_id`
- `currency`
- `amount`
- `raw_json`
- `fetched_at`

`finance_accrual_line`

- `store_id`
- `accrual_id`
- `posting_number`（可为空）
- `sku`（可为空）
- `accrual_date`
- `type_id`
- `type_name_snapshot`
- `business_category`
- `quantity`
- `seller_price`
- `accrued_amount`
- `currency`
- `source_category`：`POSTING`、`ITEM`、`NON_ITEM`

金额应按字符串金额或最小货币单位保存，不要用 JavaScript `number` 作为账务精度的唯一存储。不同币种必须以 `store_id + currency` 隔离，不能跨币种相加。

### 关联层：先按 posting，再按 SKU

归集顺序建议固定为：

```text
财务发生日
  -> posting_number
  -> posting 的 shipment_month
  -> sku
  -> Ozon type_id / business_category
  -> 月度汇总
```

以 4 月发运的订单为例：

```text
4 月：销售/佣金/首笔物流
5 月：拒收/退货/退货物流
6 月：补扣、赔偿、活动或其他调整
                 │
                 └── 只要仍有 posting_number 或 SKU，全部归到 4 月 cohort
```

每条财务明细同时保留两个时间：

- `accrual_date`：费用实际发生日。
- `shipment_month`：订单经营归属月。

这样既能看“4 月订单最终赚了多少”，也能看“6 月发生了哪些历史订单调整”，不会丢失现金和费用发生时间。

### SKU 拆分规则

新 `finance/accrual/postings` 已提供 `sku`，优先使用接口返回的 SKU 直接落行。

对于包含多个 SKU 的 posting：

- SKU 级收入、佣金、商品费用直接按接口 SKU 落账。
- 物流若接口已经返回 SKU 级 `delivery.services`，直接归属。
- 若旧报告或某类费用只有 posting 总额，没有 SKU 明细，则不能平均分摊后当成真实值。应先保留 posting 级金额，再按可解释的驱动分摊，并标记 `allocation_method`。

可选分摊驱动：

1. 按数量：适合每件固定的包装、处理类费用。
2. 按销售额：适合与订单价值相关的公共服务。
3. 按重量/体积：适合有明确计价依据的物流。
4. 按 SKU 直接费用占比：适合无法得到更好驱动的公共费用。

默认不建议把整个 posting 的物流简单平均到 SKU；多件、多重量商品会产生明显误差。

## “订单是否结清”的可实现边界

### Ozon 没有把平台付款逐笔订单化

`cash-flow-statement` 返回的是店铺结算期间和 payments，平台付款是汇总层面的；不能仅凭该接口证明“某一笔订单已经在银行付款中结清”。所以产品不应把“订单财务已稳定”和“平台已经把这笔钱打到银行卡”混为一谈。

建议命名为“订单财务状态”，而不是直接显示“已付款”：

- **待产生订单收入**：订单存在，但还没有正向销售应计。
- **已产生直接应收**：已经有销售/费用明细，仍可能出现后续调整。
- **待后续调整**：订单尚未进入终态、存在进行中的退货，或最近仍有新应计。
- **财务已稳定**：订单为终态，超过可配置观察期没有新增调整，且关键费用类型已映射。
- **待人工核查**：找不到 posting/SKU、存在未知 type_id、币种不一致或与店铺总账不平。

“财务已稳定”只是基于业务规则的订单结算判断，不是 Ozon 的逐单打款确认。最近订单应保持可重开；即使某月已经展示过结果，后续出现新的 `accrual_date` 仍要生成调整并刷新原发运月份。

## 对账指标和异常清单

建议同时做三层对账。

### 1. 财务原始总额对账

- `by-day` 拉取总金额 vs 本地原始表金额。
- 游标分页是否完整。
- 是否出现重复 `accrual_id`。
- 每种币种分别核对。

### 2. 订单关联对账

- 有财务 posting、但本地没有 posting 的记录。
- 有 posting、但财务没有任何收入/费用记录的记录。
- 有 posting number，但无法确定 `shipment_month` 的记录。
- 有 SKU 费用，但 SKU 不在 posting 商品列表的记录。
- 有退货状态，但没有对应负向应计或退货费用的记录。
- 有负向费用，但没有对应订单或服务来源的记录。

### 3. 店铺资金报告对账

- 订单直接应收。
- 未分摊公共费用。
- 已分摊公共费用。
- 补偿、罚款、贷款、发票/转账等不属于订单收入的项目。
- 与 `cash-flow-statement` 的期间 orders、returns、services、others、payments、begin/end balance 对比。

最终至少要显示三个差额：

```text
未关联订单金额
未映射费用金额
店铺总账与订单明细的差额
```

只有这三个差额都可解释，才能认为“账对上了”。

## 同步和重算策略

### 首次同步

1. 先拉取目标历史区间的 FBO/FBS posting，建立 posting、SKU 和发运月份。
2. 按财务发生日逐日调用 `by-day`，逐页追完 `last_id`。
3. 按 `posting_number + sku + accrual_date + type_id + 唯一应计 ID` 幂等写入原始层。
4. 用 `types` 建立当时的类型名称快照。
5. 关联 posting cohort，生成订单财务明细和 SKU × 发运月份汇总。
6. 拉取对应期间的 `cash-flow-statement`，先做店铺级总账基线。

### 日常增量

- 每天拉取前一天和最近一段可调整窗口的 `by-day`。
- 最近窗口不是只按自然月，而是按 `accrual_date` 重新扫描；窗口长度应配置并可手工重算。
- 对最近有退货、拒收、取消或异常的订单，使用 `accrual/postings` 点查。
- 每月只做“展示归属锁定”，不删除或覆盖原始财务记录。
- 发现新的历史订单调整时，在原来的 `shipment_month` 追加一笔调整，不修改原始发生日。

推荐初期采用“最近 90–180 天滚动重算 + 手工指定月份全量重算”的方式，具体观察期以真实店铺退货/费用延迟分布验证后再固定。不要一开始把月末账永久封死。

## 第一版功能范围建议

### 第一版可以可靠交付

- 按店铺和发运月份查看订单 cohort。
- 按 posting number 查看收入、佣金、物流、活动/服务、退货和其他直接费用。
- 按 SKU × 发运月份汇总。
- 查看每笔订单的财务明细时间线。
- 查看订单财务状态和异常原因。
- 查看未关联 posting、未知费用类型、未分摊公共费用。
- 与 Ozon 店铺资金报告进行总额核对。

### 第一版不要承诺

- 把广告合同费、店铺仓储费、银行/结算费等公共费用精确归因到某一笔订单。
- 把店铺级 `payments` 精确匹配到具体订单。
- 只用商品销售报告覆盖所有取消、不买、退货和补扣。
- 只同步一个自然月就认为前月不会再发生调整。

## 为什么不能只用“商品销售报告”

Ozon 的商品实现/销售报告适合月度销售和退货概览，但官方描述明确说明它只包含已交付和退回商品，不包含取消和未购买/未赎回订单，而且报告最迟在次月 5 日提供。它不能覆盖完整的平台费用流水，也不适合承担订单级全量对账的唯一来源。

依据：[Ozon Seller API 商品销售报告](https://www.postman.com/googlesheets/ozon-seller-api/request/a1rmp5i/)。

## 开源项目参考及可借鉴点

### `Alzork/ozon-analytics`

它针对新 `finance/accrual` 接口实现了几个值得借鉴的原则：

- `by-day` 按 `last_id` 连续翻页。
- 每笔金额按 `amount + currency` 解析，保留正负号。
- 通过 `types` 获取数字类型的名称。
- 将收入、佣金、物流和 SKU 费用分别处理。
- 对没有映射的 `type_id` 发出警告，而不是静默丢失。
- 同时保留按日统计和按 posting 点查能力。

该项目也明确说明新接口返回的是更原始的数字类型，需要应用自己完成业务分类，因此不能直接把它的分类映射视作 Ozon 永久标准。

参考：[finance_accrual.py](https://github.com/Alzork/ozon-analytics/blob/main/finance_accrual.py)。

### `krasnovmikhail/ozon-seller-analysis`

它把数据模型拆为：

- `accruals`：每行一个 SKU 级财务应计。
- `allocations`：无法直接关联 SKU 的公共费用分摊。
- `accruals_mart`：SKU × 天聚合。
- `allocations_mart`：记录分摊后的费用和分摊口径。

这个拆分非常适合本项目：原始直接费用和估算公共费用不能混在一个金额字段里。其文档也明确说明部分 Ozon 费用没有 SKU，只能使用数量、订单数或销售额等驱动分配，并标注为估算。

参考：[data_model.md](https://github.com/krasnovmikhail/ozon-seller-analysis/blob/main/docs/data_model.md)。

### `yyyJ8/Ozon_BI`

它将 posting/order、finance transactions、returns 和 products 设计成独立表，并通过 `posting_number` 关联财务流水和订单，再通过 SKU 关联商品。这种结构可借鉴到本项目的 SQLite 数据层，尤其适合做“订单明细 → SKU → 月度汇总”的可追溯链路。

参考：[DATA_ARCHITECTURE.md](https://github.com/yyyJ8/Ozon_BI/blob/master/DATA_ARCHITECTURE.md)。

## 最终判断

这项财务分析模块值得做，且当前项目已有订单 posting、SKU、店铺和履约模式基础，接入路径是清晰的。推荐把第一期目标定义为：

> **按发运月份归属的 Ozon 订单财务台账与对账分析**

而不是简单的“月度回款统计”。

实现后可以准确回答：

- 某月发运的订单最终产生了多少直接应收。
- 每笔订单后来产生了哪些佣金、物流、退货和其他直接费用。
- 哪些费用发生在后续月份但属于历史订单。
- 哪些订单/SKU 尚未稳定、仍可能产生调整。
- 哪些订单、SKU、费用类型无法关联或需要人工核查。
- 店铺订单明细汇总与 Ozon 资金报告之间差多少，差额由什么组成。

不能准确回答的部分必须单列：

- 平台公共费用具体应由哪一笔订单承担。
- 店铺一次性付款具体对应哪些订单。

前者可以用透明规则估算，后者只能做店铺级资金核对。只要产品把“直接归集”“公共费用分摊”“实际店铺付款”三种口径分开，需求就可以落地，而且结果具备审计和追查能力。
