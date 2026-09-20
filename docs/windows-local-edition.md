# Windows 本地安装版

## 构建环境

- Windows 10/11 x64
- PowerShell 5.1 或更高版本
- Inno Setup 7（脚本也兼容 Inno Setup 6 的默认安装路径）
- 能访问 Node.js 和 GitHub 官方发布资产

构建脚本固定并校验以下运行资产：

- Node.js `24.18.0` x64
- WinSW `2.12.0` x64
- 项目 `package-lock.json` 中固定的原生模块版本

运行：

```powershell
powershell -ExecutionPolicy Bypass -File installer\windows\build-installer.ps1 -Version 1.4.0
```

产物位于 `installer\windows\output\OzonGMV-Setup-1.4.0.exe`。正式发布不接受手动输入版本，只由 `vX.Y.Z` 标签触发 `windows-installer.yml`，自动发布 GitHub Release 和 OSS 下载文件。

## 安装过程

1. 请求一次管理员授权。
2. 升级场景先停止旧服务，执行 SQLite 在线备份并保存旧程序快照。
3. 复制内置 Node.js、构建产物、生产依赖和 WinSW。
4. 限制 `%ProgramData%\Ozon GMV Dashboard` ACL 为 LocalSystem 和 Administrators 完全控制。
5. 注册 `OzonGMVService`，配置 Automatic Delayed Start 和三次失败重启。
6. 添加端口 3002 的 Private + Local Subnet 入站规则，并额外允许 Tailscale IPv4 网段 `100.64.0.0/10` 访问；不开放端口 3001。
7. 启动服务并轮询 `http://127.0.0.1:3001/readyz`，最多等待 60 秒。
8. 为当前安装用户注册登录触发的 `OzonGMVNotifications` 计划任务，以普通用户权限运行桌面通知助手。
9. 健康检查失败时恢复旧程序和升级前数据库；成功后打开初始化页。

安装时会读取当前用户的 Windows 静态代理并写入受 ACL 保护的检测结果。网页可以切换自动、手动代理或直连，手动代理认证信息使用应用主密钥加密。

## 数据生命周期

- 普通覆盖升级只替换程序文件。
- SQLite 在线备份保留 30 天。
- 卸载时默认选择“否”以保留 ProgramData；只有明确确认删除时才清除全部数据。
- 重新安装会识别固定 `AppId`，并继续使用保留的数据。
- Windows 正式安装版每 6 小时检查稳定版；管理员点击“一键更新”后会验证 Ed25519 清单签名、文件大小和 SHA-256，再静默执行同一套覆盖安装与回滚流程。
- 选品关键词、全市场商品、Wordstat、候选池及类目快照均保存在同一 SQLite 文件的隔离表中，现有每日备份与升级前备份会自动覆盖；原始报表不会长期保存。
- Windows 设备默认是类目只读客户端，只从已配置的云端服务下载标准化快照；OpenCLI 主采集功能仅在用户明确启用的 macOS 设备运行。
- 桌面通知助手只连接回环通知流；历史回填、订单更新和取消不会弹窗，关闭通知期间也不会补弹。

## Tailscale 手机远程查看

常开电脑和手机都安装 Tailscale 并加入同一个 Tailnet 后，可以在手机外出时打开只读大屏：

1. 在电脑上保持 Ozon GMV 服务和 Tailscale 常驻运行。
2. 在手机上连接同一个 Tailnet，并关闭 Wi‑Fi 使用 4G/5G 测试。
3. 在 GMV 管理后台打开“私有网络只读大屏”，生成固定只读链接。
4. 优先使用标记为“Tailscale 远程地址”的链接完成配对；链接不会自动过期，可保存到手机桌面长期使用。
5. 配对后将 `/wallboard` 页面添加到手机主屏幕，后续可查看今天、昨天和订单明细。

只读大屏不能访问店铺密钥、同步设置、选品和完整管理后台。手机丢失时，在管理后台点击“撤销全部大屏”，并从 Tailscale 管理页面移除丢失设备。电脑关机、休眠或 Ozon GMV 服务停止时，手机无法查看最新数据。

## 内测注意事项

首版安装包未签名，Windows SmartScreen 可能显示“未知发布者”，内测用户需要选择“更多信息 → 仍要运行”。正式分发前建议购买代码签名证书并在 Inno Setup 中配置签名。

Inno Setup 当前版本可能对商业使用提出许可证要求，正式商用前应核对其最新许可条款。

## 发布前必须在真实虚拟机验证

- Windows 10 与 Windows 11 干净 x64 虚拟机各一次。
- 未安装 Docker、Node.js、PostgreSQL也可完成安装。
- 未登录用户时重启电脑，服务仍能自动启动。
- 手动代理、自动代理、直连各执行一次 Ozon 连接测试。
- Private 网络可以通过局域网配对大屏；Public 网络不会开放局域网访问 3002，但已连接 Tailscale 的受控设备仍可访问只读大屏。
- 覆盖升级保留管理员、代理、店铺、订单和配对代次。
- 固定大屏链接相当于只读访问凭证，只应在可信 Tailscale 网络内使用；手机丢失时点击“撤销全部大屏”使旧链接失效。
- 关闭浏览器后新订单仍显示右下角通知；点击单笔通知能够打开对应订单详情。
- 覆盖升级后计划任务仍属于原安装用户，通知助手会自动重新启动。
- 故意放入不可启动版本，确认自动恢复旧程序与数据库。
