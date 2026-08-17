# 跟卖图片 OSS 配置

跟卖页的本地图片会先由服务压缩成 JPEG，再写入 `ozon/resell-images/` 前缀。Ozon 读取的是对象的公网 HTTPS 地址，因此只给这一个前缀开放匿名读取，不要开放整个 Bucket，也不要把 AccessKey 写入前端或安装包。

## RAM 权限

给专用 RAM 用户绑定最小权限策略。上传服务只需要写入和读取跟卖图片；连接测试会对 `.connection-test` 发起 `HEAD`，对象不存在时返回 404 也表示凭据有效。

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:PutObject", "oss:GetObject"],
      "Resource": [
        "acs:oss:*:*:haodian-ozon-images/ozon/resell-images/*"
      ]
    }
  ]
}
```

Bucket 的 `ozon/resell-images/` 前缀需要配置为公共读（禁止公共写）。如果不希望整个前缀长期公开，可以改用带有效期的签名 URL，但 Ozon 抓图必须在图片审核期间仍能访问；当前版本使用稳定公网 URL。

## 配置位置

在本机设置 → 跟卖图片存储中填写 AccessKey ID 和 Secret，点击“测试 OSS 连接”。密钥使用本机加密主密钥保存到 SQLite，页面不会回显 Secret。图片对象按规范化内容的 SHA-256 命名，相同图片不会重复上传。
