import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const OPENCLI_PACKAGE = "@jackwener/opencli";
const OPENCLI_VERSION = "2.0.2";
const DEFAULT_COMMAND_TIMEOUT_MS = 130_000;
const OPENCLI_VERSION_TIMEOUT_MS = 5_000;

interface OpenCliInvocation {
  command: string;
  prefix: string[];
}

const openCliMajorVersionCache = new Map<string, Promise<number | null>>();

interface OpenCliWireError {
  code?: string;
  message?: string;
  hint?: string;
}

interface OpenCliWireEnvelope {
  ok: boolean;
  data?: unknown;
  error?: OpenCliWireError;
}

export interface OpenCliBridgeStatus {
  ready: boolean;
  cliAvailable: boolean;
  cliVersion: string;
  daemonRunning: boolean;
  extensionConnected: boolean;
  extensionVersion: string | null;
  connectedProfiles: number;
  message: string;
}

interface OpenCliDoctorData {
  cliVersion?: string;
  daemonRunning?: boolean;
  extensionConnected?: boolean;
  extensionVersion?: string;
  extensionOutdated?: boolean;
  connectivity?: { ok?: boolean; error?: string };
  profiles?: Array<{ contextId?: string; extensionConnected?: boolean }>;
  issues?: string[];
}

/** Parses JSON output from OpenCLI 2.x and the plain doctor report used by global OpenCLI 1.x. */
export function parseOpenCliDoctorOutput(output: string): OpenCliDoctorData {
  try {
    return JSON.parse(output) as OpenCliDoctorData;
  } catch {
    const cliVersion = output.match(/opencli v([^\s]+)/iu)?.[1];
    const extensionVersion = output.match(/Extension:\s*connected\s*\(v([^\s)]+)\)/iu)?.[1];
    const connectedProfiles = output.match(/^\s*[^\r\n]*:\s*connected(?:\s+v[^\s]+)?\s*$/gimu) ?? [];
    return {
      ...(cliVersion ? { cliVersion } : {}),
      daemonRunning: /\[OK\]\s*Daemon:\s*running/iu.test(output),
      extensionConnected: /\[OK\]\s*Extension:\s*connected/iu.test(output),
      ...(extensionVersion ? { extensionVersion } : {}),
      connectivity: { ok: /\[OK\]\s*Connectivity:\s*connected/iu.test(output) },
      profiles: connectedProfiles.map(() => ({ extensionConnected: true })),
    };
  }
}

/** Resolves the pinned OpenCLI copy installed beside the GMV application. */
export function bundledOpenCliPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve(OPENCLI_PACKAGE);
  } catch {
    return null;
  }
}

/** Keeps a global OpenCLI fallback for unpackaged developer environments. */
export function defaultOpenCliPath(): string {
  if (process.platform !== "win32") {
    const globalExecutable = process.env.PATH?.split(":")
      .map((directory) => join(directory, "opencli"))
      .find(existsSync);
    return globalExecutable ?? join(homedir(), ".npm-global", "bin", "opencli");
  }
  const bundled = bundledOpenCliPath();
  if (bundled) return bundled;
  const located = spawnSync("where.exe", ["opencli.cmd"], { encoding: "utf8", windowsHide: true });
  return located.status === 0 ? located.stdout.split(/\r?\n/u).find(Boolean) ?? "opencli.cmd" : "opencli.cmd";
}

function openCliInvocation(configuredExecutable: string | null | undefined): OpenCliInvocation {
  if (process.platform === "win32") {
    const bundled = bundledOpenCliPath();
    if (bundled) return { command: process.execPath, prefix: [bundled] };
  }

  const executable = configuredExecutable?.trim() || defaultOpenCliPath();
  if (/\.m?js$/iu.test(executable) && existsSync(executable)) {
    return { command: process.execPath, prefix: [executable] };
  }
  if (process.platform === "win32" && /\.cmd$/iu.test(executable)) {
    const globalEntry = join(dirname(executable), "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
    const localEntry = join(dirname(executable), "..", "@jackwener", "opencli", "dist", "src", "main.js");
    const entry = [globalEntry, localEntry].find(existsSync);
    if (entry) return { command: process.execPath, prefix: [entry] };
  }
  return { command: executable, prefix: [] };
}

const browserCommands = new Set([
  "analyze", "back", "bind", "check", "chrome", "click", "close", "cookies", "dblclick", "dialog", "download",
  "eval", "explore", "extract", "fill", "find", "focus", "frames", "get", "hover", "init", "keys", "network",
  "open", "reload", "screenshot", "scroll", "select", "snapshot", "state", "tab", "type", "unbind", "uncheck",
  "upload", "verify", "wait",
]);

/** Selects the browser session syntax required by the detected OpenCLI major version. */
export function normalizeOpenCliArguments(argumentsList: string[], majorVersion: number): string[] {
  if (argumentsList[0] !== "browser" || argumentsList.length < 3 || argumentsList.includes("--session")) return argumentsList;
  if (majorVersion < 2) return argumentsList;
  const session = argumentsList[1]!;
  const command = argumentsList[2]!;
  if (browserCommands.has(session) || !browserCommands.has(command)) return argumentsList;
  return ["browser", command, ...argumentsList.slice(3), "--session", session];
}

/** Reads and caches the CLI major version so batch collection does not repeat version probes. */
function openCliMajorVersion(invocation: OpenCliInvocation): Promise<number | null> {
  const cacheKey = JSON.stringify([invocation.command, invocation.prefix]);
  const cached = openCliMajorVersionCache.get(cacheKey);
  if (cached) return cached;

  const pending = new Promise<number | null>((resolve) => {
    const child = spawn(invocation.command, [...invocation.prefix, "--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let settled = false;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, OPENCLI_VERSION_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", () => finish(null));
    child.once("close", () => {
      const versionText = Buffer.concat(output).toString("utf8");
      const major = Number.parseInt(versionText.match(/(?:^|\s)v?(\d+)\.\d+/u)?.[1] ?? "", 10);
      finish(Number.isInteger(major) ? major : null);
    });
  });
  openCliMajorVersionCache.set(cacheKey, pending);
  return pending;
}

function wireEnvelope(output: string): OpenCliWireEnvelope | null {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index]!) as OpenCliWireEnvelope;
      if (typeof parsed.ok === "boolean") return parsed;
    } catch {
      // Older OpenCLI versions may print plain output; callers retain their existing parser.
    }
  }
  return null;
}

function friendlyOpenCliError(error: OpenCliWireError | undefined, fallback: string): Error {
  const details = [error?.message, error?.hint].filter(Boolean).join(" ");
  if (/extension.*not connected|browser bridge.*not connected|profile.*not connected/iu.test(details)) {
    return new Error("未检测到 OpenCLI 浏览器扩展连接。请打开 Chrome 或 Microsoft Edge，并确认 Browser Bridge 扩展已启用。");
  }
  if (/multiple.*profiles|profile.*required/iu.test(details)) {
    return new Error("检测到多个 Browser Bridge 浏览器配置，请只保留一个已连接的 Chrome 或 Edge 配置后重试。");
  }
  return new Error(details || fallback);
}

/** Runs the platform-selected CLI without a command shell and unwraps OpenCLI 2.x JSON output. */
export async function runOpenCli(
  configuredExecutable: string | null | undefined,
  argumentsList: string[],
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<string> {
  const invocation = openCliInvocation(configuredExecutable);
  const majorVersion = argumentsList[0] === "browser" ? await openCliMajorVersion(invocation) : null;
  const normalizedArguments = majorVersion === null
    ? argumentsList
    : normalizeOpenCliArguments(argumentsList, majorVersion);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefix, ...normalizedArguments], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("OpenCLI 响应超时，请确认 Chrome 或 Microsoft Edge 已打开且 Browser Bridge 扩展已连接。"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("OpenCLI 无法启动。Windows 请重新安装或更新 GMV，macOS 请确认已全局安装 OpenCLI。"));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      const envelope = wireEnvelope(output);
      if (code !== 0 || envelope?.ok === false) {
        reject(friendlyOpenCliError(envelope?.error, errorOutput || `OpenCLI 退出码 ${code}`));
        return;
      }
      if (envelope?.ok === true) {
        resolve(typeof envelope.data === "string" ? envelope.data : JSON.stringify(envelope.data ?? null));
        return;
      }
      resolve(output);
    });
  });
}

/** Checks the end-to-end CLI, daemon, and Chrome/Edge extension connection. */
export async function diagnoseOpenCliBridge(configuredExecutable?: string | null): Promise<OpenCliBridgeStatus> {
  try {
    const output = await runOpenCli(configuredExecutable, ["doctor"], 25_000);
    const report = parseOpenCliDoctorOutput(output);
    const connectedProfiles = report.profiles?.filter((profile) => profile.extensionConnected !== false).length ?? 0;
    const incompatible = report.issues?.some((issue) => /CLI version incompatible/iu.test(issue)) === true;
    const ready = report.extensionConnected === true && report.connectivity?.ok === true && !incompatible;
    let message = "OpenCLI 已就绪，可使用 Chrome 或 Microsoft Edge 采集前台价格。";
    if (incompatible) {
      message = "Browser Bridge 扩展版本与内置 OpenCLI 不兼容，请更新浏览器扩展。";
    } else if (report.extensionOutdated) {
      message = "浏览器连接正常；建议更新 Browser Bridge 扩展以获得更稳定的自动重试。";
    } else if (connectedProfiles > 1 && report.extensionConnected !== true) {
      message = "检测到多个浏览器扩展连接，请只保留一个 Chrome 或 Edge 配置后重新检测。";
    } else if (report.extensionConnected !== true) {
      message = "未检测到 Browser Bridge。请打开 Chrome 或 Microsoft Edge，并确认扩展已启用。";
    } else if (report.connectivity?.ok !== true) {
      message = `浏览器扩展已连接，但通信检测失败${report.connectivity?.error ? `：${report.connectivity.error}` : ""}`;
    }
    return {
      ready,
      cliAvailable: true,
      cliVersion: report.cliVersion ?? OPENCLI_VERSION,
      daemonRunning: report.daemonRunning === true,
      extensionConnected: report.extensionConnected === true,
      extensionVersion: report.extensionVersion ?? null,
      connectedProfiles,
      message,
    };
  } catch (error) {
    return {
      ready: false,
      cliAvailable: false,
      cliVersion: OPENCLI_VERSION,
      daemonRunning: false,
      extensionConnected: false,
      extensionVersion: null,
      connectedProfiles: 0,
      message: error instanceof Error ? error.message : "OpenCLI 检测失败",
    };
  }
}
