import { createHmac } from "node:crypto";

import type { AppConfig } from "../config";
import type { AppDatabase } from "../db/database";
import { SettingsRepository } from "../db/settings-repository";
import { encryptSecret, decryptSecret } from "../security/encryption";

const ACCESS_KEY_ID = "resell.images.oss.access_key_id";
const ACCESS_KEY_SECRET = "resell.images.oss.access_key_secret";
const DEFAULT_BUCKET = "haodian-ozon-images";
const DEFAULT_REGION = "cn-beijing";
const DEFAULT_PUBLIC_BASE = "https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com";
const IMAGE_PREFIX = "ozon/resell-images";

export interface ImageStorageView {
  configured: boolean;
  bucket: string;
  region: string;
  prefix: string;
  publicBaseUrl: string;
  accessKeyIdMasked: string | null;
  accessKeySecretMasked: string | null;
}

export interface ImageStorageUpdateInput {
  accessKeyId: string;
  accessKeySecret: string;
}

export interface StoredImageObject {
  objectKey: string;
  publicUrl: string;
}

function encodeObjectKey(key: string): string {
  return key.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function canonicalResource(bucket: string, key: string): string {
  return `/${bucket}/${encodeObjectKey(key)}`;
}

function objectUrl(key: string): string {
  return `${DEFAULT_PUBLIC_BASE}/${encodeObjectKey(key)}`;
}

function maskCredential(value: string): string {
  if (value.length <= 8) {
    return "••••••••";
  }
  return `${value.slice(0, 4)}${"•".repeat(Math.max(4, value.length - 8))}${value.slice(-4)}`;
}

function signedHeaders(method: string, bucket: string, key: string, accessKeyId: string, accessKeySecret: string, contentType = ""): Headers {
  const date = new Date().toUTCString();
  const canonical = [method, "", contentType, date, canonicalResource(bucket, key)].join("\n");
  const signature = createHmac("sha1", accessKeySecret).update(canonical).digest("base64");
  return new Headers({
    Authorization: `OSS ${accessKeyId}:${signature}`,
    Date: date,
    ...(contentType ? { "Content-Type": contentType } : {}),
  });
}

/** Stores approved listing images in a stable public OSS prefix without exposing credentials to the browser. */
export class OssImageStorageService {
  private readonly settings: SettingsRepository;

  public constructor(private readonly config: AppConfig, database: AppDatabase, private readonly fetchImplementation: typeof fetch = fetch) {
    this.settings = new SettingsRepository(database);
  }

  /** Returns safe storage metadata for the settings page; credentials are never included. */
  public view(): ImageStorageView {
    const encryptedAccessKeyId = this.settings.get(ACCESS_KEY_ID);
    const encryptedAccessKeySecret = this.settings.get(ACCESS_KEY_SECRET);
    let accessKeyIdMasked: string | null = null;
    if (encryptedAccessKeyId) {
      try {
        accessKeyIdMasked = maskCredential(decryptSecret(encryptedAccessKeyId, this.config.ENCRYPTION_KEY));
      } catch {
        accessKeyIdMasked = "已配置（无法读取）";
      }
    }
    return {
      configured: Boolean(encryptedAccessKeyId && encryptedAccessKeySecret),
      bucket: DEFAULT_BUCKET,
      region: DEFAULT_REGION,
      prefix: IMAGE_PREFIX,
      publicBaseUrl: DEFAULT_PUBLIC_BASE,
      accessKeyIdMasked,
      accessKeySecretMasked: encryptedAccessKeySecret ? "••••••••••••" : null,
    };
  }

  /** Encrypts and stores the dedicated OSS credentials in the local settings table. */
  public update(input: ImageStorageUpdateInput): ImageStorageView {
    const accessKeyId = input.accessKeyId.trim();
    const accessKeySecret = input.accessKeySecret.trim();
    if (!accessKeyId || !accessKeySecret) {
      throw new Error("阿里云 AccessKey ID 和 Secret 不能为空");
    }
    this.settings.set(ACCESS_KEY_ID, encryptSecret(accessKeyId, this.config.ENCRYPTION_KEY));
    this.settings.set(ACCESS_KEY_SECRET, encryptSecret(accessKeySecret, this.config.ENCRYPTION_KEY));
    return this.view();
  }

  /** Verifies credentials by signing a request for a sentinel object; 404 means the credentials were accepted. */
  public async test(): Promise<void> {
    const credentials = this.credentials();
    const key = `${IMAGE_PREFIX}/.connection-test`;
    const response = await this.fetchImplementation(objectUrl(key), {
      method: "HEAD",
      headers: signedHeaders("HEAD", DEFAULT_BUCKET, key, credentials.accessKeyId, credentials.accessKeySecret),
      signal: AbortSignal.timeout(15_000),
    });
    if (![200, 403, 404].includes(response.status)) {
      throw new Error(`OSS 连接失败（HTTP ${response.status}）`);
    }
    if (response.status === 403) {
      throw new Error("OSS 凭据无权访问图片前缀，请检查 RAM 权限");
    }
  }

  /** Uploads one normalized image to the fixed public prefix using an OSS V1 signature. */
  public async putObject(objectKey: string, bytes: Uint8Array, contentType: string): Promise<StoredImageObject> {
    const credentials = this.credentials();
    const response = await this.fetchImplementation(objectUrl(objectKey), {
      method: "PUT",
      headers: signedHeaders("PUT", DEFAULT_BUCKET, objectKey, credentials.accessKeyId, credentials.accessKeySecret, contentType),
      body: bytes as unknown as BodyInit,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`OSS 图片上传失败（HTTP ${response.status}）`);
    }
    return {
      objectKey,
      publicUrl: objectUrl(objectKey),
    };
  }

  private credentials(): { accessKeyId: string; accessKeySecret: string } {
    const accessKeyId = this.settings.get(ACCESS_KEY_ID);
    const encryptedSecret = this.settings.get(ACCESS_KEY_SECRET);
    if (!accessKeyId || !encryptedSecret) {
      throw new Error("请先在本机设置中配置跟卖图片 OSS 凭据");
    }
    return {
      accessKeyId: decryptSecret(accessKeyId, this.config.ENCRYPTION_KEY),
      accessKeySecret: decryptSecret(encryptedSecret, this.config.ENCRYPTION_KEY),
    };
  }
}

export { IMAGE_PREFIX };
