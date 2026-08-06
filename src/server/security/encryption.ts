import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = "v1";

/** Encrypts a secret with AES-256-GCM and an application-level master key. */
export function encryptSecret(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

/** Decrypts a value produced by {@link encryptSecret}. */
export function decryptSecret(payload: string, hexKey: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = payload.split(":");
  if (version !== VERSION || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Unsupported encrypted secret format");
  }

  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Compares two strings without leaking the matching prefix through timing. */
export function safeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
