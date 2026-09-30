import type { IpValue } from "../ip/parse";
import { evaluate, type Action, type Policy } from "../policy";
import type { CustomerVerdict } from "../verdict/customer";

/**
 * The shared decision entry point (spec 002 FR-021): address + request context → decision.
 * Used by `/verify`; later by the SDK, the public API and the foxauth middleware.
 * No database, no network.
 */

export type DecisionReason = "rule" | "default" | "no-data" | "challenge-pass" | "challenge-fallback";

export type Decision = {
  action: Action;
  rule: string | null;
  reason: DecisionReason;
  verdict: CustomerVerdict | null;
  snapshotVersion: string | null;
};

export type DecisionConfig = {
  failMode: "open" | "closed";
  challengeUrl: string | null;
  challengeFallback: Action;
};

export type VerdictSource = {
  /** Null when no snapshot is loaded at all. */
  snapshotVersion: string | null;
  /** The customer verdict for `ip`, or null when the snapshot has no record ("no data"). */
  lookup(ip: IpValue): CustomerVerdict | null;
};

export function decide(input: {
  source: VerdictSource;
  policy: Policy;
  ip: IpValue;
  path: string;
  method: string;
  /** True when a valid challenge-pass token for this address was presented. */
  passed?: boolean;
  config: DecisionConfig;
  now?: Date;
}): Decision {
  const { source, policy, config } = input;
  if (source.snapshotVersion === null) {
    return {
      action: config.failMode === "open" ? "allow" : "block",
      rule: null,
      reason: "no-data",
      verdict: null,
      snapshotVersion: null,
    };
  }
  const verdict = source.lookup(input.ip);
  const { action, rule } = evaluate(policy, verdict, {
    path: input.path,
    method: input.method,
    ...(input.now ? { now: input.now } : {}),
  });
  const base = { rule, verdict, snapshotVersion: source.snapshotVersion };
  if (action === "challenge") {
    if (input.passed) return { ...base, action: "allow", reason: "challenge-pass" };
    if (!config.challengeUrl) return { ...base, action: config.challengeFallback, reason: "challenge-fallback" };
  }
  return { ...base, action, reason: rule === null ? "default" : "rule" };
}
