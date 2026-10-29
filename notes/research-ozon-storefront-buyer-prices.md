# Ozon 商品详情页买家价格调研

> 调研日期：2026-10-29  
> 范围：批量读取自有商品 SKU 在 Ozon 前台详情页显示的绿色银行卡价与黑色其他银行卡价；核对官方 API 边界和 GitHub 开源实现。  
> 结论性质：只读调研，未修改业务代码。

## 结论

用户关注的两档价格可以从当前打开的商品详情页读取，但目前没有受支持的 Seller API 能稳定返回这两档买家支付价。实现上需要读取 Ozon 前台商品页已经加载的页面状态/请求数据，或解析当前页面 DOM；因此本质上属于前台页面解析（通常被称为爬虫/页面抓取），不是调用 Seller API。

批量读取多个自有 SKU 在技术上可做，但不是 Ozon 提供的官方批量买家价 API。开源实现采用一个常驻 Chromium 会话，把 SKU 放入队列并逐个读取前台内部接口；“批量”是任务编排，不代表一次请求返回多个商品的价格。当前打开页面的浏览器扩展方案只能覆盖当前商品，不足以单独支撑全店 SKU 批量采集。

建议方案是先通过 Seller API 获取自有商品清单和商品 SKU，再由一个浏览器会话按低并发队列读取每个 SKU 的详情价格，保存结果、采集时间与失败原因，并允许失败项单独重试。不可把大量 SKU 并行轰向前台，也不应尝试绕过验证码/反爬。公开项目使用约 1 秒请求间隔；真实速度仍受首次会话建立、网络和 Ozon 风控影响。

## 页面价格语义

- 绿色标价通常对应页面的 `С банками`（使用 Ozon Bank/合作银行银行卡支付的价格）。
- 黑色当前价通常对应 `С другими банками`（使用其他银行卡支付的价格）。
- 划线价是另一项参考价，不应与上述两种当前买家价混为一谈。
- 绿价与黑价的差额只能表示当前页面展示的支付方式价格差，不能据此断言全部由 Ozon 平台补贴，也不能直接当作卖家最终结算补贴或利润。
- 即使本需求不按地区比较，记录结果仍应标注为“采集时当前页面所示”；商品变体、登录状态、促销和页面状态都可能影响数值。必须确认解析的是当前选中变体对应的报价，而不是商品 SPU 或推荐商品的价格。

GitHub 项目 `SZhukovWork/ozon-mcp` 将 `price_with_ozon_card_rub` 映射为带 Ozon/合作银行卡的买家价、`price_without_ozon_card_rub` 映射为其他银行卡价，并单独提供划线前价格。这与截图中两档价格的语义最接近。

其 `product(sku)` 是单 SKU 详情读取；`compare_products` 虽能一次接收最多 20 个 SKU，但底层仍逐个处理。因此它证明了批量队列可行，不证明 Ozon 存在官方批量接口，也不应据此承诺稳定吞吐。

## 官方 API 边界

Ozon Seller API 的商品价格字段面向卖家报价，不等同于当前消费者页面的银行卡价。Ozon 开发者社区曾明确回复：Seller API 不能查询买家使用 Ozon Card 后的最终价格；另一条社区讨论还提醒不要解析客户端页面。此类回复说明这不是官方承诺提供的集成能力，不能把非官方前台抓取包装成稳定 API。

此外，Ozon 在 2025-10-06 发布的 Seller API 变更通知中宣布弃用/移除部分 `marketing_price` 字段。因此不能依赖旧接口示例中的 `marketing_price` 来还原当前页面的绿标、黑标价格。

## GitHub 实现参考

| 项目 | 做法 | 对本需求的参考价值与限制 |
| --- | --- | --- |
| [SZhukovWork/ozon-mcp](https://github.com/SZhukovWork/ozon-mcp) | 通过 Chromium 页面上下文读取 Ozon 前台 composer 数据，输出带 Ozon 卡价、其他银行卡价和划线价 | 字段语义最贴近需求；项目也明确使用非官方 storefront 内部接口，受反爬、网络/地区、登录状态和内部接口变化影响，不是官方生产 API |
| [s0vunia/ozon-parser](https://github.com/s0vunia/ozon-parser) | Playwright/页面解析，从卡片 DOM 读取带卡价格，并读取 composer/page JSON 获取商品数据 | 展示了 DOM 与页面 JSON 的组合方式；价格选择器依赖页面结构，且其公开实现没有完整证明详情页两种价格都能稳定映射 |
| [baldiczxc/Parser-Ozon](https://github.com/baldiczxc/Parser-Ozon) | Selenium 定时抓取并存储 `card_price`、`price`、`original_price` | 可参考字段存储，不足以证明字段与本需求的绿标/黑标精确对应；项目较旧，不宜作为核心实现依据 |

## 建议获取流程

1. 从 Seller 商品列表获得自有商品 SKU/Offer ID 清单，并明确 SKU 与变体的映射关系。
2. 将 SKU 放入低并发队列，由一个持久浏览器会话逐个读取对应 Ozon 前台商品详情；不遍历推荐位、广告位或无关商品。
3. 从同一商品、同一变体、同一币种的数据中解析两种明确标签对应的价格：带 Ozon/合作银行卡价、其他银行卡价；另存划线价时要独立命名。
4. 校验返回 SKU/变体与请求一致；无法确认时不写入价格，记录失败并允许单条重试。
5. 保存采集时间、SKU/变体标识及价格标签来源，展示每条结果的新鲜度；不要把买家价差直接记成平台补贴金额。

## 风险与验收重点

- 页面 DOM、React/页面状态和 composer 内部接口均不是稳定公开契约，Ozon 改版后可能变化。
- 自动化请求可能遇到验证码、反爬、访问频率限制和网络策略；不建议服务端对大量商品并发抓取。
- 批量耗时随 SKU 数近似线性增长；若按约 1 秒间隔运行，数百 SKU 会需要数分钟级，另加首次浏览器会话初始化和失败重试时间。
- “不按地区筛选”不等于价格天然无地区差异。队列仍需固定使用一个页面会话解析出的当前地区/登录状态，并把结果解释为该会话当时展示价。
- 当前浏览器已显示的价格应尽可能本地读取，不额外制造高频请求。
- 必须用真实详情页验证绿标/黑标标签映射、所选 SKU/变体、促销状态和无价格/缺字段状态。
- 价格记录应保留“页面显示价”语义与采集时间；若后续用于广告决策，应另行对照 Seller 实际成交/结算报表，不能将展示价差等同于卖家承担或平台补贴。

## 来源

### Ozon 一手来源

- [Ozon 开发者社区：如何获取 Ozon Card 买家价](https://dev.ozon.ru/community/921-Kak-poluchit-tsenu-s-soinvestom-tsenu-dlia-klienta-po-Ozon-Karte/)
- [Ozon 开发者社区：API marketing_price 与用户价格不一致](https://dev.ozon.ru/community/1011-marketing-price-v-API-ne-sootvetstvuet-tsene-polzovatelia/)
- [Ozon Seller API 重要变更（2025-10-06）](https://dev.ozon.ru/news/633-Vazhnye-izmeneniia-v-metodakh-Seller-API/)
- [Ozon 开发者社区：Seller API 价格与站点价格差异](https://dev.ozon.ru/community/276-Ne-sootvetstvie-tsena-API-s-tsenami-na-saite/)
- [Ozon 帮助：绿色价格的支付条件](https://docs.ozon.ru/common/aktsii-bally-i-bonusy/green-price/)

### 开源代码

- [SZhukovWork/ozon-mcp](https://github.com/SZhukovWork/ozon-mcp)
- [SZhukovWork/ozon-mcp：商品与批量比较客户端](https://github.com/SZhukovWork/ozon-mcp/blob/main/src/ozon_mcp/client.py)
- [SZhukovWork/ozon-mcp：MCP 工具入口](https://github.com/SZhukovWork/ozon-mcp/blob/main/src/ozon_mcp/server.py)
- [s0vunia/ozon-parser](https://github.com/s0vunia/ozon-parser)
- [baldiczxc/Parser-Ozon](https://github.com/baldiczxc/Parser-Ozon)

> GitHub 搜索插件调用在本次会话中返回 `Unknown tool`，因此开源实现通过公开 GitHub 仓库页面/代码检索核对；并未调用用户浏览器或访问用户当前 Ozon 商品会话。
