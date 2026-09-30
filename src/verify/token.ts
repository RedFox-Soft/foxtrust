import { timingSafeEqual } from "node:crypto";
import { formatIp, toIpValue, type IpValue } from "../ip/parse";

/**
 * Challenge-pass tokens (research R9): base64url(JSON {ip, exp, v:1}) + "." +
 * base64url(HMAC-SHA256(secret, payload)). Stateless, bound to one client address.
 */

const MAX_TOKEN_LENGTH = 1024;

const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
const mac = (payload: string, secret: string) => new Uint8Array(new Bun.CryptoHasher("sha256", secret).update(payload).digest());

/** Issues a token (the future challenge page does this; tests use it too). */
export function issuePassToken(ip: IpValue, ttlSeconds: number, secret: string, now = new Date()): string {
  const payload = b64url(JSON.stringify({ ip: formatIp(ip), exp: Math.floor(now.getTime() / 1000) + ttlSeconds, v: 1 }));
  return `${payload}.${b64url(mac(payload, secret))}`;
}

/** True only for a well-formed token with a valid MAC, not yet expired, for exactly `ip`. */
export function verifyPassToken(token: string | null, ip: IpValue, secret: string | null, now = new Date()): boolean {
  if (!token || !secret || token.length > MAX_TOKEN_LENGTH) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return false;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = mac(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (typeof claims !== "object" || claims === null) return false;
  const { ip: claimedIp, exp, v } = claims as Record<string, unknown>;
  if (v !== 1 || typeof exp !== "number" || typeof claimedIp !== "string") return false;
  if (exp * 1000 <= now.getTime()) return false;
  const claimed = toIpValue(claimedIp);
  return !("error" in claimed) && claimed.family === ip.family && claimed.value === ip.value;
}
