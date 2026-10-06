import type { Engine, ProbeResult } from "./probe-types";

/**
 * Size and schema check of the probe result in form field `p` (spec 007 research R4). Anything that
 * is not exactly the expected shape, or is bound to another challenge, is treated as missing: the
 * caller then adds `env.probe_missing`. Never throws.
 */

export const MAX_PROBE_BYTES = 2048;

const KEYS = new Set(["n", "webdriver", "cdp", "globals", "uaHeadless", "ua", "uaData", "engine", "gl", "tz", "langs", "screen", "perm", "err"]);
const ENGINES: Engine[] = ["chromium", "gecko", "webkit", "unknown"];
const GL = ["soft", "hw", "unknown"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const int = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const strArray = (v: unknown, items: number, max: number): v is string[] => Array.isArray(v) && v.length <= items && v.every((x) => str(x, max));

function parseUaData(v: unknown): ProbeResult["uaData"] | undefined {
  if (v === null) return null;
  if (!isRecord(v) || Object.keys(v).some((k) => k !== "brands" && k !== "mobile" && k !== "platform")) return undefined;
  const { brands, mobile, platform } = v;
  if (!Array.isArray(brands) || brands.length > 8 || typeof mobile !== "boolean" || !str(platform, 32)) return undefined;
  const parsed: { brand: string; version: string }[] = [];
  for (const b of brands) {
    if (!isRecord(b) || Object.keys(b).length !== 2 || !str(b.brand, 64) || !str(b.version, 16)) return undefined;
    parsed.push({ brand: b.brand, version: b.version });
  }
  return { brands: parsed, mobile, platform };
}

function parseScreen(v: unknown): ProbeResult["screen"] | undefined {
  if (!isRecord(v) || Object.keys(v).length !== 7) return undefined;
  const { sw, sh, iw, ih, ow, oh, dpr } = v;
  for (const n of [sw, sh, iw, ih, ow, oh]) if (!int(n, 0, 100_000)) return undefined;
  if (typeof dpr !== "number" || !Number.isFinite(dpr) || dpr < 0 || dpr > 10) return undefined;
  return { sw: sw as number, sh: sh as number, iw: iw as number, ih: ih as number, ow: ow as number, oh: oh as number, dpr };
}

/** The probe result for the challenge with nonce `nonce`, or null when missing or invalid. */
export function parseProbe(text: string | null | undefined, nonce: string | null): ProbeResult | null {
  if (!text || text.length > MAX_PROBE_BYTES || nonce === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return checkProbe(value, nonce);
}

/** Schema check of an already parsed value; `nonce` "*" accepts the placeholder of recorded samples. */
export function checkProbe(value: unknown, nonce: string): ProbeResult | null {
  if (!isRecord(value) || Object.keys(value).some((k) => !KEYS.has(k)) || Object.keys(value).length !== KEYS.size) return null;
  const v = value;
  if (!str(v.n, 64) || (v.n !== nonce && nonce !== "*")) return null;
  if (typeof v.webdriver !== "boolean" || typeof v.cdp !== "boolean" || typeof v.uaHeadless !== "boolean" || typeof v.perm !== "boolean") return null;
  if (!int(v.globals, 0, 64) || !str(v.ua, 512) || !str(v.tz, 64)) return null;
  if (!ENGINES.includes(v.engine as Engine) || !(GL as readonly unknown[]).includes(v.gl)) return null;
  if (!strArray(v.langs, 3, 35) || !strArray(v.err, 16, 32)) return null;
  const uaData = parseUaData(v.uaData);
  const screen = parseScreen(v.screen);
  if (uaData === undefined || !screen) return null;
  return {
    n: v.n, webdriver: v.webdriver, cdp: v.cdp, globals: v.globals, uaHeadless: v.uaHeadless, ua: v.ua, uaData,
    engine: v.engine as Engine, gl: v.gl as ProbeResult["gl"], tz: v.tz, langs: v.langs, screen, perm: v.perm, err: v.err,
  };
}
