# AI Gateway 局域网安装包与服务器部署架构调研

> 调研日期：2026-09-11（北京时间）  
> 范围：评估将 AI Gateway 做成局域网安装包、后续服务器部署的架构与技术路线；核对指定 Notion 页面是否可公开访问及其可借鉴点。  
> 事实来源限制：外部事实仅采用官方文档或上游仓库；本项目现状采用仓库内一手源码/文档。  
> 结论性质：本文件是独立调研结果，不代表已经修改业务代码。

## 结论先行

建议采用“同一 Gateway 核心 + 两种宿主发行形态”的路线：

1. **局域网第一版**：继续使用现有 Windows 安装包思路，将 Gateway 作为本机服务运行；默认只监听 `127.0.0.1`，管理员显式开启局域网入口后才监听局域网地址，并使用独立的 Gateway Token、来源限制和健康检查。不要让局域网客户端直接接触上游厂商 Key。
2. **服务器第一版**：使用 Docker 镜像 + Docker Compose，Gateway、数据库和反向代理分服务部署；应用代码不感知 Docker。单机服务器足够时不引入 Kubernetes；未来有多副本、集中密钥和弹性需求，再迁移到 Kubernetes/Helm。
3. **Gateway 与业务 Agent 分层**：Gateway 只负责模型提供商适配、统一协议、认证、路由、限流、用量与日志；Ozon 业务 Agent、商品字段映射、审批、平台 API 写操作继续留在 `ozon-gmv-dashboard` 后端。模型不能直接获得 Ozon API Key 或“任意发布”权限。
4. **LiteLLM 可作为优先验证对象**：其上游定位就是可自托管的 AI Gateway/Proxy，支持 OpenAI 风格入口、多提供商、虚拟 Key、成本/用量、限流、日志和 Guardrails。第一阶段应先验证本项目真实需要的 `/chat/completions`、`/responses`、视觉输入、工具调用、流式和图片接口，而不是把“OpenAI 兼容”视为全部兼容。
5. **Notion 页面可以作为路线选择参考，但不能直接作为架构依据**：本次通过用户授权的 `opencli browser` 已读取正文。页面把 CPA/CLIProxyAPI 定位为个人 OAuth/CLI 代理，把 Sub2API 定位为账号池/共享体系，把 New API 定位为官方 API Key 网关。对当前 GMV 团队场景，前两者不匹配，New API 可与 LiteLLM 做 POC 对比；页面中的命令、价格和第三方服务推荐仍需按官方资料复核。

## 1. 当前项目可复用边界

仓库现状（本项目一手资料）：

- `README.md` 已定义 Windows 用户版：内置 Node.js、Windows 服务常驻、SQLite 数据目录、`127.0.0.1:3001` 管理后台和 `0.0.0.0:3002` 局域网只读大屏。
- `installer/windows/` 已包含 WinSW 服务定义、安装/升级脚本和 Inno Setup 脚本；升级前备份、失败恢复、ACL、健康检查和防火墙规则已有明确设计。
- `compose.yaml` 已将应用、Caddy、持久化卷、内部网络、健康依赖、重启策略和生产环境变量分开；`compose.local.yaml` 只负责本地端口映射。
- 当前服务器 Compose 使用 SQLite 数据卷，适合作为单机/低并发阶段的部署形态；若 Gateway 本身采用 LiteLLM Proxy，其官方快速开始的持久化管理面则以 Postgres 保存模型、Key 和 spend logs。

**推断**：不应把 AI Gateway 逻辑塞进现有 Ozon 业务路由，也不应让现有 Windows 用户版为了 Gateway 引入 Docker/PostgreSQL。可复用的是配置、安装、服务管理、日志、备份和更新的工程能力；Gateway 的模型路由与凭据存储应保持独立数据边界。

## 2. 推荐的目标架构

```text
局域网浏览器 / Ozon 后端 / Agent Worker
                 │ HTTPS 或受控 LAN HTTP
                 ▼
        AI Gateway 入口层
        ├─ 独立 Gateway Token / client identity
        ├─ 模型路由、重试、超时、限流
        ├─ 请求/响应脱敏、审计、用量与成本
        └─ Provider adapter（OpenAI 等）
                 │ 出站 HTTPS
                 ▼
        上游模型提供商

Ozon 业务后端 ── 业务工具 / Ozon Seller API / 审批与异步回查
```

建议的权限边界：

| 层 | 应持有 | 不应持有 |
| --- | --- | --- |
| AI Gateway | 上游模型 Key、Gateway 配置、调用审计、用量数据 | Ozon 店铺 API Key、商品发布权限、SQLite 业务库写权限 |
| Ozon 业务后端/Agent | Ozon 店铺凭据、业务工具、草稿/审批/任务状态 | 上游模型厂商 Key（通过 Gateway 调用） |
| 浏览器/局域网客户端 | 短期或设备级 Gateway Token、脱敏结果 | 任意上游 Key、管理员 Master Key |

LiteLLM 上游 README 将 Proxy 定位为集中式、可自托管的组织级 Gateway，并列出统一 OpenAI 入口、100+ 提供商、virtual keys、spend tracking、guardrails、load balancing 和 logging 等能力。[LiteLLM 上游 README](https://github.com/BerriAI/litellm)

LiteLLM 官方 Docker 快速开始同时提供两种形态：带 Postgres 的管理型部署，以及只挂载配置文件、无需数据库的纯 OpenAI-compatible API。官方还明确，缺少数据库时不能依赖其管理 UI、virtual keys 和 spend tracking 的完整能力。[LiteLLM Docker quick start](https://github.com/BerriAI/litellm-docs/blob/main/docs/proxy/docker_quick_start.md)

**推断**：本项目应先明确 Gateway 是否需要“团队 Key/预算/成本管理”。如果只需要少量固定模型和局域网调用，纯配置模式更轻；如果需要多成员、按客户端限额、成本报表和审计，应从第一天采用 Postgres-backed 管理模式，而不是后续再把无数据库状态迁移成有数据库状态。

## 3. 局域网安装包技术路线

### 3.1 推荐形态

采用现有 Windows 用户版的安装器/服务模式：

- 安装包包含固定版本的 Gateway 运行时、应用构建产物、服务包装器和默认配置模板。
- Windows Service 以受限服务账号运行；密钥和数据库放在受 ACL 保护的机器级数据目录。
- 管理配置只允许回环地址或一次性配对后的管理员会话。
- 局域网 API 与管理 API 使用不同监听器/端口或不同路由策略；默认不把管理后台暴露到 LAN。
- 默认入口为回环地址；只有用户在初始化向导中开启 LAN，才添加 Private/Local Subnet 防火墙规则并生成/轮换 Gateway Token。

Node.js 官方文档说明，`server.listen(port, host)` 会在指定 host 上监听 TCP；未指定 host 时可能监听未指定 IPv6/IPv4 地址。[Node.js `net.Server.listen`](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback)

**推断**：绑定地址必须是显式配置项，不能依赖 Node 默认值。对“只给本机”和“给局域网”提供两个清晰模式，避免因默认监听行为变化而意外暴露管理端口。

### 3.2 Windows 服务包装器

当前仓库使用 WinSW。WinSW 上游仓库说明它可以将任意可执行程序包装成 Windows 服务，支持安装、启动、停止、重启、状态查询和日志配置；其配置支持完整可执行路径、环境变量、延迟自动启动与滚动日志。[WinSW 上游仓库](https://github.com/winsw/winsw)、[WinSW XML 配置](https://github.com/winsw/winsw/blob/v3/docs/xml-config-file.md)

因此，现有“内置 Node + WinSW + Inno Setup”路线可继续复用。需要单独验证的 Gateway 特有事项：

- 服务启动前配置校验失败时必须给出可定位日志，而不是不断重启；
- 升级前备份 Gateway 配置/密钥数据库，失败时回滚二进制与配置版本；
- 不把 provider Key 写入安装目录、前端 bundle、普通用户日志或崩溃报告；
- 服务不可与桌面交互，管理动作通过回环 Web UI/API 完成。WinSW 文档也提醒现代 Windows 服务与桌面交互受限。[WinSW troubleshooting](https://github.com/winsw/winsw/blob/v3/docs/troubleshooting.md)

### 3.3 局域网安全最小集

- 管理端：回环绑定；初始化只接受回环请求。
- Gateway 数据面：LAN 开启后才暴露；每个调用方使用独立 token，可撤销、可限流。
- 防火墙：只允许 Windows Private profile + Local Subnet；不允许 Public profile。
- 出站：只访问配置的 provider endpoint；禁止把任意 URL 作为模型 provider 目标，防止 SSRF。
- 日志：记录 client、model、耗时、状态、token/cost 聚合和 request id；默认不记录完整 prompt/图片，敏感字段脱敏。
- 运维：提供 `/health`/`/ready` 类探针；将“进程存活、provider 可用、凭据有效、数据库可写”分成不同状态。

## 4. 后续服务器部署技术路线

### 4.1 第一阶段：Docker Compose 单机

Docker 官方生产文档建议为生产环境增加独立 Compose 覆盖文件，移除应用代码 bind mount、调整生产端口/环境变量、设置 restart policy，并可在单服务器上运行；应用变更后重建镜像并重建容器。[Docker Compose production](https://docs.docker.com/compose/how-tos/production/)

Docker 官方网络文档说明，同一个 Compose 网络中的服务可通过服务名发现，不应依赖容器 IP；容器 IP 会在重建后变化。[Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)

推荐的服务器服务划分：

```text
reverse-proxy (HTTPS / access policy)
        │ internal network
        ├── ai-gateway
        ├── postgres（Gateway 管理面需要时）
        └── metrics/log collector（按需）
```

部署要点：

- 使用固定版本镜像/tag，不在生产 Compose 使用 `latest`；
- 应用镜像内置代码，配置和数据通过受控 secrets/volumes 注入；
- 数据库不暴露公网端口，只允许 Gateway 内网访问；
- 反向代理负责 TLS、域名和外部访问策略，Gateway 只在内部网络监听；
- 对 Gateway、数据库、反向代理分别做健康检查、备份和恢复演练；
- 服务器客户端通过 HTTPS 访问，不把“局域网 HTTP 信任模型”直接延伸到公网。

### 4.2 第二阶段：Kubernetes/Helm（有需求再上）

LiteLLM 上游仓库包含 Helm chart，但其 README 明确该 chart 是 community maintained，并建议生产部署优先评估 Docker 或 Kubernetes。[LiteLLM Helm README](https://github.com/BerriAI/litellm/blob/litellm_internal_staging/helm/litellm-helm/README.md)

**推断**：Kubernetes 的触发条件应是多副本、滚动升级、集中 Secret、跨节点可用性、弹性和平台统一运维，而不是“服务器部署”本身。单台服务器用 Compose 的运维面更小，也更贴近当前仓库已有的 Compose 形态。

### 4.3 远程访问的选择

如果服务器不应开放入站端口，可评估 Cloudflare Tunnel：官方文档将其描述为在内网安装 `cloudflared`、通过出站连接接入 Cloudflare，因而不需要开放公共入站端口。[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)

如果使用其私有网络模式，官方还要求终端接入 Cloudflare One，并通过路由与身份/设备策略访问私网资源。[Cloudflare One private networks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/)

**推断**：Tunnel 是可选的网络接入层，不应混入 Gateway 业务代码；它也不能替代 Gateway Token、provider Key 隔离和审计。

## 5. 版本化与发布建议

建议把发行物拆成三类，而不是维护两套业务实现：

| 发行物 | 目标 | 核心差异 |
| --- | --- | --- |
| Windows LAN bundle | 公共电脑/局域网快速安装 | 内置运行时、Windows Service、ACL、防火墙、回滚；默认回环 |
| Docker image + Compose | 单机服务器 | 容器化、Postgres/反代、HTTPS、备份与监控；不含桌面通知 |
| Kubernetes chart（后续） | 多副本/平台化运维 | Secret、Deployment、Service、Ingress、水平扩展 |

三者应共用：Gateway HTTP 契约、配置 schema、provider adapter、错误模型、健康探针、审计事件格式和迁移脚本。宿主层只负责进程托管、网络暴露、密钥注入、日志收集和升级回滚。

每个版本至少固定并记录：Gateway 版本、运行时版本、provider adapter 版本、模型路由配置版本、数据库迁移版本、镜像 digest/安装包 hash。变更模型路由不应悄悄改变业务 Agent 的语义；应可审计并支持回滚。

## 6. Notion 页面公开访问核对

### 6.1 本次观察

对用户给出的 URL `https://app.notion.com/p/3ae1627890f580a09e8ac13d5c87e6b9` 做了两种访问：

- 服务端返回 HTTP 200 和 Notion Web 应用 HTML 壳；
- HTML 中能识别到页面 UUID `3ae16278-90f5-80a0-9e8a-c13d5c87e6b9`，并标记 `requiresRedirect: false`；
- 通过用户授权的 `opencli browser` 打开后，页面标题为“自建中转站搭建教程”，并成功提取正文 Markdown；页面侧栏显示为访客视图。

因此，本次可以确认：**用户当前访问链路能够读取页面正文**。但因为 `ntn` 的公共 API 仍需要 API Token，不能仅凭这次浏览器读取证明 Notion Public API 对匿名调用开放；这不影响使用 `opencli browser extract` 获取公开页面内容。

Notion 官方说明，真正允许非 Notion 用户通过链接访问的权限是 `Anyone on the web with link`；Notion Site 则通过 `Share → Publish` 发布，公开页面通常使用工作区域名/`notion.site` URL。官方还说明，内部工作区 URL 与公开 Site URL 可能不同。[Notion sharing & permissions](https://www.notion.com/help/sharing-and-permissions)、[Notion public pages and web publishing](https://www.notion.com/help/public-pages-and-web-publishing)

### 6.2 页面内容的可借鉴点

页面对本项目有参考价值，但需要结合 GMV 场景修正：

- CPA / CLIProxyAPI 适合个人 CLI/OAuth 工具链，不适合作为本项目的官方 API Key 网关；
- Sub2API 面向账号池、共享和额度体系，超出当前团队内部调用需求，不建议引入；
- New API 可以作为 LiteLLM 的对比候选，但必须验证 OpenAI Responses、图片、视觉、工具调用和团队审计需求；
- 域名、HTTPS、反向代理、Cloudflare Bypass Cache、独立客户端 Token、备份和“不让 AI 接触 AT/RT”这些工程原则值得保留；
- 页面中的服务器规格、注册商价格、第三方推荐链接和部署命令不是本项目的正式依赖，使用前需重新核对官方资料。

本节判断基于用户提供的 Notion 页面内容，不代表对该页面推荐项目的安全、许可证或长期维护状态背书；正式实施仍以各项目上游仓库和官方部署文档为准。

## 7. 建议的验证顺序（不改业务代码）

1. 用一个最小 LiteLLM 配置验证固定 provider 的文本、视觉、结构化输出、工具调用、流式和图片接口。
2. 在现有 Windows 服务骨架中做独立 Gateway PoC：回环启动、LAN 显式开启、token 轮换、健康探针和日志脱敏。
3. 用 Docker Compose 部署同一 Gateway 配置，验证 Postgres 备份/恢复、反向代理 TLS、容器重建和 provider 故障行为。
4. 给 Ozon 后端接入一个只读 Agent 工具，验证“模型建议 → 结构化草稿 → 确定性校验 → 人工确认”的链路；暂不开放发布、改价和库存写操作。
5. 完成 Windows 干净机、局域网不同网络 profile、服务器重启、升级失败回滚、密钥轮换和数据库恢复演练后，再决定是否产品化安装包。

## 官方/上游来源清单

- [LiteLLM 上游仓库 README](https://github.com/BerriAI/litellm)
- [LiteLLM Docker quick start](https://github.com/BerriAI/litellm-docs/blob/main/docs/proxy/docker_quick_start.md)
- [LiteLLM Helm README](https://github.com/BerriAI/litellm/blob/litellm_internal_staging/helm/litellm-helm/README.md)
- [Docker Compose production](https://docs.docker.com/compose/how-tos/production/)
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
- [Node.js `net.Server.listen`](https://nodejs.org/api/net.html#serverlistenport-host-backlog-callback)
- [WinSW 上游仓库](https://github.com/winsw/winsw)
- [WinSW XML 配置文档](https://github.com/winsw/winsw/blob/v3/docs/xml-config-file.md)
- [WinSW troubleshooting](https://github.com/winsw/winsw/blob/v3/docs/troubleshooting.md)
- [Notion sharing & permissions](https://www.notion.com/help/sharing-and-permissions)
- [Notion public pages and web publishing](https://www.notion.com/help/public-pages-and-web-publishing)
- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)
- [Cloudflare One private networks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/)
