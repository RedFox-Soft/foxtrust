import { basename, join } from "node:path";

/**
 * Weights of the bot verdict (spec 007 research R5, data-model "Weights configuration"): versioned
 * files in config/bot/, chosen like the scoring configurations.
 */

export const KNOWN_CODES = [
  "env.webdriver", "env.cdp", "env.driver_globals", "env.headless_ua", "env.probe_missing", "env.engine_mismatch",
  "env.ua_mismatch", "env.hints_mismatch", "env.perm_inconsistent", "env.window_zero", "env.software_gl",
  "env.tz_mismatch", "req.headless_ua", "req.no_accept_language", "transport.ja4_mismatch", "transport.ja4_tool",
  "profile.uniform", "attest.returning_device",
] as const;
export type ReasonCode = (typeof KNOWN_CODES)[number];
export type PriorKey = "none" | "low" | "medium" | "high";

export type Weights = {
  version: string;
  priors: Record<PriorKey, number>;
  weights: Partial<Record<ReasonCode, number>>;
};

export class WeightsError extends Error {}

const BOT_DIR = join(import.meta.dir, "..", "..", "..", "config", "bot");
const VERSION = /^\d{4}-\d{2}-\d{2}\.\d+$/;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= -20 && v <= 20;

/** FOXTRUST_BOT_WEIGHTS, or the newest config/bot/<version>.json. */
export function activeWeightsFile(env: Record<string, string | undefined> = Bun.env): string {
  const chosen = env.FOXTRUST_BOT_WEIGHTS?.trim();
  if (chosen) return chosen;
  const files = [...new Bun.Glob("*.json").scanSync({ cwd: BOT_DIR })].filter((f) => VERSION.test(f.slice(0, -5))).sort();
  if (files.length === 0) throw new WeightsError(`no bot weights in ${BOT_DIR}`);
  return join(BOT_DIR, files.at(-1)!);
}

export function parseWeights(text: string, file: string): Weights {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new WeightsError(`${file}: not JSON (${(error as Error).message})`);
  }
  const problems: string[] = [];
  if (typeof value !== "object" || value === null) throw new WeightsError(`${file}: not an object`);
  const { version, priors, weights, descriptions } = value as Record<string, unknown>;
  const expected = basename(file).replace(/\.json$/, "");
  if (typeof version !== "string" || !VERSION.test(version)) problems.push("version must look like 2026-10-06.1");
  else if (VERSION.test(expected) && version !== expected) problems.push(`version ${version} does not match the file name ${expected}`);

  const p = (typeof priors === "object" && priors !== null ? priors : {}) as Record<string, unknown>;
  for (const key of ["none", "low", "medium", "high"]) if (!finite(p[key])) problems.push(`priors.${key} must be a number from -20 to 20`);
  const w = (typeof weights === "object" && weights !== null ? weights : {}) as Record<string, unknown>;
  const d = (typeof descriptions === "object" && descriptions !== null ? descriptions : {}) as Record<string, unknown>;
  for (const [code, weight] of Object.entries(w)) {
    if (!(KNOWN_CODES as readonly string[]).includes(code)) problems.push(`weights.${code} is not a known reason code`);
    else if (!finite(weight)) problems.push(`weights.${code} must be a number from -20 to 20`);
    else if (typeof d[code] !== "string" || d[code] === "") problems.push(`descriptions.${code} is missing`);
  }
  if (problems.length > 0) throw new WeightsError(`${file}: ${problems.join("; ")}`);
  return { version: version as string, priors: p as Record<PriorKey, number>, weights: w as Partial<Record<ReasonCode, number>> };
}

export async function loadWeights(file: string): Promise<Weights> {
  const f = Bun.file(file);
  if (!(await f.exists())) throw new WeightsError(`${file}: not found`);
  return parseWeights(await f.text(), file);
}
