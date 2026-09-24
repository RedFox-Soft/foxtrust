export type SignalKind = "category" | "behavior";

/**
 * A fact about an address, as the scorer sees it. Weight and half-life come from the scoring
 * configuration (per code); confidence comes from the feed when it has one, otherwise from the
 * configuration (per source).
 */
export type Signal = {
  kind: SignalKind;
  code: string;
  source: string;
  /** The matched prefix in CIDR notation. */
  prefix: string;
  /** Prefix length, used to pick the most specific prefix on a tie. */
  prefixLength: number;
  firstSeen: Date;
  lastSeen: Date;
  /** Feed-provided confidence (0–1), or null to use `sourceConfidence`. */
  confidence: number | null;
  shippable: boolean;
};

export type Level = "low" | "medium" | "high";

export type Reason = {
  code: string;
  kind: SignalKind;
  source: string;
  prefix: string;
  firstSeen: string;
  lastSeen: string;
  contribution: number;
  shippable: boolean;
};

export type Network = {
  asn: number | null;
  org: string | null;
  prefix: string | null;
  country: string | null;
};

export type Verdict = {
  ip: string;
  risk: number;
  level: Level;
  categories: string[];
  reasons: Reason[];
  network: Network;
  dataVersion: string;
  evaluatedAt: string;
  behaviorHistoryIncomplete: boolean;
};

export type CategoryCode = {
  kind: "category";
  category: string;
  weight: number;
  description: string;
};

export type BehaviorCode = {
  kind: "behavior";
  weight: number;
  halfLifeHours: number;
  description: string;
};

export type ScoringConfig = {
  version: string;
  algorithm: "noisy-or/1";
  levels: { medium: number; high: number };
  categoryOnlyMaxRisk: number;
  retention: { rawDays: number; aggregateDays: number };
  codes: Record<string, CategoryCode | BehaviorCode>;
  sourceConfidence: Record<string, number>;
};

export type LookupOptions = {
  /** Evaluation time. Default: now. */
  at?: Date;
  /** Feed ids whose signals are ignored (leave-one-source-out evaluation). */
  excludeSources?: string[];
};

export type LookupError =
  | { code: "invalid_ip"; message: string; input: string }
  | { code: "unknown_source"; message: string; source: string }
  | { code: "no_data"; message: string; at: string };

export type LookupResult = { ok: true; verdict: Verdict } | { ok: false; error: LookupError };
