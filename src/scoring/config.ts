import type { ScoringConfig } from "../model/types";

export const ALGORITHM_VERSION = "noisy-or/1";

/** Contribution (risk points) below which a signal is considered irrelevant (research R6). */
export const RELEVANCE_POINTS = 0.5;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid scoring configuration:\n- ${problems.join("\n- ")}`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isUnit = (v: unknown): v is number => typeof v === "number" && v >= 0 && v <= 1;

function checkKeys(obj: Record<string, unknown>, allowed: string[], path: string, problems: string[]) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) problems.push(`${path}: unknown field "${key}"`);
  }
}

/** Validates against schemas/scoring-config.schema.json plus FR-009 and FR-029a. */
export function validateConfig(input: unknown): string[] {
  const problems: string[] = [];
  if (!isObject(input)) return ["config must be a JSON object"];
  checkKeys(
    input,
    ["version", "algorithm", "levels", "categoryOnlyMaxRisk", "retention", "codes", "sourceConfidence"],
    "config",
    problems,
  );

  if (typeof input.version !== "string" || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(input.version)) {
    problems.push('version must look like "YYYY-MM-DD.N"');
  }
  if (input.algorithm !== ALGORITHM_VERSION) problems.push(`algorithm must be "${ALGORITHM_VERSION}"`);

  const levels = input.levels;
  let high = NaN;
  if (!isObject(levels)) {
    problems.push("levels must be an object with medium and high");
  } else {
    checkKeys(levels, ["medium", "high"], "levels", problems);
    const medium = levels.medium;
    high = typeof levels.high === "number" ? levels.high : NaN;
    if (typeof medium !== "number" || medium <= 0 || medium >= 100) problems.push("levels.medium must be in (0, 100)");
    if (!(high > 0 && high <= 100)) problems.push("levels.high must be in (0, 100]");
    if (typeof medium === "number" && medium >= high) problems.push("levels.medium must be below levels.high");
  }

  const cap = input.categoryOnlyMaxRisk;
  if (typeof cap !== "number" || cap < 0) {
    problems.push("categoryOnlyMaxRisk must be a number ≥ 0");
  } else if (!(cap < high)) {
    problems.push("categoryOnlyMaxRisk must be below levels.high (FR-009)");
  }

  const retention = input.retention;
  let horizonHours = NaN;
  if (!isObject(retention)) {
    problems.push("retention must be an object with rawDays and aggregateDays");
  } else {
    checkKeys(retention, ["rawDays", "aggregateDays"], "retention", problems);
    const { rawDays, aggregateDays } = retention;
    if (!Number.isInteger(rawDays) || (rawDays as number) < 1) problems.push("retention.rawDays must be an integer ≥ 1");
    if (!Number.isInteger(aggregateDays) || (aggregateDays as number) < 1) {
      problems.push("retention.aggregateDays must be an integer ≥ 1");
    }
    horizonHours = ((rawDays as number) + (aggregateDays as number)) * 24;
  }

  const codes = input.codes;
  if (!isObject(codes) || Object.keys(codes).length === 0) {
    problems.push("codes must be a non-empty object");
  } else {
    for (const [code, def] of Object.entries(codes)) {
      const path = `codes.${code}`;
      if (!isObject(def)) {
        problems.push(`${path} must be an object`);
        continue;
      }
      if (typeof def.description !== "string" || def.description.trim() === "") {
        problems.push(`${path}.description is required`);
      }
      if (!isUnit(def.weight)) problems.push(`${path}.weight must be in [0, 1]`);
      if (def.kind === "category") {
        checkKeys(def, ["kind", "category", "weight", "description"], path, problems);
        if (typeof def.category !== "string" || def.category === "") problems.push(`${path}.category is required`);
      } else if (def.kind === "behavior") {
        checkKeys(def, ["kind", "weight", "halfLifeHours", "description"], path, problems);
        const h = def.halfLifeHours;
        if (typeof h !== "number" || h <= 0) {
          problems.push(`${path}.halfLifeHours must be > 0`);
        } else if (Number.isFinite(horizonHours) && 100 * 2 ** (-horizonHours / h) >= RELEVANCE_POINTS) {
          const limit = horizonHours / Math.log2(100 / RELEVANCE_POINTS);
          problems.push(
            `${path}.halfLifeHours ${h} is too long for the retention period: a signal would still add ` +
              `≥ ${RELEVANCE_POINTS} risk points when its data is deleted (FR-029a; limit ≈ ${Math.floor(limit)} h)`,
          );
        }
      } else {
        problems.push(`${path}.kind must be "category" or "behavior"`);
      }
    }
  }

  const sources = input.sourceConfidence;
  if (!isObject(sources)) {
    problems.push("sourceConfidence must be an object");
  } else {
    for (const [source, value] of Object.entries(sources)) {
      if (!isUnit(value)) problems.push(`sourceConfidence.${source} must be in [0, 1]`);
    }
  }
  return problems;
}

export function parseConfig(input: unknown): ScoringConfig {
  const problems = validateConfig(input);
  if (problems.length > 0) throw new ConfigError(problems);
  return input as ScoringConfig;
}

export async function loadConfig(path: string): Promise<ScoringConfig> {
  return parseConfig(await Bun.file(path).json());
}

/** JSON with object keys sorted at every level, so equal configs hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function configSha256(config: ScoringConfig): string {
  return new Bun.CryptoHasher("sha256").update(canonicalJson(config)).digest("hex");
}

/** Hours after which retention has deleted all behavior data (raw window + aggregate window). */
export function retentionHorizonHours(config: ScoringConfig): number {
  return (config.retention.rawDays + config.retention.aggregateDays) * 24;
}

/** Age (hours) after which no behavior code can still add RELEVANCE_POINTS (research R6). */
export function relevanceHorizonHours(config: ScoringConfig): number {
  let max = 0;
  for (const def of Object.values(config.codes)) {
    if (def.kind !== "behavior") continue;
    const ratio = (100 * def.weight) / RELEVANCE_POINTS;
    if (ratio > 1) max = Math.max(max, def.halfLifeHours * Math.log2(ratio));
  }
  return max;
}
