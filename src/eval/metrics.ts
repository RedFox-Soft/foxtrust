import type { Level } from "../model/types";

// Spec 003: false positives on the known-good reference, false negatives on the fresh sample.

export type Scored = { ip: string; level: Level; risk: number };
export type FpRates = { goodTotal: number; falsePositives: number; fpRate: number };
export type FnRates = { badTotal: number; falseNegatives: number; fnRate: number };
export type ByLevel<T> = { medium: T; high: T };
export type Changed = { ip: string; from: Level; to: Level; riskFrom: number; riskTo: number };

const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };
const atLeast = (level: Level, threshold: Level) => RANK[level] >= RANK[threshold];
const ratio = (n: number, total: number) => (total === 0 ? 0 : n / total);

/** FP = known-good addresses at or above `threshold` ÷ known-good addresses. */
export function fpRates(results: Scored[], threshold: "medium" | "high"): FpRates {
  const falsePositives = results.filter((r) => atLeast(r.level, threshold)).length;
  return { goodTotal: results.length, falsePositives, fpRate: ratio(falsePositives, results.length) };
}

/** FN = known-bad addresses below `threshold` ÷ known-bad addresses. */
export function fnRates(results: Scored[], threshold: "medium" | "high"): FnRates {
  const falseNegatives = results.filter((r) => !atLeast(r.level, threshold)).length;
  return { badTotal: results.length, falseNegatives, fnRate: ratio(falseNegatives, results.length) };
}

export const fpLevelRates = (results: Scored[]): ByLevel<FpRates> => ({
  medium: fpRates(results, "medium"),
  high: fpRates(results, "high"),
});

export const fnLevelRates = (results: Scored[]): ByLevel<FnRates> => ({
  medium: fnRates(results, "medium"),
  high: fnRates(results, "high"),
});

/** Addresses of `a` whose level differs in `b` (matched by ip). */
export function changedLevels(a: Scored[], b: Scored[]): Changed[] {
  const byIp = new Map(b.map((r) => [r.ip, r]));
  return a.flatMap((x) => {
    const y = byIp.get(x.ip);
    return y && y.level !== x.level ? [{ ip: x.ip, from: x.level, to: y.level, riskFrom: x.risk, riskTo: y.risk }] : [];
  });
}

/** FP rate deltas (b − a) and the known-good addresses whose level changed. */
export function compareFp(a: Scored[], b: Scored[]): { deltas: ByLevel<{ fpRate: number }>; changed: Changed[] } {
  const ra = fpLevelRates(a);
  const rb = fpLevelRates(b);
  return {
    deltas: { medium: { fpRate: rb.medium.fpRate - ra.medium.fpRate }, high: { fpRate: rb.high.fpRate - ra.high.fpRate } },
    changed: changedLevels(a, b),
  };
}

/** FN rate deltas (b − a) and the sampled addresses whose level changed. */
export function compareFn(a: Scored[], b: Scored[]): { deltas: ByLevel<{ fnRate: number }>; changed: Changed[] } {
  const ra = fnLevelRates(a);
  const rb = fnLevelRates(b);
  return {
    deltas: { medium: { fnRate: rb.medium.fnRate - ra.medium.fnRate }, high: { fnRate: rb.high.fnRate - ra.high.fnRate } },
    changed: changedLevels(a, b),
  };
}

/** Count and share of `results` at or above each level. */
export function levelShares(results: Scored[]): ByLevel<{ count: number; share: number }> {
  const at = (t: Level) => {
    const count = results.filter((r) => atLeast(r.level, t)).length;
    return { count, share: ratio(count, results.length) };
  };
  return { medium: at("medium"), high: at("high") };
}
