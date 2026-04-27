import crypto from "node:crypto";

export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
