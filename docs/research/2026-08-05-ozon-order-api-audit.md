# Ozon 订单与分析 API 契约核验

核验日期：2026-08-05（Asia/Shanghai）

## 结论

项目当前调用的订单列表接口来自 Ozon 官方 Seller API，版本选择正确：

- FBO：`POST https://api-seller.ozon.ru/v3/posting/fbo/list`
- FBS/rFBS：`POST https://api-seller.ozon.ru/v4/posting/fbs/list`
- API Key 权限：`POST https://api-seller.ozon.ru/v1/roles`

Ozon 官方更新频道在 2026-07-10 明确要求把旧版 FBO v2、FBS v3 分别迁移到 FBO v3、FBS v4，并计划于 2026-08-31 关闭旧版。项目已使用新版本。[Ozon 官方 2026-07-10 更新](https://t.me/OzonSellerAPI/666)

`POST /v1/analytics/data` 也是官方接口，但它是 Seller 后台分析口径的聚合接口，不是订单明细接口；当前项目尚未调用它。

## 逐项核验

| 接口 | 官方性/状态 | 当前项目 | 契约结论 |
| --- | --- | --- | --- |
| `POST /v3/posting/fbo/list` | 官方、当前正式 FBO 发货单列表版本 | 已调用 | 请求与响应契约可用 |
| `POST /v4/posting/fbs/list` | 官方、当前正式 FBS/rFBS 发货单列表版本 | 已调用 | 请求与响应契约可用 |
| `POST /v1/roles` | 官方、正式 API Key 信息接口 | 已调用 | `{}` 请求和 `roles`/`expires_at` 响应可用 |
| `POST /v1/analytics/data` | 官方分析聚合接口 | 未调用 | 不能代替订单明细；适合对齐 Seller 后台 KPI |

### FBO v3 与 FBS v4 列表请求

项目在 [`src/server/ozon/client.ts`](../../src/server/ozon/client.ts) 中构造以下共同请求：

```json
{
  "filter": {
    "since": "RFC3339 timestamp",
    "to": "RFC3339 timestamp"
  },
  "limit": 100,
  "sort_dir": "ASC",
  "translit": false,
  "with": {
    "analytics_data": false,
    "financial_data": false,
    "legal_info": false
  }
}
```

FBS v4 的 `with` 还包含 `barcodes: false`。首次请求不传 `cursor`；后续请求把响应的顶层 `cursor` 原样放入下一次请求的顶层 `cursor`。响应顶层契约是：

```json
{
  "has_next": true,
  "cursor": "next-page-token",
  "postings": []
}
```

今天使用项目已配置店铺凭证直连 `api-seller.ozon.ru` 做了最小只读契约验证：FBO v3 与 FBS v4 均返回 HTTP 200；在 `limit: 1` 下均返回 `has_next: true`、非空 `cursor` 和 `postings`，因此项目的 `cursor`/`has_next` 翻页方式成立。项目用 `limit: 100` 也已被官方生产 API 接受。因官方文档站对自动访问触发循环重定向，本次不对最大 `limit` 作超出实机证据的声明。

官方在 2026-07-22 仍继续为 FBS v4 增加 `filter.integration_type_flow` 与响应字段，说明它是当前维护版本；公告还明确 FBS v4 的发货单数组位于响应顶层 `postings`。[Ozon 官方 2026-07-22 更新](https://t.me/OzonSellerAPI/671)

`with` 只控制是否附带扩展数据块，不负责筛选 FBO/FBS/rFBS。项目通过接口来源及返回的 `delivery_schema` 做履约类型归类；相关代码位于 [`src/server/ozon/normalize.ts`](../../src/server/ozon/normalize.ts)。

官方接口页：

- [FBO v3 发货单列表](https://docs.ozon.ru/api/seller/#operation/PostingFboList)
- [FBS v4 发货单列表](https://docs.ozon.ru/api/seller/#operation/PostingFbsList)

### `/v1/roles`

项目向 `/v1/roles` 发送空 JSON 对象，再从 `roles[].methods` 检查 API Key 是否包含所选列表接口，并读取 `expires_at`。实现位于 [`src/server/ozon/client.ts`](../../src/server/ozon/client.ts) 和 [`src/server/services/sync-service.ts`](../../src/server/services/sync-service.ts)。

Ozon 在 2025-07-14 发布该方法，2025-09-12 将其从 beta 转为正式接口，2026-02-20 又为响应增加了 `expires_at`。当前实机 `{}` 请求返回 HTTP 200，响应结构与项目 schema 一致。

- [Ozon 官方频道：`/v1/roles` 首次发布](https://t.me/s/ozonsellerapi/514)
- [Ozon 官方频道：2025-09-12 转正式](https://t.me/s/ozonsellerapi?after=528)
- [Ozon 官方频道：`expires_at` 更新](https://t.me/s/ozonsellerapi?before=639)

### `/v1/analytics/data`

该接口为 Ozon 官方 Seller 分析接口，典型请求契约为：

```json
{
  "date_from": "2026-07-08",
  "date_to": "2026-08-04",
  "metrics": ["revenue", "ordered_units"],
  "dimension": ["day"],
  "filters": [],
  "sort": [],
  "limit": 1000,
  "offset": 0
}
```

它返回 `result.data`、`result.totals` 和 `timestamp`，分页使用 `limit`/`offset`，不使用 Posting 接口的 `cursor`/`has_next`。今天对官方生产接口的上述最小请求返回 HTTP 200。

官方接口页：[分析数据](https://docs.ozon.ru/api/seller/#operation/AnalyticsAPI_AnalyticsGetData)

项目全仓库没有 `/v1/analytics/data`、`ordered_units` 或 `revenue` 的调用；当前 GMV 是从发货单 `products[].price × quantity` 计算，见 [`src/server/ozon/normalize.ts`](../../src/server/ozon/normalize.ts)。

## 为什么大屏可能少于 Seller 后台

这不等于订单列表 API 错了，而是统计对象和口径不同：

1. Posting 接口返回的是“发货单”；一个买家订单可能拆成多个发货单。
2. 当前“大屏订单数”统计发货单数，当前 GMV 计算发货单商品标价之和。
3. Seller 后台截图中的“订购商品数量”对应 Analytics 的 `ordered_units`，不是发货单数量；“订购金额”应优先对齐 `revenue`。
4. Analytics 还可能受后台所选店铺/合同主体、日期时区、取消处理和报表刷新时间影响。

因此合理的数据架构应为：

- 实时订单滚屏与订单明细：继续使用 FBO/FBS Posting API。
- 历史 KPI 与趋势若要求和 Seller 后台一致：使用 `/v1/analytics/data` 的 `ordered_units`、`revenue`。
- 两类指标在 UI 中明确命名，不把“发货单数”标成“订购商品数量”。

## 风险与建议

- **高优先级：统计口径风险。** 当前订单接口正确，但不能保证与 Seller 后台 Analytics 数字相等。若产品目标是复刻后台指标，需要另行接入 `/v1/analytics/data`。
- **中优先级：履约归类风险。** 当前 rFBS 依赖 `delivery_schema` 包含 `RFBS`；建议用真实 rFBS 店铺样本验证该字段在 FBS v4 响应中的实际值，避免把 rFBS 误归为 FBS。
- **中优先级：权限匹配方式。** 当前使用字符串 `includes` 判断 `roles[].methods`，能够工作但比精确路径比较宽松；后续可收紧为规范化后的精确匹配。
- **持续维护。** 订阅 [Ozon Seller API 官方更新频道](https://t.me/s/ozonsellerapi)，接口升级只保留官方当前版本，不并行维护旧版。

## 来源边界

本报告只使用：Ozon Seller API 官方文档、Ozon Seller API 官方更新频道、`api-seller.ozon.ru` 的只读实机响应，以及本项目源代码。未使用第三方 SDK、博客、Postman 镜像或社区仓库作为结论依据。
