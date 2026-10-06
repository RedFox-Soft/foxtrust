import { formatIp, type IpValue } from "../../ip/parse";
import { b64url, hmac, macMatches } from "../token";
import { leadingZeroBits, NONCE_BYTES } from "./pow";
import type { ReplayCache } from "./replay";

/**
 * Challenges of the built-in page (spec 006 research R2, data-model.md):
 * base64url(JSON {v:1, k, a, d, n, exp, nbf?}) + "." + base64url(MAC), where
 * MAC = HMAC-SHA256(secret, "foxtrust-challenge/1\n" + payload). The prefix keeps challenge MACs
 * apart from pass-token MACs made with the same secret, so neither can stand in for the other.
 */

export type ChallengeKind = "pow" | "wait";
export type RefusalReason = "malformed" | "signature" | "expired" | "address" | "nojs-off" | "early" | "solution" | "replay" | "device";

export const MAX_CHALLENGE_LENGTH = 512;
const MAC_DOMAIN = "foxtrust-challenge/1\n";
const SOLUTION = /^\d{1,20}$/;
const MAX_COUNTER = (1n << 64n) - 1n;

/** `u: 1` marks a step-up challenge of the bot verdict (spec 007); signed like every other field. */
/** `r` binds a zero-cost challenge to a returning-device token id (spec 008). */
type Payload = { v: 1; k: ChallengeKind; a: string; d: number; n: string; exp: number; nbf?: number; u?: 1; r?: string };

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
const challengeMac = (payload: string, secret: string) => hmac(MAC_DOMAIN + payload, secret);

export function issueChallenge(opts: {
  kind: ChallengeKind;
  ip: IpValue;
  bits: number;
  ttlSeconds: number;
  waitSeconds?: number;
  stepUp?: boolean;
  deviceId?: string;
  secret: string;
  now: Date;
}): string {
  const issued = seconds(opts.now);
  const body: Payload = {
    v: 1,
    k: opts.kind,
    a: formatIp(opts.ip),
    d: opts.kind === "pow" ? opts.bits : 0,
    n: b64url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))),
    exp: issued + opts.ttlSeconds,
  };
  if (opts.kind === "wait") body.nbf = issued + (opts.waitSeconds ?? 0);
  if (opts.stepUp) body.u = 1;
  if (opts.deviceId) body.r = opts.deviceId;
  const payload = b64url(JSON.stringify(body));
  return `${payload}.${b64url(challengeMac(payload, opts.secret))}`;
}

function decodePayload(payload: string): Payload | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, k, a, d, n, exp, nbf, u, r } = value as Record<string, unknown>;
  if (u !== undefined && u !== 1) return null;
  if (r !== undefined && (typeof r !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(r))) return null;
  if (v !== 1 || (k !== "pow" && k !== "wait") || typeof a !== "string" || typeof n !== "string") return null;
  if (!Number.isInteger(d) || !Number.isInteger(exp) || (nbf !== undefined && !Number.isInteger(nbf))) return null;
  if (Buffer.from(n, "base64url").length !== NONCE_BYTES) return null;
  return { v, k, a, d: d as number, n, exp: exp as number, ...(nbf === undefined ? {} : { nbf: nbf as number }), ...(u === 1 ? { u: 1 as const } : {}), ...(typeof r === "string" ? { r } : {}) };
}

export type AnswerResult =
  | { ok: true; kind: ChallengeKind; bits: number; nonce: string; stepUp: boolean; deviceId?: string }
  | { ok: false; reason: RefusalReason; bits?: number; remainingSeconds?: number };

/** Checks an answer in the order of data-model.md; the first failed check is the reason. */
export function checkAnswer(opts: {
  challenge: string | null;
  solution: string | null;
  ip: IpValue;
  secret: string;
  noJs: boolean;
  replay: ReplayCache;
  now: Date;
}): AnswerResult {
  const { challenge, solution } = opts;
  // 1. Size and shape, before any MAC or hash.
  if (!challenge || challenge.length > MAX_CHALLENGE_LENGTH) return { ok: false, reason: "malformed" };
  const dot = challenge.indexOf(".");
  if (dot <= 0 || dot !== challenge.lastIndexOf(".")) return { ok: false, reason: "malformed" };
  if (solution !== null && (!SOLUTION.test(solution) || BigInt(solution) > MAX_COUNTER)) return { ok: false, reason: "malformed" };

  // 2. Signature.
  const payloadText = challenge.slice(0, dot);
  if (!macMatches(challenge.slice(dot + 1), challengeMac(payloadText, opts.secret))) return { ok: false, reason: "signature" };
  const payload = decodePayload(payloadText);
  if (!payload) return { ok: false, reason: "malformed" };
  if (payload.k === "pow" && solution === null) return { ok: false, reason: "malformed", bits: payload.d };
  const bits = payload.k === "pow" ? payload.d : 0;
  const refuse = (reason: RefusalReason, extra: { remainingSeconds?: number } = {}): AnswerResult =>
    ({ ok: false, reason, ...(payload.k === "pow" ? { bits } : {}), ...extra });

  // 3–6. Expiry, address, kind, earliest submit time.
  const now = seconds(opts.now);
  if (payload.exp <= now) return refuse("expired");
  if (payload.a !== formatIp(opts.ip)) return refuse("address");
  if (payload.k === "wait" && !opts.noJs) return refuse("nojs-off");
  if (payload.k === "wait" && (payload.nbf ?? 0) > now) return refuse("early", { remainingSeconds: (payload.nbf ?? 0) - now });

  // 7. Proof-of-work, checked natively.
  if (payload.k === "pow") {
    const input = new Uint8Array(24);
    input.set(Buffer.from(payload.n, "base64url"));
    new DataView(input.buffer).setBigUint64(16, BigInt(solution!));
    const hash = new Uint8Array(new Bun.CryptoHasher("sha256").update(input).digest());
    if (leadingZeroBits(hash) < bits) return refuse("solution");
  }

  // 8–9. Single use per instance.
  if (opts.replay.has(payload.n)) return refuse("replay");
  opts.replay.add(payload.n, payload.exp, now);
  return { ok: true, kind: payload.k, bits, nonce: payload.n, stepUp: payload.u === 1, ...(payload.r ? { deviceId: payload.r } : {}) };
}

/** The payload of a challenge string, without checking it (tests and the page use it). */
export function readChallenge(challenge: string): { kind: ChallengeKind; nonce: Uint8Array; bits: number; exp: number; nbf?: number } | null {
  const payload = decodePayload(challenge.split(".")[0] ?? "");
  if (!payload) return null;
  return {
    kind: payload.k,
    nonce: new Uint8Array(Buffer.from(payload.n, "base64url")),
    bits: payload.d,
    exp: payload.exp,
    ...(payload.nbf === undefined ? {} : { nbf: payload.nbf }),
  };
}
