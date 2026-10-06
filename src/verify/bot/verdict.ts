import type { Level } from "../../model/types";
import type { PriorKey, ReasonCode, Weights } from "./weights";

/**
 * The bot verdict (spec 007 research R5): logit = prior[level] + Σ weight[code], P = 1/(1+e^-logit).
 * Each code counts once; its weight is its contribution, so the verdict stays explainable.
 */

export type BotVerdict = {
  score: number;
  logit: number;
  prior: PriorKey;
  reasons: { code: ReasonCode; weight: number }[];
  weightsVersion: string;
};

export function scoreVerdict(level: Level | null, codes: Iterable<ReasonCode>, weights: Weights): BotVerdict {
  const prior: PriorKey = level ?? "none";
  const reasons = [...new Set(codes)].sort().map((code) => ({ code, weight: weights.weights[code] ?? 0 }));
  const logit = weights.priors[prior] + reasons.reduce((sum, r) => sum + r.weight, 0);
  const score = Number.isFinite(logit) ? 1 / (1 + Math.exp(-logit)) : logit > 0 ? 1 : 0;
  return { score, logit, prior, reasons, weightsVersion: weights.version };
}

/** `code:+w` list for the operator log, strongest first. */
export function formatReasons(verdict: BotVerdict): string {
  return [...verdict.reasons]
    .sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code))
    .map((r) => `${r.code}:${r.weight >= 0 ? "+" : ""}${r.weight.toFixed(1)}`)
    .join(",");
}
