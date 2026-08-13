import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ZodError } from "zod";

import { OssSnapshotStorage, SnapshotService } from "./snapshot-service.js";

const MAX_COMPRESSED_BODY_BYTES = 20 * 1024 * 1024;
const environment = process.env;
for (const key of ["OSS_REGION", "OSS_BUCKET", "CATEGORY_UPLOAD_TOKEN"]) {
  if (!environment[key]) {
    throw new Error(`缺少环境变量 ${key}`);
  }
}
const hasLongLivedCredentials = Boolean(environment.OSS_ACCESS_KEY_ID && environment.OSS_ACCESS_KEY_SECRET);
const hasRoleCredentials = Boolean(
  environment.ALIBABA_CLOUD_ACCESS_KEY_ID
    && environment.ALIBABA_CLOUD_ACCESS_KEY_SECRET
    && environment.ALIBABA_CLOUD_SECURITY_TOKEN,
);
if (!hasLongLivedCredentials && !hasRoleCredentials) {
  throw new Error("缺少 OSS 凭证：请配置函数执行角色或 OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET");
}
const service = new SnapshotService(new OssSnapshotStorage(environment), environment.CATEGORY_UPLOAD_TOKEN!);
const readRate = new Map<string, { minute: number; count: number }>();

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function isRateLimited(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? "unknown";
  const minute = Math.floor(Date.now() / 60_000);
  const current = readRate.get(address);
  if (!current || current.minute !== minute) {
    readRate.set(address, { minute, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > 120;
}

async function readCompressedBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_COMPRESSED_BODY_BYTES) {
      throw new Error("压缩请求体超过 20 MB");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`缺少请求头 ${name}`);
  }
  return value;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/category-snapshots") {
      if (!service.authorize(request.headers.authorization)) {
        json(response, 401, { error: "UNAUTHORIZED", message: "上传密钥不正确" });
        return;
      }
      if (request.headers["content-encoding"] !== "gzip") {
        json(response, 415, { error: "GZIP_REQUIRED", message: "快照必须使用 gzip 上传" });
        return;
      }
      const compressed = await readCompressedBody(request);
      json(response, 201, await service.publishCompressed(compressed, {
        snapshotId: requiredHeader(request, "x-ozon-snapshot-id"),
        collectedAt: requiredHeader(request, "x-ozon-collected-at"),
        rowCount: Number(requiredHeader(request, "x-ozon-row-count")),
        sha256: requiredHeader(request, "x-ozon-snapshot-sha256"),
      }), { "Cache-Control": "no-store" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/category-snapshots/latest") {
      if (isRateLimited(request)) {
        json(response, 429, { error: "RATE_LIMITED", message: "请求过于频繁" }, { "Retry-After": "60" });
        return;
      }
      const latest = await service.latest();
      if (!latest) {
        json(response, 404, { error: "SNAPSHOT_NOT_FOUND", message: "还没有类目快照" });
        return;
      }
      const etag = `"${latest.snapshotId}"`;
      if (request.headers["if-none-match"] === etag) {
        response.writeHead(304, { ETag: etag, "Cache-Control": "public, max-age=300" });
        response.end();
        return;
      }
      json(response, 200, latest, { ETag: etag, "Cache-Control": "public, max-age=300" });
      return;
    }
    json(response, 404, { error: "NOT_FOUND", message: "接口不存在" });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      json(response, 400, { error: "INVALID_SNAPSHOT", message: "快照结构不正确" });
      return;
    }
    json(response, 500, { error: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "服务异常" });
  }
});

server.listen(Number(environment.PORT ?? 9000), "0.0.0.0");
