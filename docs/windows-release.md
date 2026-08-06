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
git tag v1.1.0
git push origin v1.1.0
```

不要手动上传或覆盖 `latest.json`。流水线先创建草稿 GitHub Release，再上传 OSS 版本文件；全部成功后才发布 Release，并最后更新 OSS 的 `latest.sig` 和 `latest.json`。
