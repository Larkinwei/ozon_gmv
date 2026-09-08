# Wildberries 订单看板接入与限流调研

调研日期：2026-09-08（Asia/Shanghai）

## 结论

### 当前代码已调整为 WB 直连

Wildberries 的订单同步、连接验证和余额摘要现在直接使用 Node `fetch`，不再复用 Ozon 的代理设置。Ozon 请求仍保留原有代理逻辑。

改动位置：

- [`src/server/services/sync-service.ts`](../../src/server/services/sync-service.ts)
- [`src/server/services/store-operations-service.ts`](../../src/server/services/store-operations-service.ts)

### 其他 ERP/中台的共同做法

公开的一手案例虽然没有披露完整商业产品代码，但架构模式比较一致：

1. **WB API 与 ERP/看板解耦。** WB 请求由独立的同步层、队列或订单编排器负责，ERP 和 BI 读取本地已落库的数据，不在用户打开看板时直接请求 WB。
2. **按增量水位同步。** 使用 `lastChangeDate`、订单状态或内部 checkpoint，成功后保存水位，失败时从上一次水位重试。
3. **统一的请求队列和限速器。** 不同店铺、不同接口共享调度层，按照接口和卖家账号的限额排队，不让多个页面刷新、补采任务和定时任务直接并发打到 WB。
4. **看板读取快照。** 看板展示订单数、销售额、退货和同步时间；同步失败时展示“最后成功时间”和错误状态，而不是让页面等待 WB 响应。
5. **高订单量时增加中间消息层。** 订单编排器先接收 WB 数据，再通过 Kafka 等消息系统分发到 ERP、WMS 和 BI，避免 ERP 的 REST 接口成为瓶颈。

这些模式分别出现在 WB 官方公开案例中：UV Market 的 1C 模块使用请求队列并按 API 限制分配请求；Desport 在 WB、WMS、ERP、BI 之间增加订单编排器，并在高峰期使用 Kafka；“Мир Хобби”从第三方模块转为直接 WB API 集成，并采用自动错误处理和重试；WB 官方 1C 接入指南也明确建议使用队列/请求间隔、记录 API 交互并持续维护接口变化。

来源：

- [UV Market：1C 与 Wildberries 集成](https://dev.wildberries.ru/cases/77)
- [Desport：订单编排器、WMS、ERP 与 Kafka](https://dev.wildberries.ru/cases/76)
- [WB 官方 1C 接入指南](https://dev.wildberries.ru/knowledge-base/articles/019d49a4-6147-75c1-acf7-455537f98efd/integratsiia-1c-i-wildberries)
- [Мир Хобби：FBS 自动化与直接 API 集成](https://dev.wildberries.ru/cases/79)
- [WB 官方 Google Sheets API 案例：定时触发、令牌安全保存和 `rrdid` 增量翻页](https://dev.wildberries.ru/cases/1)

## WB 限流规则

WB 使用 Token Bucket 算法，限流维度按接口/接口组、卖家账号和 Token 类型区分。官方说明的四个参数是：周期、周期内请求数、推荐请求间隔和允许的突发数。超过桶容量后返回 HTTP 429。

官方文档还说明：

- `X-Ratelimit-Remaining` 表示当前还可立即发送的请求数；为 0 时，下一次无等待请求会返回 429。
- 429 响应可能提供 `X-Ratelimit-Retry`，客户端应按该值等待，而不是立即重试。
- 个人、服务、基础、测试 Token 的限额可能不同；服务 Token 的限额可能按同一个服务下的全部 Token 合并计算。
- 基础 Token 在官方论坛公告中说明，部分场景可能被降到 `/api/v1/supplier/orders` 每 3 小时 1 次；完成流量识别后才恢复到文档中的 1 分钟 1 次。

### 与当前项目直接相关的接口限制

| 接口 | 当前用途 | 官方公开限制 | 备注 |
| --- | --- | --- | --- |
| `GET /api/v1/supplier/orders` | 订单看板/订单同步 | 1 分钟 1 次，间隔 1 分钟，突发 1 | 数据约 30 分钟更新；保留 90 天 |
| `GET /api/v1/supplier/sales` | 销售与退货同步 | 1 分钟 1 次，间隔 1 分钟，突发 1 | 数据约 30 分钟更新；可能需要使用上一页 `lastChangeDate` 继续请求 |
| `GET /api/v1/account/balance` | 余额摘要 | 1 分钟 1 次，间隔 1 分钟，突发 1 | 需要财务类权限 |

来源：

- [WB API 限流规则](https://dev.wildberries.ru/knowledge-base/articles/019d49a1-28ca-7735-bf2f-98210695abc7/limity-zaprosov-wb-api)
- [订单和销售报告接口](https://dev.wildberries.ru/openapi/reports)
- [余额接口](https://dev.wildberries.ru/openapi/financial-reports-and-accounting)
- [WB 官方论坛：基础 Token 的订单接口限额调整](https://dev.wildberries.ru/en/forum/2120)

### 什么情况会触发 429

1. 同一个店铺短时间内重复点击“验证连接”、测试连接或手动同步。
2. 连接验证、启动补采、定时同步和手动同步同时运行。
3. 多个本地服务实例、多个 ERP 或多个账号共用同一卖家账号/服务 Token。
4. 订单和余额使用 `Promise.all` 同时请求后，又在 429 时快速重试。
5. 基础/测试 Token 的实际限额低于个人/服务 Token，仍按高限额发送。
6. 错误处理把 429 当作普通网络错误，立即重复请求，形成重试风暴。

### 当前项目的风险点

当前项目的正常轮询间隔本身低于上述频率：订单约 5 分钟一次，销售约 15 分钟一次。但还存在三个额外请求来源：

- 新增店铺连接验证会同时调用订单和余额接口。
- 新增店铺后会立即启动 90 天历史补采。
- 429 的默认退避目前是约 0.5 秒、1 秒、2 秒级别；对“1 分钟 1 次”的接口来说，如果响应没有返回明确的等待头，这个退避仍然过快。

因此本次实测直连返回 429，不能直接解释为秘钥无效；它更符合近期重复验证/重试导致限额耗尽。此前同一秘钥在直连下没有返回 401，而代理路径是 TLS 超时，说明网络路径和限流是两个独立问题。

本次使用用户提供的本地秘钥进行只读验证，余额接口返回了以下非敏感响应头：`HTTP 429`、`X-Ratelimit-Limit: 1`、`X-Ratelimit-Remaining: 0`、`X-Ratelimit-Retry: 27391`。这表示 WB 要求约 27391 秒后再请求。旧代码把这个秒数直接转换成等待时间并 `await`，因此新增店铺请求会长时间保持 pending；现在已改为超过 10 秒的自动等待直接返回 429，让页面显示错误和重试时间。

## 对当前订单看板的建议

### 第一优先级：已完成

- WB 请求绕过 Ozon 代理，直接访问 WB 官方域名。
- Ozon 请求仍使用原有网络代理，不改变 Ozon 店铺行为。
- 保留连接、余额和订单同步的现有功能边界。

### 第二优先级：建议后续实现

1. 为每个 WB 店铺建立按接口分类的单队列：订单、销售、余额分别限速。
2. 将连接验证改成轻量验证，避免为了验证 Token 同时消耗订单和余额配额；余额改为连接成功后的异步状态检查。
3. 对 429 读取 `X-Ratelimit-Retry`，没有该头时按接口最小间隔等待，不使用秒级快速重试。
4. 保存最近一次成功请求时间、剩余配额和 `retryAt`，页面显示“WB 限流，预计 xx:xx 后重试”。
5. 看板读取本地快照，显示数据时间和同步状态，避免页面刷新触发 WB API。
6. 为销售报告实现按 `lastChangeDate` 的连续拉取和 checkpoint；当前实现只发起一次销售报告请求，存在数据量较大时取不全的风险。
7. 多店铺同步继续错峰，但限速器必须以“卖家账号/Token + 接口组”为键，而不能只按店铺进程计数。

## 来源边界

本调研只把 Wildberries 官方开发者文档、官方论坛/知识库和 WB 官方公开案例作为事实来源。案例页描述的是公开方案摘要，不足以证明某个商业 ERP 的全部内部实现；上面的共同架构是对这些一手案例的归纳，而不是对未公开产品的反向猜测。
