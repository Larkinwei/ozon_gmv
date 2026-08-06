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
powershell -ExecutionPolicy Bypass -File installer\windows\build-installer.ps1 -Version 1.1.0
```

产物位于 `installer\windows\output\OzonGMV-Setup-1.1.0.exe`。正式发布不接受手动输入版本，只由 `vX.Y.Z` 标签触发 `windows-installer.yml`，自动发布 GitHub Release 和 OSS 下载文件。

## 安装过程

1. 请求一次管理员授权。
2. 升级场景先停止旧服务，执行 SQLite 在线备份并保存旧程序快照。
3. 复制内置 Node.js、构建产物、生产依赖和 WinSW。
4. 限制 `%ProgramData%\Ozon GMV Dashboard` ACL 为 LocalSystem 和 Administrators 完全控制。
5. 注册 `OzonGMVService`，配置 Automatic Delayed Start 和三次失败重启。
6. 添加端口 3002 的 Private + Local Subnet 入站规则；不开放端口 3001。
7. 启动服务并轮询 `http://127.0.0.1:3001/readyz`，最多等待 60 秒。
8. 健康检查失败时恢复旧程序和升级前数据库；成功后打开初始化页。

安装时会读取当前用户的 Windows 静态代理并写入受 ACL 保护的检测结果。网页可以切换自动、手动代理或直连，手动代理认证信息使用应用主密钥加密。

## 数据生命周期

- 普通覆盖升级只替换程序文件。
- SQLite 在线备份保留 30 天。
- 卸载时默认选择“否”以保留 ProgramData；只有明确确认删除时才清除全部数据。
- 重新安装会识别固定 `AppId`，并继续使用保留的数据。
- Windows 正式安装版每 6 小时检查稳定版；管理员点击“一键更新”后会验证 Ed25519 清单签名、文件大小和 SHA-256，再静默执行同一套覆盖安装与回滚流程。

## 内测注意事项

首版安装包未签名，Windows SmartScreen 可能显示“未知发布者”，内测用户需要选择“更多信息 → 仍要运行”。正式分发前建议购买代码签名证书并在 Inno Setup 中配置签名。

Inno Setup 当前版本可能对商业使用提出许可证要求，正式商用前应核对其最新许可条款。

## 发布前必须在真实虚拟机验证

- Windows 10 与 Windows 11 干净 x64 虚拟机各一次。
- 未安装 Docker、Node.js、PostgreSQL也可完成安装。
- 未登录用户时重启电脑，服务仍能自动启动。
- 手动代理、自动代理、直连各执行一次 Ozon 连接测试。
- Private 网络可以配对大屏；Public 网络无法从另一台设备访问 3002。
- 覆盖升级保留管理员、代理、店铺、订单和配对代次。
- 故意放入不可启动版本，确认自动恢复旧程序与数据库。
