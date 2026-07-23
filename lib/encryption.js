import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEncryptionKey } from "./env.js";

const ALGORITHM = "aes-256-gcm";
const VERSION = 1;

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return {
    version: VERSION,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: encrypted.toString("base64url"),
  };
}

export function decryptSecret(payload) {
  if (!payload || payload.version !== VERSION) throw new Error("Unsupported encrypted secret format.");

  const decipher = createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(payload.iv, "base64url")
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
