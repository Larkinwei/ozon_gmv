import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";

import type { FastifyInstance } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";

import type { AppConfig } from "../config";
import type { WallboardPairingsRepository } from "../db/wallboard-pairings-repository";
import type { WallboardPairingNetwork } from "../../shared/contracts";
import { requireSession } from "../security/session";
import { hasWallboardSession, setWallboardSession } from "../security/wallboard-session";

const pairingQuerySchema = z.object({ token: z.string().min(32).max(200).optional(), access_token: z.string().min(32).max(200).optional() }).refine(
  (value) => Boolean(value.token || value.access_token),
  { message: "缺少配对凭证" },
);

function hashPairingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface WallboardNetworkAddress {
  address: string;
  network: WallboardPairingNetwork;
}

function isTailscaleIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second, third, fourth] = octets as [number, number, number, number];
  const value = (((first * 256) + second) * 256 + third) * 256 + fourth;
  const start = (((100 * 256) + 64) * 256) * 256;
  const end = (((100 * 256) + 127) * 256 + 255) * 256 + 255;
  return value >= start && value <= end;
}

export function wallboardNetworkAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): WallboardNetworkAddress[] {
  const tailscaleAddresses = new Set<string>();
  const lanAddresses = new Set<string>();
  const preferredNames = Object.keys(interfaces).filter(
    (name) => !/(docker|vethernet|wsl|vmware|virtualbox|loopback)/i.test(name),
  );
  const interfaceNames = preferredNames.length > 0 ? preferredNames : Object.keys(interfaces);
  for (const name of interfaceNames) {
    const entries = interfaces[name];
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isTailscaleIpv4(entry.address) && /tailscale|utun/i.test(name)) {
        tailscaleAddresses.add(entry.address);
        continue;
      }
      if (entry.family === "IPv4" && !entry.internal && !/tailscale|utun/i.test(name)) {
        const octets = entry.address.split(".").map(Number);
        const second = octets[1] ?? -1;
        if (octets[0] === 10 || (octets[0] === 172 && second >= 16 && second <= 31) || (octets[0] === 192 && second === 168)) {
          lanAddresses.add(entry.address);
        }
      }
    }
  }
  return [
    ...[...tailscaleAddresses].map((address) => ({ address, network: "tailscale" as const })),
    ...[...lanAddresses].map((address) => ({ address, network: "lan" as const })),
  ];
}

/** Registers management-side pairing creation and global revocation controls. */
export function registerWallboardManagementRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pairings: WallboardPairingsRepository,
): void {
  app.post("/api/wallboard/pairings", { preHandler: requireSession }, async (_request, reply) => {
    const token = pairings.getOrCreateAccessToken();
    const links = wallboardNetworkAddresses().map(({ address, network }) => ({
      network,
      url: `http://${address}:${config.WALLBOARD_PORT}/connect?access_token=${encodeURIComponent(token)}`,
    }));
    const fallbackLink = {
      network: "lan" as const,
      url: `http://127.0.0.1:${config.WALLBOARD_PORT}/connect?access_token=${encodeURIComponent(token)}`,
    };
    const usableLinks = links.length > 0 ? links : [fallbackLink];
    return reply.send({
      expiresAt: null,
      links: usableLinks,
      qrCodeDataUrl: await QRCode.toDataURL(usableLinks[0]?.url ?? fallbackLink.url, { width: 320, margin: 2 }),
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
    const { token, access_token: accessToken } = pairingQuerySchema.parse(request.query);
    if (accessToken) {
      if (!pairings.hasAccessToken(accessToken)) {
        return reply.code(410).type("text/plain; charset=utf-8").send("大屏链接已被撤销，请在管理后台重新生成。");
      }
    } else if (!pairings.consume(hashPairingToken(token ?? ""))) {
      return reply.code(410).type("text/plain; charset=utf-8").send("旧版配对链接无效或已使用，请在管理后台重新生成。");
    }
    setWallboardSession(reply, pairings.generation());
    return reply.redirect("/wallboard");
  });

  app.get("/api/wallboard/session", async (request) => ({
    authenticated: hasWallboardSession(request, pairings.generation()),
    readonly: true,
  }));
}
