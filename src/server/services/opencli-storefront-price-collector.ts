import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OpenCliStorefrontPriceCollectorOptions {
  executable: string;
  sessionName: string;
}

export function defaultOpenCliPath(): string {
  if (process.platform !== "win32") return join(homedir(), ".npm-global", "bin", "opencli");
  const located = spawnSync("where.exe", ["opencli.cmd"], { encoding: "utf8", windowsHide: true });
  return located.status === 0 ? located.stdout.split(/\r?\n/u).find(Boolean) ?? "opencli.cmd" : "opencli.cmd";
}

/** Reads public buyer prices through the user's authenticated OpenCLI Chrome session. */
export class OpenCliStorefrontPriceCollector {
  public constructor(private readonly options: OpenCliStorefrontPriceCollectorOptions) {}

  public async collect(sku: string): Promise<unknown> {
    const url = `https://www.ozon.ru/product/${encodeURIComponent(sku)}/`;
    try {
      await this.run(["browser", this.options.sessionName, "open", url]);
      await this.run(["browser", this.options.sessionName, "wait", "time", "3"]);
      const script = `(async () => {
        const path = ${JSON.stringify(`/product/${sku}/`)};
        const url = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url=" + encodeURIComponent(path);
        try {
          const response = await fetch(url, { credentials: "include", headers: { accept: "application/json, text/plain, */*" } });
          if (!response.ok) return { __httpStatus: response.status };
          return await response.json();
        } catch (error) { return { __fetchError: String(error) }; }
      })()`;
      const output = await this.run(["browser", this.options.sessionName, "eval", script]);
      return this.parseJson(output);
    } finally {
      await this.run(["browser", this.options.sessionName, "tab", "close"]).catch(() => undefined);
    }
  }

  public async close(): Promise<void> {
    await this.run(["browser", this.options.sessionName, "tab", "close"]).catch(() => undefined);
    await this.run(["browser", this.options.sessionName, "close"]).catch(() => undefined);
  }

  private parseJson(output: string): unknown {
    const indexes = [output.indexOf("{"), output.indexOf("[")].filter((index) => index >= 0);
    const start = indexes.length ? Math.min(...indexes) : -1;
    const end = Math.max(output.lastIndexOf("}"), output.lastIndexOf("]"));
    if (start < 0 || end < start) throw new Error("OpenCLI 未返回可解析的 Ozon 前台数据");
    const parsed = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.__httpStatus === "number") {
      throw new Error(parsed.__httpStatus === 429 ? "Ozon 前台限流（HTTP 429），请稍后重试" : `Ozon 前台请求失败（HTTP ${parsed.__httpStatus}）`);
    }
    if (typeof parsed.__fetchError === "string") throw new Error(parsed.__fetchError);
    return parsed;
  }

  private run(argumentsList: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let command = this.options.executable;
      let args = argumentsList;
      if (process.platform === "win32") {
        const shimPath = /\.cmd$/iu.test(command) ? command : `${command}.cmd`;
        const entry = join(dirname(shimPath), "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
        if (existsSync(entry)) {
          command = process.execPath;
          args = [entry, ...argumentsList];
        }
      }
      const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", () => reject(new Error("OpenCLI 无法启动，请检查设置页中的 OpenCLI 路径和 Chrome 连接")));
      child.once("close", (code) => code === 0
        ? resolve(Buffer.concat(stdout).toString("utf8"))
        : reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `OpenCLI 退出码 ${code}`)));
    });
  }
}
