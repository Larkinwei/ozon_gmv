# Windows 稳定版发布

Windows 安装包只通过 `vX.Y.Z` Git 标签发布。标签版本必须与 `package.json` 完全一致；流水线会在 Windows Server 2022 上完成类型检查、测试、生产构建、安装包生成和静默安装验证。

## GitHub Release 环境

仓库需要名为 `release` 的 Environment，并在该环境配置以下 Secrets：

- `UPDATE_SIGNING_PRIVATE_KEY_BASE64`：Ed25519 PKCS#8 PEM 私钥的 Base64；对应公钥内置于 `UpdateService`。
- `ALIYUN_OSS_ACCESS_KEY_ID`：只允许写发布前缀的 RAM 用户 AccessKey ID。
- `ALIYUN_OSS_ACCESS_KEY_SECRET`：对应的 AccessKey Secret。

RAM 用户只应具备以下资源的写权限：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:PutObject", "oss:GetObject"],
      "Resource": ["acs:oss:*:*:haodian-ozon-images/ozon-gmv/releases/*"]
    }
  ]
}
```

## OSS 公开读取

Bucket 保持禁止公共写入和禁止匿名列举。仅给 `ozon-gmv/releases/*` 添加匿名 `GetObject` 权限，不要把整个图片 Bucket 改成公共读写。版本目录使用一年不可变缓存，`latest.json` 与 `latest.sig` 使用 `no-store`。

## 发布命令

确认主分支已包含目标版本后执行：

```bash
git tag v1.4.0
git push origin v1.4.0
```

不要手动上传或覆盖 `latest.json`。流水线先创建草稿 GitHub Release，再上传 OSS 版本文件；全部成功后才发布 Release，并最后更新 OSS 的 `latest.sig` 和 `latest.json`。

## 1.4.0 发布说明

- 新增主采集机 OpenCLI 手工同步，复用用户 Chrome 登录态采集 31 个一级类目下的 7 天/28 天三级类目指标。
- 新增类目分析筛选、一级安全汇总、完整指标表格和 GMV 增幅/头部集中度象限图。
- 新增独立私有 OSS 快照服务、Bearer 上传鉴权、不可变 gzip JSON、SHA-256 校验、短时下载地址和离线 SQLite 缓存。
- 类目接口只注册在管理员监听器，局域网大屏继续返回 404；Windows 默认只读，不自动采集。

## 1.3.1 发布说明

- 热销商品搜索扩展到商品名、品牌、卖家、一级类目、三级类目和标签。
- 搜索支持 Unicode NFKC 标准化、俄文大小写不敏感及中文子串匹配。
- 热销商品页区分“尚未导入数据”和“当前筛选无匹配”，并提供一键清除筛选。

## 1.3.0 发布说明

- 新增 Ozon 官方“所有指标”商品报表自动识别，兼容元数据行、汇总行和 32 个指标字段。
- 新增热销商品筛选、全指标详情、历史快照和候选池商品关联。
- 商品数据继续仅在本机管理员端开放，不包含自动下载、公开页爬虫和综合机会评分。

## 1.2.0 发布说明

- 新增本机管理员专用的“选品分析”一级入口，局域网大屏保持 404 隔离。
- 新增 Ozon CSV/XLSX 报表预览、字段映射、批次需求评分和导入历史管理。
- 新增 Yandex Cloud Search API Wordstat 趋势补强、24 小时缓存、并发任务与重启恢复。
- 新增候选池及观察、推荐推进、淘汰三种判断状态。
- 不包含类目持续监测、Ozon 公开页爬虫、竞品销量估算或利润分析。
