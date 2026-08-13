# 类目快照云端服务

该服务运行在阿里云函数计算的 Web/自定义运行时中，监听 `PORT`（默认 `9000`），把标准化类目、热销商品和热搜词快照写入独立私有 OSS Bucket。

上传接口只接受 gzip，并通过请求头接收快照 ID、采集时间、类目行数和压缩内容 SHA-256。云函数直接保存采集机已经验证的压缩字节，避免在 512 MB 实例中展开约 80 MB 的 JSON 后再次压缩；客户端下载后仍会执行 SHA-256 和完整快照结构校验。

必需环境变量：`OSS_REGION`、`OSS_BUCKET`、`CATEGORY_UPLOAD_TOKEN`。生产环境应给函数配置最小权限执行角色，函数计算注入的临时 STS 凭证会自动用于 OSS；本地调试才使用 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` 和可选的 `OSS_STS_TOKEN`。

运行角色只需要目标 Bucket 的对象读写权限。Bucket 需保持私有，并配置生命周期规则，仅保留 `category-snapshots/v1/` 下最近 730 天对象。`GET /v1/category-snapshots/latest` 是公开只读入口，生产环境还应在函数 HTTP 触发器或 API 网关配置公网限流。
