import type { BehaviorPayload, HoldKind } from "./behavior-types";

/**
 * Size and schema check of the hold-step input in form field `b` (spec 009 data-model). Anything not
 * exactly the expected shape, or bound to another challenge, is treated as missing. Never throws.
 */

export const MAX_BEHAVIOR_BYTES = 4096;

const KEYS = new Set(["n", "res", "box", "kind", "ptr", "press", "release", "moves", "keys", "untrusted", "vis"]);
const KINDS: HoldKind[] = ["mouse", "pen", "touch", "key"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const T = (v: unknown) => int(v, 0, 600_000);
const XY = (v: unknown) => int(v, -10_000, 10_000);

export function parseBehavior(text: string | null | undefined, nonce: string | null): BehaviorPayload | null {
  if (!text || text.length > MAX_BEHAVIOR_BYTES || nonce === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return checkBehavior(value, nonce);
}

/** Schema check of a parsed value; `nonce` "*" accepts recorded samples. */
export function checkBehavior(value: unknown, nonce: string): BehaviorPayload | null {
  if (!isRecord(value) || Object.keys(value).length !== KEYS.size || Object.keys(value).some((k) => !KEYS.has(k))) return null;
  const v = value;
  if (typeof v.n !== "string" || v.n.length > 64 || (v.n !== nonce && nonce !== "*")) return null;
  if (typeof v.res !== "number" || !Number.isFinite(v.res) || v.res < 0 || v.res > 1000) return null;
  if (!isRecord(v.box) || !int(v.box.w, 1, 2000) || !int(v.box.h, 1, 2000)) return null;
  if (!KINDS.includes(v.kind as HoldKind)) return null;
  if (!Array.isArray(v.ptr) || v.ptr.length > 200 || !v.ptr.every((p) => Array.isArray(p) && p.length === 3 && T(p[0]) && XY(p[1]) && XY(p[2]))) return null;
  const press = v.press;
  if (!Array.isArray(press) || press.length !== 3 || !T(press[0]) || !(press[1] === null || XY(press[1])) || !(press[2] === null || XY(press[2]))) return null;
  if (!T(v.release) || (v.release as number) < (press[0] as number)) return null;
  if (!isRecord(v.moves) || !int(v.moves.count, 0, 10_000) || !int(v.moves.maxPx, 0, 10_000)) return null;
  if (!Array.isArray(v.keys) || v.keys.length > 100 || !v.keys.every((k) => Array.isArray(k) && k.length === 3 && T(k[0]) && (k[1] === "d" || k[1] === "u") && (k[2] === 0 || k[2] === 1))) return null;
  if (!int(v.untrusted, 0, 10_000)) return null;
  if (!Array.isArray(v.vis) || v.vis.length > 20 || !v.vis.every((e) => Array.isArray(e) && e.length === 2 && T(e[0]) && ["h", "v", "f", "b"].includes(e[1] as string))) return null;
  return v as unknown as BehaviorPayload;
}
