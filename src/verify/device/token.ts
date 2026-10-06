import { b64url, hmac, macMatches } from "../token";

/**
 * Returning-device token (spec 008 research R1): base64url(JSON {v:1, id, h, exp}) + "." + MAC with
 * the domain "foxtrust-device/1", so it never verifies as a pass or a challenge. A random id, the
 * protected host and an expiry: no address and no client data (constitution v5.1.0 Principle IV).
 */

export const DEVICE_COOKIE = "foxtrust_device";
const MAC_DOMAIN = "foxtrust-device/1\n";
const MAX_LENGTH = 256;
const ID = /^[A-Za-z0-9_-]{22}$/;

const mac = (payload: string, secret: string) => hmac(MAC_DOMAIN + payload, secret);
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export function issueDeviceToken(opts: { host: string; ttlDays: number; secret: string; now: Date }): { token: string; id: string; exp: number } {
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const exp = seconds(opts.now) + opts.ttlDays * 86_400;
  const payload = b64url(JSON.stringify({ v: 1, id, h: opts.host.toLowerCase(), exp }));
  return { token: `${payload}.${b64url(mac(payload, opts.secret))}`, id, exp };
}

/** The token's id and expiry when it is genuine, unexpired and for `host`; otherwise null. */
export function readDeviceToken(value: string | null, opts: { host: string | null; secret: string; now: Date }): { id: string; exp: number } | null {
  if (!value || !opts.host || value.length > MAX_LENGTH) return null;
  const dot = value.indexOf(".");
  if (dot <= 0 || dot !== value.lastIndexOf(".")) return null;
  const payload = value.slice(0, dot);
  if (!macMatches(value.slice(dot + 1), mac(payload, opts.secret))) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { v, id, h, exp } = claims as Record<string, unknown>;
  if (v !== 1 || typeof id !== "string" || !ID.test(id) || typeof h !== "string" || typeof exp !== "number") return null;
  if (h !== opts.host.toLowerCase() || exp <= seconds(opts.now)) return null;
  return { id, exp };
}

export function deviceCookie(token: string, ttlDays: number, plainHttp: boolean): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${ttlDays * 86_400}; HttpOnly; SameSite=Lax${plainHttp ? "" : "; Secure"}`;
}

export function clearDeviceCookie(plainHttp: boolean): string {
  return `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${plainHttp ? "" : "; Secure"}`;
}
