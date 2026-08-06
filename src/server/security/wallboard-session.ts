import type { FastifyReply, FastifyRequest } from "fastify";

import type { WallboardPairingsRepository } from "../db/wallboard-pairings-repository";

const WALLBOARD_COOKIE_NAME = "ozon_wallboard";
const WALLBOARD_SESSION_SECONDS = 30 * 24 * 60 * 60;

interface WallboardSessionPayload {
  generation: number;
  expiresAt: number;
}

/** Writes a signed read-only session after one-time pairing succeeds. */
export function setWallboardSession(reply: FastifyReply, generation: number): void {
  const payload: WallboardSessionPayload = {
    generation,
    expiresAt: Date.now() + WALLBOARD_SESSION_SECONDS * 1000,
  };
  reply.setCookie(WALLBOARD_COOKIE_NAME, Buffer.from(JSON.stringify(payload)).toString("base64url"), {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    signed: true,
    maxAge: WALLBOARD_SESSION_SECONDS,
  });
}

/** Validates both the signed cookie and the current revocation generation. */
export function hasWallboardSession(request: FastifyRequest, generation: number): boolean {
  const signedValue = request.cookies[WALLBOARD_COOKIE_NAME];
  if (!signedValue) {
    return false;
  }
  const unsigned = request.unsignCookie(signedValue);
  if (!unsigned.valid || !unsigned.value) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(unsigned.value, "base64url").toString("utf8")) as WallboardSessionPayload;
    return payload.generation === generation && payload.expiresAt > Date.now();
  } catch {
    return false;
  }
}

export function wallboardAuthorization(pairings: WallboardPairingsRepository) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!hasWallboardSession(request, pairings.generation())) {
      await reply.code(401).send({ error: "PAIRING_REQUIRED", message: "请使用管理后台生成的配对链接" });
    }
  };
}
