# Ozon GMV 每日报表手机通知调研

调研日期：2026-08-13（北京时间）  
范围：只评估微信/企业微信官方开放能力及适合本项目的替代方案，不改业务代码。

## 结论先行

可行，但“个人微信号直接收服务端推送”不可作为官方方案。对当前本机常驻服务，最简单、最稳妥的第一版是：创建一个企业微信群，添加企业微信“消息推送”（原群机器人），将 Webhook 配置到本机服务；每天同步完成后发送一条 Markdown 报表。企业微信手机端会收到群消息，报表也可以发送为图片、图文或文件。

如果只希望自己单独收到、而不想建群，可以使用企业微信自建应用的“发送应用消息”接口，但需要企业微信租户、应用和接收成员账号配置，接入成本高于群机器人。微信公众号服务号也有官方通知能力，但认证、模板/订阅规则和用户授权约束较多，不适合作为本项目的首选日报通道。

## 各方案核实

### 1. 个人微信号

- 官方开放文档没有提供“个人微信号由本地程序主动发送私聊/系统通知”的服务端 API；官方可调用的主动通知能力集中在公众号服务号、小程序和企业微信等主体的开放接口。不要把个人号桌面自动化、非官方协议或外挂当成产品方案，账号稳定性和合规性不可控。
- 因此，当前项目不能仅凭一个个人微信号就可靠地实现每日自动推送。若必须在微信生态内接收，应改用企业微信应用/群消息，或认证服务号。

官方入口：[微信公众平台服务号文档](https://developers.weixin.qq.com/doc/service/guide/product/)

### 2. 认证微信公众号：模板消息

官方接口是 `POST https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=ACCESS_TOKEN`，但有明显门槛和用途限制：

- 只有认证服务号可以申请模板消息使用权限；账号还要设置服务类目并从模板库选用模板。
- 官方明确模板消息仅用于重要的服务通知，不支持广告、营销及其他可能骚扰用户的消息。GMV 日报是否符合“重要服务通知”需要按公众号行业和模板审核结果判断，不能默认认为一定通过。
- 官方页面列出每个账号最多 5 个服务类目、同时最多使用 25 个模板；日调用上限通常为 10 万次，实际以公众号后台开发者中心显示为准。
- 发送给具体用户需要其公众号用户标识（OpenID），通常意味着用户已关注公众号并完成绑定；模板消息不是向任意微信号发送。

官方文档：[模板消息](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Interface.html)  
模板运营约束：[模板消息运营规范](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Operation_Specifications.html)

### 3. 认证微信公众号：订阅通知

订阅通知比模板消息更严格地依赖用户主动授权：

- 官方定义为“用户主动订阅、认证服务号按需下发”的能力；需要认证服务号开通插件、申请服务类目、选用模板。
- 用户要在图文消息或网页中的订阅组件中主动点击允许，之后开发者才能通过 `sendNewSubscribeMsg` 下发对应通知。
- 一次性订阅只能下发一条对应通知；长期订阅目前只向政务民生、医疗等公共服务领域开放。
- 因此，除非日报业务符合可用类目且用户按规则逐次订阅，否则无法保证每天无人操作地持续发送。它不适合本项目的默认日报方案。

官方文档：[订阅通知介绍](https://developers.weixin.qq.com/doc/offiaccount/Subscription_Messages/intro.html)

### 4. 企业微信消息推送（群机器人/Webhook）

这是当前最适合快速落地的官方能力：

- 在企业微信内部群创建“消息推送”（官方文档页面标题仍可能显示“原群机器人”），创建者可以取得专属 Webhook；本机程序向该 HTTPS URL POST JSON 即可发消息。
- 官方支持文本、Markdown、Markdown V2、图片、图文、文件、语音、模板卡片等 8 种类型，足以承载日报摘要、趋势图 PNG 和 CSV/Excel/PDF 文件链接或附件。
- 单个消息推送的发送频率上限为 20 条/分钟；每日一条日报远低于此限制。
- Webhook 是密钥，官方明确要求不要公开、不要提交到 GitHub；应加密保存或放在本机受 ACL 保护的配置中。
- 该方式的接收对象是群成员，不是单独的个人微信私聊。需要企业微信账号、企业内部群和创建消息推送的权限；手机上使用企业微信客户端查看。

官方文档：[消息推送配置说明](https://developer.work.weixin.qq.com/document/path/91770)

### 5. 企业微信自建应用：发送应用消息

如需“只发给我本人”或后续扩展多位管理员，企业微信自建应用更合适：

- 官方接口 `POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=ACCESS_TOKEN` 支持文本、图片、视频、文件、图文、Markdown、小程序通知和模板卡片等消息类型。
- 请求需要企业 `access_token`、应用 `agentid` 和接收成员的 `userid`/部门/标签；应用还必须把接收人纳入可见范围，否则会返回无效接收人或 `81013`。
- 官方限制为每应用每天不超过“账号上限数 × 200”人次；同一成员每应用不超过 30 次/分钟、1000 次/小时，单日报表不会触及限制。
- 需要在企业微信管理后台创建应用、配置可见范围并维护成员身份，比群 Webhook 需要更多管理配置，但消息目标更精确，也不必把日报放到群里。

官方文档：[发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)

## 对本项目的落地判断

### 推荐顺序

1. **第一版推荐企业微信群消息推送 Webhook**：配置最少、无需公众号审核、支持 Markdown/图片/文件，适合单人或小团队手机查看。
2. **需要私聊、多人分级或点击进入系统时，升级企业微信自建应用**：可按成员发送，支持图文/模板卡片和跳转链接，但需要企业后台配置。
3. **不建议首选公众号**：认证服务号、模板/订阅规则、用户绑定和通知用途审核都会增加不确定性；除非已有认证服务号和合适模板。
4. **不采用个人微信机器人**：没有官方个人号服务端推送 API，第三方协议存在封号、断联和隐私风险。

### 其他手机通知渠道

- **飞书自定义机器人**：如果日常使用飞书，群自定义机器人同样是 Webhook 方案，无需租户管理员审核即可在指定群内使用，支持文本、富文本、图片和卡片等消息；需要在群内创建机器人并保护 Webhook。若要发单聊，则应改用应用机器人，开启机器人能力、发布应用并配置用户可见范围。官方也明确应用机器人可以用于发送“数据日报推送”。[自定义机器人使用指南](https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN?lang=zh-CN)、[机器人概述](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-overview)
- **邮件**：使用现有邮箱 SMTP 发 HTML/CSV/PDF，手机邮箱客户端通常可产生系统通知；优点是无需微信/企业租户，缺点是送达和即时性依赖邮箱服务商，不能像企业微信消息一样确认客户端已读。
- **短信/电话**：适合极少量高优先级告警，不适合每天发送完整报表；需要短信服务商实名、签名和模板审核，并产生按条费用。日报正文仍建议放在企业微信/邮件，短信只发异常摘要。

### 每日报表任务可行性

现有项目已经是本机常驻服务，因此可以增加一个按 `Asia/Shanghai` 定时运行的日报任务：

1. 到点先同步最近数据并等待同步完成（建议设置最大等待时间和失败状态）。
2. 按日生成订单数、下单 GMV、取消订单、客单价、店铺排行、异常/延迟状态等摘要；可额外生成趋势图 PNG。
3. 通过企业微信群 Webhook 或企业微信应用消息发送。
4. 记录发送结果、HTTP 响应和重试次数；Webhook 失败时保留本地日报，避免数据丢失。

电脑关机、睡眠或网络不可用时，无法保证“到点发送”。服务恢复后可以选择补发上一份日报或标记为错过；如果需要云端不间断发送，则应将同步和日报任务迁移到服务器。日报发送本身只需要本机主动访问微信/企业微信 HTTPS 接口，不要求公网入站端口。

## 推荐的最小配置

- 企业微信内部群：1 个
- 消息推送 Webhook：1 个（只存本机加密配置，不提交仓库）
- 发送时间：每天北京时间 09:00（避开整点拥堵，可按用户选择调整）
- 消息内容：Markdown 摘要 + 可选趋势图 PNG；若需要完整明细，再附 CSV/Excel/PDF
- 可靠性：发送失败指数退避 3 次；成功/失败写入本地日志；不在消息中包含客户姓名、电话、地址等隐私

## 官方来源清单

- [微信服务号文档总入口](https://developers.weixin.qq.com/doc/service/guide/product/)
- [微信公众号模板消息接口](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Interface.html)
- [微信公众号模板消息运营规范](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Template_Message_Operation_Specifications.html)
- [微信公众号订阅通知介绍](https://developers.weixin.qq.com/doc/offiaccount/Subscription_Messages/intro.html)
- [企业微信发送应用消息](https://developer.work.weixin.qq.com/document/path/90236)
- [企业微信消息推送（原群机器人）配置说明](https://developer.work.weixin.qq.com/document/path/91770)
- [飞书自定义机器人使用指南](https://open.feishu.cn/document/ukTMukTMukTM/ucTM5YjL3ETO24yNxkjN?lang=zh-CN)
- [飞书机器人概述（含数据日报场景）](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-overview)
