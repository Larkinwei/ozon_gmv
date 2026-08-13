import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";

const require = createRequire(import.meta.url);
const APP_ID = "com.ozon.gmv-dashboard";
const RESULT_TIMEOUT_MS = 35_000;

export interface WindowsToastOptions {
  title: string;
  message: string;
  imagePath?: string | null;
  onActivate: () => void;
}

function snoreToastPath(): string {
  const packagePath = require.resolve("node-notifier/package.json") as string;
  return join(dirname(packagePath), "vendor", "snoreToast", "snoretoast-x64.exe");
}

/** Builds the SnoreToast command line with the local image and long duration. */
export function buildWindowsToastArguments(pipePath: string, options: WindowsToastOptions): string[] {
  return [
    "-t", options.title,
    "-m", options.message,
    ...(options.imagePath ? ["-p", options.imagePath] : []),
    "-d", "long",
    "-s", "Notification.Default",
    "-appID", APP_ID,
    "-pipeName", pipePath,
  ];
}

function parseActivation(buffer: Buffer): string | null {
  const text = buffer.toString("utf16le");
  const action = text.match(/(?:^|;)action=([^;\0\r\n]+)/i)?.[1]?.toLowerCase();
  return action ?? null;
}

function closeServer(server: Server, pipePath: string): void {
  if (server.listening) {
    server.close();
  }
  try {
    unlinkSync(pipePath);
  } catch {
    // Windows removes named pipes after the server closes.
  }
}

/** Shows a native Windows Toast while retaining click activation through SnoreToast. */
export function showWindowsToast(options: WindowsToastOptions): Promise<void> {
  const pipePath = `\\\\.\\pipe\\ozon-gmv-${randomUUID()}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let resultBuffer = Buffer.alloc(0);
    let timeout: NodeJS.Timeout | null = null;
    const server = createServer((socket) => {
      socket.on("data", (chunk) => { resultBuffer = Buffer.concat([resultBuffer, chunk]); });
      socket.on("close", () => {
        if (parseActivation(resultBuffer) === "activate" || parseActivation(resultBuffer) === "click") {
          options.onActivate();
        }
      });
    });
    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      closeServer(server, pipePath);
    };
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      cleanup();
    };
    server.once("error", fail);
    server.listen(pipePath, () => {
      const child = spawn(snoreToastPath(), buildWindowsToastArguments(pipePath, options), {
        windowsHide: true,
        stdio: "ignore",
      });
      timeout = setTimeout(cleanup, RESULT_TIMEOUT_MS);
      child.once("error", fail);
      child.once("spawn", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      child.once("close", () => {
        cleanup();
      });
    });
  });
}
