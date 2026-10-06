import type { BotVerdict } from "./verdict";

/**
 * Challenge policy over the bot verdict (spec 007 research R7, data-model decision diagram).
 * Observe mode decides what enforcement would do but always passes.
 */

export type BotMode = "observe" | "enforce" | "off";
export type BotAction = "pass" | "stepup" | "block";

export type BotPolicy = {
  mode: BotMode;
  stepUp: number;
  block: number;
  afterStepUp: "pass" | "block";
  stepUpBits: number;
};

export const DEFAULT_BOT_POLICY: BotPolicy = { mode: "observe", stepUp: 0.5, block: 0.9, afterStepUp: "pass", stepUpBits: 4 };

export function decideAction(verdict: BotVerdict, policy: BotPolicy, wasStepUp: boolean): { action: BotAction; would: BotAction } {
  let would: BotAction;
  if (verdict.score >= policy.block) would = "block";
  else if (verdict.score >= policy.stepUp) would = wasStepUp ? policy.afterStepUp : "stepup";
  else would = "pass";
  return { action: policy.mode === "enforce" ? would : "pass", would };
}
