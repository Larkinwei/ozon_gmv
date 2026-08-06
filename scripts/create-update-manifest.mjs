import { createHash, createPrivateKey, sign } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) {
    throw new Error(`Missing required argument ${name}.`);
  }
  return process.argv[index + 1];
}

const version = argument("--version");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Version must use stable X.Y.Z syntax.");
}

const installerPath = resolve(argument("--installer"));
const outputDir = resolve(argument("--output"));
const installerName = basename(installerPath);
const expectedName = `OzonGMV-Setup-${version}.exe`;
if (installerName !== expectedName) {
  throw new Error(`Installer must be named ${expectedName}.`);
}

const privateKeyBase64 = process.env.UPDATE_SIGNING_PRIVATE_KEY_BASE64;
if (!privateKeyBase64) {
  throw new Error("UPDATE_SIGNING_PRIVATE_KEY_BASE64 is required.");
}

const bytes = await readFile(installerPath);
const info = await stat(installerPath);
const manifest = {
  schemaVersion: 1,
  version,
  publishedAt: new Date().toISOString(),
  notes: (process.env.RELEASE_NOTES ?? `Ozon GMV Dashboard ${version} 稳定版更新。`).slice(0, 20_000),
  size: info.size,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  urls: [
    `https://haodian-ozon-images.oss-cn-beijing.aliyuncs.com/ozon-gmv/releases/v${version}/${installerName}`,
    `https://github.com/Larkinwei/ozon_gmv/releases/download/v${version}/${installerName}`,
  ],
};
const raw = `${JSON.stringify(manifest, null, 2)}\n`;
const privateKey = createPrivateKey(Buffer.from(privateKeyBase64, "base64").toString("utf8"));
const signature = `${sign(null, Buffer.from(raw, "utf8"), privateKey).toString("base64")}\n`;

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(join(outputDir, "update.json"), raw, "utf8"),
  writeFile(join(outputDir, "update.sig"), signature, "utf8"),
  writeFile(join(outputDir, "latest.json"), raw, "utf8"),
  writeFile(join(outputDir, "latest.sig"), signature, "utf8"),
]);
console.log(`Signed update manifest for ${version} (${info.size} bytes).`);
