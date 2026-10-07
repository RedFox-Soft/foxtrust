import { timingSafeEqual } from "node:crypto";

/**
 * API keys (spec 010 research R2): `ftk_<id>_<secret>`. The id is public (lists, logs, the admin
 * panel); the secret is 256 random bits and is stored only as its SHA-256.
 */

const ID_BYTES = 9;
const SECRET_BYTES = 32;
/** 12 and 43 base64url characters. */
const KEY_PATTERN = /^ftk_([A-Za-z0-9_-]{12})_([A-Za-z0-9_-]{43})$/;
const MAX_KEY_LENGTH = 64;

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const random = (n: number) => base64url(crypto.getRandomValues(new Uint8Array(n)));

export function hashSecret(secret: string): Uint8Array {
  return new Bun.CryptoHasher("sha256").update(secret).digest();
}

export function generateKey(): { id: string; secret: string; full: string; sha256: Uint8Array } {
  const id = random(ID_BYTES);
  const secret = random(SECRET_BYTES);
  return { id, secret, full: `ftk_${id}_${secret}`, sha256: hashSecret(secret) };
}

/** The id and secret of a well-formed key, or null; never does work on over-long input. */
export function parseKey(text: string): { id: string; secret: string } | null {
  if (text.length > MAX_KEY_LENGTH) return null;
  const match = KEY_PATTERN.exec(text);
  return match ? { id: match[1]!, secret: match[2]! } : null;
}

export function secretMatches(secret: string, sha256: Uint8Array): boolean {
  const actual = hashSecret(secret);
  return actual.length === sha256.length && timingSafeEqual(actual, sha256);
}

/** How a key is shown after creation: its id only. */
export const displayKey = (id: string) => `ftk_${id}_…`;
