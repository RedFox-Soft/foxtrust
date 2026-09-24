import type { Level, Reason, ScoringConfig, Signal } from "../model/types";
import { relevanceHorizonHours, retentionHorizonHours } from "./config";
import { decay } from "./decay";

export type ScoreResult = {
  risk: number;
  level: Level;
  categories: string[];
  reasons: Reason[];
  behaviorHistoryIncomplete: boolean;
};

const HOUR_MS = 3_600_000;
const MAX_TERM = 1 - 1e-9; // keeps ln(1 − p) finite (research R4)

type Term = { signal: Signal; lastSeen: Date; firstSeen: Date; p: number };

/** One signal per (code, source): latest lastSeen, most specific prefix on a tie, earliest firstSeen. */
function dedupe(signals: Signal[]): Signal[] {
  const byKey = new Map<string, Signal>();
  for (const s of signals) {
    const key = `${s.code}\u0000${s.source}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, s);
      continue;
    }
    const firstSeen = s.firstSeen < prev.firstSeen ? s.firstSeen : prev.firstSeen;
    const newer =
      s.lastSeen > prev.lastSeen || (s.lastSeen.getTime() === prev.lastSeen.getTime() && s.prefixLength > prev.prefixLength);
    byKey.set(key, { ...(newer ? s : prev), firstSeen });
  }
  return [...byKey.values()];
}

/** Rounds values to tenths so that they add up exactly to round(total, 0.1) (largest remainder). */
function roundToTotal(values: number[], total: number): number[] {
  const target = Math.round(total * 10);
  const scaled = values.map((v) => v * 10);
  const floors = scaled.map(Math.floor);
  let remainder = target - floors.reduce((a, b) => a + b, 0);
  const order = scaled.map((v, i) => ({ i, frac: v - floors[i]! })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i]! += 1;
    remainder--;
  }
  return floors.map((f) => f / 10);
}

function levelOf(risk: number, config: ScoringConfig): Level {
  if (risk >= config.levels.high) return "high";
  if (risk >= config.levels.medium) return "medium";
  return "low";
}

/**
 * Noisy-OR with a capped category part (research R5) and log-share contributions (research R4).
 * Pure and deterministic: the same signals, config, `at` and `now` give the same result.
 * `now` only matters for `behaviorHistoryIncomplete`.
 */
export function score(signals: Signal[], config: ScoringConfig, at: Date, now: Date = new Date()): ScoreResult {
  const terms: Term[] = dedupe(signals).map((signal) => {
    const def = config.codes[signal.code];
    if (!def) throw new Error(`signal code "${signal.code}" is not in scoring config ${config.version}`);
    if (def.kind !== signal.kind) throw new Error(`signal code "${signal.code}" is a ${def.kind} code, not ${signal.kind}`);
    const confidence = signal.confidence ?? config.sourceConfidence[signal.source];
    if (confidence === undefined) {
      throw new Error(`source "${signal.source}" has no confidence in scoring config ${config.version}`);
    }
    const lastSeen = signal.lastSeen > at ? at : signal.lastSeen;
    const firstSeen = signal.firstSeen > lastSeen ? lastSeen : signal.firstSeen;
    const d = def.kind === "behavior" ? decay(lastSeen, at, def.halfLifeHours) : 1;
    const p = Math.min(Math.max(def.weight * confidence * d, 0), MAX_TERM);
    return { signal, lastSeen, firstSeen, p };
  });

  const category = terms.filter((t) => t.signal.kind === "category");
  const behavior = terms.filter((t) => t.signal.kind === "behavior");
  const noisyOr = (ts: Term[]) => 1 - ts.reduce((acc, t) => acc * (1 - t.p), 1);

  const catPart = Math.min(noisyOr(category), config.categoryOnlyMaxRisk / 100);
  const behPart = noisyOr(behavior);
  const riskRaw = 100 * (1 - (1 - catPart) * (1 - behPart));

  // Log-share: −ln(1 − risk) = −ln(1 − cat) + Σ −ln(1 − pⱼ). The capped category part is one
  // term, split among category signals by their own log-shares.
  const logOf = (p: number) => -Math.log1p(-p);
  const catLog = logOf(catPart);
  const catInner = category.reduce((a, t) => a + logOf(t.p), 0);
  const totalLog = catLog + behavior.reduce((a, t) => a + logOf(t.p), 0);
  const shares = terms.map((t) => {
    if (totalLog === 0) return 0;
    if (t.signal.kind === "behavior") return logOf(t.p) / totalLog;
    return catInner === 0 ? 0 : (catLog / totalLog) * (logOf(t.p) / catInner);
  });

  const rawContributions = shares.map((s) => s * riskRaw);
  const risk = Math.round(riskRaw * 10) / 10;

  const unrounded: Reason[] = terms.map((t, i) => ({
    code: t.signal.code,
    kind: t.signal.kind,
    source: t.signal.source,
    prefix: t.signal.prefix,
    firstSeen: t.firstSeen.toISOString(),
    lastSeen: t.lastSeen.toISOString(),
    contribution: rawContributions[i]!,
    shippable: t.signal.shippable,
  }));
  unrounded.sort((a, b) => b.contribution - a.contribution || a.code.localeCompare(b.code) || a.source.localeCompare(b.source));
  const rounded = roundToTotal(
    unrounded.map((r) => r.contribution),
    riskRaw,
  );
  const reasons = unrounded.map((r, i) => ({ ...r, contribution: rounded[i]! }));
  reasons.sort((a, b) => b.contribution - a.contribution || a.code.localeCompare(b.code) || a.source.localeCompare(b.source));

  const categories = [
    ...new Set(
      category.map((t) => {
        const def = config.codes[t.signal.code]!;
        return def.kind === "category" ? def.category : t.signal.code;
      }),
    ),
  ].sort();

  const behaviorHistoryIncomplete =
    at.getTime() - relevanceHorizonHours(config) * HOUR_MS < now.getTime() - retentionHorizonHours(config) * HOUR_MS;

  return { risk, level: levelOf(risk, config), categories, reasons, behaviorHistoryIncomplete };
}
