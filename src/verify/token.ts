import { timingSafeEqual } from "node:crypto";
import { contains, formatCidr, parseCidr, type Cidr } from "../ip/cidr";
import { formatIp, toIpValue, type IpValue } from "../ip/parse";

/**
 * Challenge-pass tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payload)).
 * Stateless.
 * - v1 `{ip, exp, v:1}` (spec 002 research R9): bound to one exact client address.
 * - v2 `{net, exp, v:2}` (spec 006 research R5): bound to the client's /32 (IPv4) or /64 (IPv6),
 *   issued by the built-in challenge page. The prefix length is fixed per family, so even a
 *   correctly signed token cannot cover more.
 */

const MAX_TOKEN_LENGTH = 1024;
/** Prefix length a v2 pass binds, per family. */
export const PASS_PREFIX: Record<4 | 6, number> = { 4: 32, 6: 64 };

export const b64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");
export const hmac = (payload: string, secret: string) => new Uint8Array(new Bun.CryptoHasher("sha256", secret).update(payload).digest());

/** Constant-time check of a base64url MAC against the expected bytes. */
export function macMatches(given: string, expected: Uint8Array): boolean {
  const bytes = Buffer.from(given, "base64url");
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
}

/** Issues a v1 token (tests and external challenge pages use it). */
export function issuePassToken(ip: IpValue, ttlSeconds: number, secret: string, now = new Date()): string {
  const payload = b64url(JSON.stringify({ ip: formatIp(ip), exp: Math.floor(now.getTime() / 1000) + ttlSeconds, v: 1 }));
  return `${payload}.${b64url(hmac(payload, secret))}`;
}

/** The network a v2 pass for `ip` covers. */
export function passNetwork(ip: IpValue): Cidr {
  const length = PASS_PREFIX[ip.family];
  const hostBits = BigInt((ip.family === 4 ? 32 : 128) - length);
  return { family: ip.family, network: (ip.value >> hostBits) << hostBits, length };
}

/** Issues a v2 token for the /32 or /64 of `ip` (the built-in challenge page). */
export function issuePassTokenV2(ip: IpValue, ttlSeconds: number, secret: string, now = new Date()): string {
  const payload = b64url(JSON.stringify({ net: formatCidr(passNetwork(ip)), exp: Math.floor(now.getTime() / 1000) + ttlSeconds, v: 2 }));
  return `${payload}.${b64url(hmac(payload, secret))}`;
}

/** True only for a well-formed token with a valid MAC, not yet expired, that covers `ip`. */
export function verifyPassToken(token: string | null, ip: IpValue, secret: string | null, now = new Date()): boolean {
  if (!token || !secret || token.length > MAX_TOKEN_LENGTH) return false;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return false;
  const payload = token.slice(0, dot);
  if (!macMatches(token.slice(dot + 1), hmac(payload, secret))) return false;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (typeof claims !== "object" || claims === null) return false;
  const { ip: claimedIp, net, exp, v } = claims as Record<string, unknown>;
  if (typeof exp !== "number" || exp * 1000 <= now.getTime()) return false;

  if (v === 1 && typeof claimedIp === "string") {
    const claimed = toIpValue(claimedIp);
    return !("error" in claimed) && claimed.family === ip.family && claimed.value === ip.value;
  }
  if (v === 2 && typeof net === "string") {
    const cidr = parseCidr(net);
    return cidr !== null && cidr.length === PASS_PREFIX[cidr.family] && contains(cidr, ip);
  }
  return false;
}
