# Ozon 多店 GMV 实时大屏

本项目是独立的 Ozon Seller API 本地数据应用，用于统一展示多店下单 GMV、发货单数量、取消金额、店铺排行、同步健康度和实时订单流。

## Windows 用户版

正式交付物为 `OzonGMV-Setup-x.y.z.exe`，支持 Windows 10/11 x64。使用者不需要安装 Docker、Node.js 或 PostgreSQL。

- 程序安装到 `%ProgramFiles%\Ozon GMV Dashboard`。
- SQLite、配置、日志和备份保存在 `%ProgramData%\Ozon GMV Dashboard`。
- `OzonGMVService` 以延迟自动启动方式常驻，失败时由 Windows 服务管理器自动重启。
- `127.0.0.1:3001` 只提供本机完整管理后台。
- `0.0.0.0:3002` 只提供经过一次性配对的局域网只读大屏。
- 普通覆盖升级保留全部数据；卸载默认也保留数据。

Windows 构建及安装细节见 [Windows 本地版说明](docs/windows-local-edition.md)。

## macOS 登录后常驻

macOS 开发机可以使用 LaunchAgent 在当前用户登录后自动运行，无需保持终端或 Docker 打开：

```bash
npm run service:mac:install
npm run service:mac:status
```

更新代码后运行 `npm run service:mac:update` 完成构建和重启。`restart` 只重启服务，`uninstall` 只移除 LaunchAgent，均不会删除 `.data` 中的 SQLite、配置、日志或备份。

## 本地开发

需要 Node.js 24 或更高版本：

```bash
npm install
npm run dev
```

首次运行会在 `.data` 下创建 SQLite 和本机密钥。打开 `http://127.0.0.1:3001` 后，由初始化向导创建管理员，不存在通用默认密码。

仅查看演示 UI：

```bash
npm run dev:demo
```

## 数据同步

- FBO：`POST /v3/posting/fbo/list`
- FBS/rFBS：`POST /v4/posting/fbs/list`
- API Key 权限：`POST /v1/roles`
- 所有履约模式每 60 秒增量轮询。
- 每 15 分钟重查最近 24 小时，北京时间每天 03:00 重查最近 7 天。
- 新店首次回填最近 90 天，页面也支持手动同步最近 1/7/30/90 天。
- 遇到 `429` 遵循 `Retry-After`；网络和 `5xx` 指数退避。单店失败不会阻塞其他店铺。

下单 GMV 定义为 `products[].price × quantity`。金额在 SQLite 中以整数分/戈比保存，接口返回两位小数字符串。取消订单保留在下单 GMV 中，并单独统计。混合币种不会直接相加。

## 数据与安全

- API Key 使用 AES-256-GCM 加密，浏览器永远无法读回。
- 管理员密码使用 Argon2id 哈希；首次初始化只能从回环地址执行。
- 不保存客户姓名、电话、邮箱和地址。
- SQLite 启用外键、WAL、忙等待和启动完整性检查。
- 每日在线备份保留 30 天；覆盖升级前强制额外备份。
- 局域网端口只允许 Windows Private 网络和 Local Subnet，Public 网络不开放。

## PostgreSQL 一次性迁移

转换器只用于迁移旧版本，不属于正式运行依赖：

```bash
npm run db:import-postgres -- \
  --source 'postgres://user:password@127.0.0.1:5432/ozon_gmv' \
  --target-data-dir .data \
  --legacy-encryption-key '<旧 64 位十六进制主密钥>' \
  --admin-username admin \
  --admin-password-hash '<旧 Argon2id 哈希>'
```

转换结束会校验店铺数、订单数、商品数、取消数、唯一键、各币种 GMV 和 API Key 解密能力。目标 SQLite 已有店铺时会拒绝覆盖。

## 校验命令

```bash
npm run typecheck
npm test
npm run build
```

Docker Compose 仅保留给开发或未来服务器部署，不是 Windows 用户版的依赖。
