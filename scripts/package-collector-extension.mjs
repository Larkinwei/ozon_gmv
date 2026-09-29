import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "collector-extension");
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const output = join(root, "public", "downloads", `ozon-gmv-collector-v${manifest.version}.zip`);

mkdirSync(dirname(output), { recursive: true });
rmSync(output, { force: true });
if (process.platform === "win32") {
  const sourcePath = source.replaceAll("'", "''");
  const outputPath = output.replaceAll("'", "''");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${sourcePath}/*' -DestinationPath '${outputPath}' -Force`], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-q", "-r", "-X", output, "."], { cwd: source, stdio: "inherit" });
}
process.stdout.write(`Packaged collector extension v${manifest.version}: ${output}\n`);
