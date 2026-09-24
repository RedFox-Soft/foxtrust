import type { Level } from "../model/types";

export type LabelResult = { ip: string; label: "good" | "bad"; labelSource: string; level: Level; risk: number };

export type Rates = {
  goodTotal: number;
  badTotal: number;
  falsePositives: number;
  falseNegatives: number;
  fpRate: number;
  fnRate: number;
};

const RANK: Record<Level, number> = { low: 0, medium: 1, high: 2 };
const atLeast = (level: Level, threshold: Level) => RANK[level] >= RANK[threshold];
const ratio = (n: number, total: number) => (total === 0 ? 0 : n / total);

/** FP = good rows at or above `threshold` ÷ good rows; FN = bad rows below it ÷ bad rows. */
export function rates(results: LabelResult[], threshold: "medium" | "high"): Rates {
  const good = results.filter((r) => r.label === "good");
  const bad = results.filter((r) => r.label === "bad");
  const falsePositives = good.filter((r) => atLeast(r.level, threshold)).length;
  const falseNegatives = bad.filter((r) => !atLeast(r.level, threshold)).length;
  return {
    goodTotal: good.length,
    badTotal: bad.length,
    falsePositives,
    falseNegatives,
    fpRate: ratio(falsePositives, good.length),
    fnRate: ratio(falseNegatives, bad.length),
  };
}

export type LevelRates = { medium: Rates; high: Rates };

export const levelRates = (results: LabelResult[]): LevelRates => ({
  medium: rates(results, "medium"),
  high: rates(results, "high"),
});

export type Comparison = {
  deltas: Record<"medium" | "high", { fpRate: number; fnRate: number }>;
  changed: { ip: string; label: "good" | "bad"; from: Level; to: Level; riskFrom: number; riskTo: number }[];
};

/** Rate deltas (b − a) and every address whose level changed. */
export function compare(a: LabelResult[], b: LabelResult[]): Comparison {
  const ra = levelRates(a);
  const rb = levelRates(b);
  const byIp = new Map(b.map((r) => [r.ip, r]));
  const changed = a.flatMap((x) => {
    const y = byIp.get(x.ip);
    return y && y.level !== x.level
      ? [{ ip: x.ip, label: x.label, from: x.level, to: y.level, riskFrom: x.risk, riskTo: y.risk }]
      : [];
  });
  return {
    deltas: {
      medium: { fpRate: rb.medium.fpRate - ra.medium.fpRate, fnRate: rb.medium.fnRate - ra.medium.fnRate },
      high: { fpRate: rb.high.fpRate - ra.high.fpRate, fnRate: rb.high.fnRate - ra.high.fnRate },
    },
    changed,
  };
}

/** How many addresses each label source contributed (FR-025a). */
export function sourceCounts(results: { labelSource: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of results) out[r.labelSource] = (out[r.labelSource] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => x.localeCompare(y)));
}
