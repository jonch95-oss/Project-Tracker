import { sha256Hex } from "@/core/audit";

/** 256-bit random token, base64url. Only its hash is stored. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function hashToken(token: string): Promise<string> {
  return sha256Hex(`invite:${token}`);
}
