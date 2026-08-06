import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";

import type { AppConfig } from "../config";
import type { WallboardPairingsRepository } from "../db/wallboard-pairings-repository";
import { requireSession } from "../security/session";
import { hasWallboardSession, setWallboardSession } from "../security/wallboard-session";

const PAIRING_LIFETIME_MS = 10 * 60 * 1000;
const pairingQuerySchema = z.object({ token: z.string().min(32).max(200) });

function hashPairingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function privateIpv4Addresses(): string[] {
  const addresses = new Set<string>();
  const interfaces = networkInterfaces();
  const preferredNames = Object.keys(interfaces).filter(
    (name) => !/(docker|vethernet|wsl|vmware|virtualbox|loopback|tailscale)/i.test(name),
  );
  const interfaceNames = preferredNames.length > 0 ? preferredNames : Object.keys(interfaces);
  for (const name of interfaceNames) {
    const entries = interfaces[name];
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        const octets = entry.address.split(".").map(Number);
        const second = octets[1] ?? -1;
        if (octets[0] === 10 || (octets[0] === 172 && second >= 16 && second <= 31) || (octets[0] === 192 && second === 168)) {
          addresses.add(entry.address);
        }
      }
    }
  }
  return [...addresses];
}

/** Registers management-side pairing creation and global revocation controls. */
export function registerWallboardManagementRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pairings: WallboardPairingsRepository,
): void {
  app.post("/api/wallboard/pairings", { preHandler: requireSession }, async (_request, reply) => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + PAIRING_LIFETIME_MS;
    pairings.create(hashPairingToken(token), expiresAt);
    const links = privateIpv4Addresses().map(
      (address) => `http://${address}:${config.WALLBOARD_PORT}/connect?token=${encodeURIComponent(token)}`,
    );
    const fallbackLink = `http://127.0.0.1:${config.WALLBOARD_PORT}/connect?token=${encodeURIComponent(token)}`;
    const usableLinks = links.length > 0 ? links : [fallbackLink];
    return reply.send({
      expiresAt: new Date(expiresAt).toISOString(),
      links: usableLinks,
      qrCodeDataUrl: await QRCode.toDataURL(usableLinks[0] as string, { width: 320, margin: 2 }),
    });
  });

  app.post("/api/wallboard/revoke", { preHandler: requireSession }, async () => ({
    revoked: true,
    generation: pairings.revokeAll(),
  }));
}

/** Registers the only public pairing endpoint on the LAN listener. */
export function registerWallboardPairingRoutes(
  app: FastifyInstance,
  pairings: WallboardPairingsRepository,
): void {
  app.get("/connect", async (request, reply) => {
    const { token } = pairingQuerySchema.parse(request.query);
    const pairing = pairings.consume(hashPairingToken(token));
    if (!pairing) {
      return reply.code(410).type("text/plain; charset=utf-8").send("配对链接无效或已使用，请在管理后台重新生成。");
    }
    setWallboardSession(reply, pairings.generation());
    return reply.redirect("/wallboard");
  });

  app.get("/api/wallboard/session", async (request) => ({
    authenticated: hasWallboardSession(request, pairings.generation()),
    readonly: true,
  }));
}
