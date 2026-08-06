import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATA_DIR: z.string().min(1),
  ADMIN_PORT: z.coerce.number().int().positive().default(3001),
  WALLBOARD_PORT: z.coerce.number().int().positive().default(3002),
  ADMIN_HOST: z.string().default("127.0.0.1"),
  WALLBOARD_HOST: z.string().default("0.0.0.0"),
  COOKIE_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  PUBLIC_BASE_URL: z.string().url().default("http://127.0.0.1:3001"),
  OZON_API_BASE_URL: z.string().url().default("https://api-seller.ozon.ru"),
  LOCAL_MODE: booleanString,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

interface RuntimeSecrets {
  cookieSecret: string;
  encryptionKey: string;
}

export type AppConfig = z.infer<typeof environmentSchema> & { COOKIE_SECURE: boolean };

function defaultDataDir(environment: NodeJS.ProcessEnv): string {
  if (environment.PROGRAMDATA) {
    return join(environment.PROGRAMDATA, "Ozon GMV Dashboard");
  }
  return resolve(process.cwd(), ".data");
}

function loadOrCreateSecrets(dataDir: string): RuntimeSecrets {
  const configDir = join(dataDir, "config");
  const configPath = join(configDir, "runtime-secrets.json");
  mkdirSync(configDir, { recursive: true });
  if (existsSync(configPath)) {
    return JSON.parse(readFileSync(configPath, "utf8")) as RuntimeSecrets;
  }

  const secrets: RuntimeSecrets = {
    cookieSecret: randomBytes(48).toString("base64url"),
    encryptionKey: randomBytes(32).toString("hex"),
  };
  writeFileSync(configPath, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return secrets;
}

/** Loads runtime configuration and creates machine-local secrets on the first launch. */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = environment.DATA_DIR ?? defaultDataDir(environment);
  const storedSecrets = environment.COOKIE_SECRET && environment.ENCRYPTION_KEY
    ? null
    : loadOrCreateSecrets(dataDir);
  const parsed = environmentSchema.parse({
    ...environment,
    DATA_DIR: dataDir,
    COOKIE_SECRET: environment.COOKIE_SECRET ?? storedSecrets?.cookieSecret,
    ENCRYPTION_KEY: environment.ENCRYPTION_KEY ?? storedSecrets?.encryptionKey,
  });
  return {
    ...parsed,
    COOKIE_SECURE: new URL(parsed.PUBLIC_BASE_URL).protocol === "https:",
  };
}
