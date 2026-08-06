import type { FastifyReply, FastifyRequest } from "fastify";

const COOKIE_NAME = "ozon_session";
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

interface SessionPayload {
  username: string;
  expiresAt: number;
}

/** Creates the signed-cookie payload for the single administrator. */
export function createSessionPayload(username: string): string {
  const payload: SessionPayload = {
    username,
    expiresAt: Date.now() + SESSION_DURATION_SECONDS * 1000,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function setSessionCookie(reply: FastifyReply, username: string, secure: boolean): void {
  reply.setCookie(COOKIE_NAME, createSessionPayload(username), {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure,
    signed: true,
    maxAge: SESSION_DURATION_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure,
  });
}

/** Returns the authenticated username or null when the cookie is absent, invalid, or expired. */
export function readSession(request: FastifyRequest): string | null {
  const signedValue = request.cookies[COOKIE_NAME];
  if (!signedValue) {
    return null;
  }
  const unsigned = request.unsignCookie(signedValue);
  if (!unsigned.valid || !unsigned.value) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(unsigned.value, "base64url").toString("utf8")) as SessionPayload;
    if (!payload.username || payload.expiresAt <= Date.now()) {
      return null;
    }
    return payload.username;
  } catch {
    return null;
  }
}

export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!readSession(request)) {
    await reply.code(401).send({ error: "AUTH_REQUIRED", message: "请先登录" });
  }
}

