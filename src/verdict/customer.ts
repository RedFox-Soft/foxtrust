import type { Level, Network, Reason, ScoringConfig, Signal } from "../model/types";
import { score } from "../scoring/score";

/** A reason as customers see it: what the address was seen doing, not who reported it. */
export type CustomerReason = { code: string; lastSeen: string; contribution: number };

/** The customer-facing verdict view (constitution v3.0.0, Principle II; spec 002 FR-001–FR-003). */
export type CustomerVerdict = {
  risk: number;
  level: Level;
  categories: string[];
  reasons: CustomerReason[];
  network: Network;
};

export function stripToCustomer(reason: Reason): CustomerReason {
  return { code: reason.code, lastSeen: reason.lastSeen, contribution: reason.contribution };
}

/**
 * Scores only shippable signals, so a local-only signal cannot change any customer-facing
 * risk, level, category or reason (FR-002). Sources and prefixes are dropped (FR-003).
 */
export function customerVerdict(
  signals: Signal[],
  network: Network,
  config: ScoringConfig,
  at: Date,
  now: Date = at,
): CustomerVerdict {
  const shippable = signals.filter((s) => s.shippable);
  const result = score(shippable, config, at, now);
  return {
    risk: result.risk,
    level: result.level,
    categories: result.categories,
    reasons: result.reasons.map(stripToCustomer),
    network,
  };
}
