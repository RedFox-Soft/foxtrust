import type { Level } from "../model/types";
import type { CustomerVerdict } from "../verdict/customer";

/** Operator policy (contracts/policy.schema.json, research R7). */
export type Action = "allow" | "challenge" | "block";

export type Conditions = {
  levelAtLeast?: Level;
  riskAtLeast?: number;
  categories?: string[];
  codes?: string[];
  seenWithinHours?: number;
  path?: string;
  method?: string[];
  noData?: boolean;
};

export type Rule = { name: string; when: Conditions; action: Action; pathRegex?: RegExp };
export type Policy = { version: 1; default: Action; rules: Rule[] };

export type PolicyVocabulary = { categories: string[]; codes: string[] };

export const MAX_POLICY_BYTES = 256 * 1024;
export const MAX_RULES = 500;
const ACTIONS: Action[] = ["allow", "challenge", "block"];
const LEVELS: Level[] = ["low", "medium", "high"];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const CONDITION_KEYS = ["levelAtLeast", "riskAtLeast", "categories", "codes", "seenWithinHours", "path", "method", "noData"];

export class PolicyError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid policy:\n- ${problems.join("\n- ")}`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `*` matches any characters; everything else is literal. */
export function globToRegex(glob: string): RegExp {
  const escaped = glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`);
}

/** Parses YAML or JSON policy text and validates it; throws PolicyError with item paths. */
export function parsePolicy(text: string, vocabulary: PolicyVocabulary): Policy {
  if (new TextEncoder().encode(text).length > MAX_POLICY_BYTES) {
    throw new PolicyError([`policy is larger than ${MAX_POLICY_BYTES} bytes`]);
  }
  // Anchors and aliases are what YAML bombs are made of; policies never need them.
  if (/(^|[\s:[{,-])[&*][A-Za-z0-9_]/m.test(text.replace(/"[^"\n]*"|'[^'\n]*'/g, '""'))) {
    throw new PolicyError(["YAML anchors and aliases (&name, *name) are not allowed in policies"]);
  }
  let raw: unknown;
  try {
    raw = text.trimStart().startsWith("{") ? JSON.parse(text) : Bun.YAML.parse(text);
  } catch (error) {
    throw new PolicyError([`not valid YAML or JSON: ${(error as Error).message}`]);
  }

  const problems: string[] = [];
  const categories = new Set(vocabulary.categories);
  const codes = new Set(vocabulary.codes);
  if (!isObject(raw)) throw new PolicyError(["policy must be a mapping"]);
  for (const key of Object.keys(raw)) if (!["version", "default", "rules"].includes(key)) problems.push(`unknown key "${key}"`);
  if (raw.version !== 1) problems.push("version must be 1");
  if (!ACTIONS.includes(raw.default as Action)) problems.push(`default must be one of ${ACTIONS.join(", ")}`);
  if (!Array.isArray(raw.rules)) problems.push("rules must be a list");
  const rulesIn = Array.isArray(raw.rules) ? raw.rules : [];
  if (rulesIn.length > MAX_RULES) problems.push(`at most ${MAX_RULES} rules are allowed`);

  const names = new Set<string>();
  const rules: Rule[] = [];
  rulesIn.slice(0, MAX_RULES).forEach((r, i) => {
    const at = `rules[${i}]`;
    if (!isObject(r)) {
      problems.push(`${at} must be a mapping`);
      return;
    }
    for (const key of Object.keys(r)) if (!["name", "when", "action"].includes(key)) problems.push(`${at}: unknown key "${key}"`);
    const name = r.name;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) problems.push(`${at}.name must be lower-case letters, digits and dashes`);
    else if (names.has(name)) problems.push(`${at}.name "${name}" is used twice`);
    else names.add(name);
    if (!ACTIONS.includes(r.action as Action)) problems.push(`${at}.action must be one of ${ACTIONS.join(", ")}`);
    const when = r.when;
    if (!isObject(when) || Object.keys(when).length === 0) {
      problems.push(`${at}.when must be a non-empty mapping`);
      return;
    }
    for (const key of Object.keys(when)) if (!CONDITION_KEYS.includes(key)) problems.push(`${at}.when: unknown key "${key}"`);
    if (when.levelAtLeast !== undefined && !LEVELS.includes(when.levelAtLeast as Level)) problems.push(`${at}.when.levelAtLeast must be low, medium or high`);
    if (when.riskAtLeast !== undefined && !(typeof when.riskAtLeast === "number" && when.riskAtLeast >= 0 && when.riskAtLeast <= 100)) {
      problems.push(`${at}.when.riskAtLeast must be a number from 0 to 100`);
    }
    const list = (key: "categories" | "codes" | "method", allowed: Set<string>) => {
      const v = when[key];
      if (v === undefined) return;
      if (!Array.isArray(v) || v.length === 0) {
        problems.push(`${at}.when.${key} must be a non-empty list`);
        return;
      }
      v.forEach((item, j) => {
        if (typeof item !== "string" || !allowed.has(item)) problems.push(`${at}.when.${key}[${j}]: unknown value ${JSON.stringify(item)}`);
      });
    };
    list("categories", categories);
    list("codes", codes);
    list("method", new Set(METHODS));
    if (when.seenWithinHours !== undefined) {
      if (!(typeof when.seenWithinHours === "number" && when.seenWithinHours > 0)) problems.push(`${at}.when.seenWithinHours must be > 0`);
      if (when.codes === undefined) problems.push(`${at}.when.seenWithinHours needs codes`);
    }
    if (when.path !== undefined && (typeof when.path !== "string" || !when.path.startsWith("/"))) problems.push(`${at}.when.path must be a glob starting with /`);
    if (when.noData !== undefined && typeof when.noData !== "boolean") problems.push(`${at}.when.noData must be true or false`);
    const conditions = when as Conditions;
    rules.push({
      name: String(name),
      when: conditions,
      action: r.action as Action,
      ...(typeof conditions.path === "string" ? { pathRegex: globToRegex(conditions.path) } : {}),
    });
  });

  if (problems.length > 0) throw new PolicyError(problems);
  return { version: 1, default: raw.default as Action, rules };
}

const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };

function matches(rule: Rule, verdict: CustomerVerdict | null, ctx: { path: string; method: string; now: Date }): boolean {
  const w = rule.when;
  if (w.noData !== undefined && w.noData !== (verdict === null)) return false;
  if (w.path !== undefined && !rule.pathRegex!.test(ctx.path)) return false;
  if (w.method !== undefined && !w.method.includes(ctx.method.toUpperCase())) return false;
  const needsVerdict = w.levelAtLeast !== undefined || w.riskAtLeast !== undefined || w.categories !== undefined || w.codes !== undefined;
  if (!needsVerdict) return true;
  if (verdict === null) return false;
  if (w.levelAtLeast !== undefined && RANK[verdict.level] < RANK[w.levelAtLeast]) return false;
  if (w.riskAtLeast !== undefined && verdict.risk < w.riskAtLeast) return false;
  if (w.categories !== undefined && !w.categories.some((c) => verdict.categories.includes(c))) return false;
  if (w.codes !== undefined) {
    const cutoff = w.seenWithinHours === undefined ? -Infinity : ctx.now.getTime() - w.seenWithinHours * 3_600_000;
    if (!verdict.reasons.some((r) => w.codes!.includes(r.code) && Date.parse(r.lastSeen) >= cutoff)) return false;
  }
  return true;
}

/** First matching rule wins; otherwise the default action. */
export function evaluate(
  policy: Policy,
  verdict: CustomerVerdict | null,
  ctx: { path: string; method: string; now?: Date },
): { action: Action; rule: string | null } {
  const path = ctx.path.split("?")[0] || "/";
  const full = { path, method: ctx.method, now: ctx.now ?? new Date() };
  for (const rule of policy.rules) if (matches(rule, verdict, full)) return { action: rule.action, rule: rule.name };
  return { action: policy.default, rule: null };
}

/** Category names and codes a policy may refer to, from a scoring configuration. */
export function vocabularyFromConfig(config: { codes: Record<string, { kind: string; category?: string }> }): PolicyVocabulary {
  const categories = new Set<string>();
  for (const def of Object.values(config.codes)) if (def.kind === "category" && def.category) categories.add(def.category);
  return { categories: [...categories], codes: Object.keys(config.codes) };
}
