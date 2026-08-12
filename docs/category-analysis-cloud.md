# Ozon 类目分析与云端快照

## 主采集机

在“选品分析 → 数据源 → 类目采集与云端快照”勾选“将当前设备设为主采集机”，确认 OpenCLI 路径后保存。Chrome 需要已登录 Ozon Seller，且当前账号能打开“分析 → 什么值得卖 → 类目”。

“类目分析 → 一键同步”会串行采集全部一级类目的 7 天和 28 天指标，请保持 Chrome 与 OpenCLI 扩展连接。只有两个周期全部成功才会写入新快照；429 依次等待 30、60、120 秒，失败进度保存在 SQLite 供下次继续。

该链路调用 Seller 页面私有接口，不是正式 Seller API，可能随页面升级变化。系统不会保存或上传 Cookie、请求头、公司资料与店铺身份。

## 云端服务

服务源码位于 `cloud/category-snapshot-service`。推荐给函数绑定只允许读写该 Bucket 的最小权限执行角色，函数计算会注入短期 STS 凭证。也可以在函数环境变量中手工保存阿里云 AccessKey，适合当前单账号部署，但该密钥权限较大，需要定期轮换。

通用环境变量：

- `OSS_REGION`
- `OSS_BUCKET`
- `CATEGORY_UPLOAD_TOKEN`

手工 AccessKey 模式还需配置：

- `OSS_ACCESS_KEY_ID`：AccessKey ID
- `OSS_ACCESS_KEY_SECRET`：AccessKey Secret

运行 `npm run build` 后部署 `dist/server.js` 为函数计算 Web 服务；运行一次 `npm run oss:lifecycle` 设置 `category-snapshots/v1/` 730 天生命周期。HTTP 触发器需开启 HTTPS，并为公开只读接口设置网关限流。

正式构建已内置当前只读云地址。主采集机还需保存同一上传密钥；其他设备保持“主采集机”关闭即可自动检查最新快照，断网时继续显示本地最后一次校验成功的数据。
