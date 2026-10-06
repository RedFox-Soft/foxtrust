import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Level } from "../model/types";
import { behaviorCodes } from "../verify/bot/behavior";
import { checkBehavior } from "../verify/bot/behavior-schema";
import { collectEvidence } from "../verify/bot/evidence";
import { JA4_FAMILIES_FILE, loadJa4Families } from "../verify/bot/ja4";
import { decideAction, type BotAction, type BotPolicy } from "../verify/bot/policy";
import { checkProbe } from "../verify/bot/probe-schema";
import { scoreVerdict } from "../verify/bot/verdict";
import { loadWeights, type Weights } from "../verify/bot/weights";
import { loadZones, type Zones } from "../verify/bot/zones";

/**
 * Evaluation of bot-verdict weights on the labelled set (spec 007 research R8, contracts `bot eval`).
 * A measurement, not a test: it reports SC-001/SC-002 for a weights version and compares two.
 * Hold samples (spec 009 research R6) also get a behavior-only verdict: the sample's behavior codes
 * on a clean environment, which is what a stealth browser driving the same input would score.
 */

export type Sample = {
  label: string;
  kind: "human" | "automation";
  addressKind: "residential" | "tor" | "cloud";
  country?: string;
  headers: Record<string, string>;
  probe: unknown;
  /** The hold-step payload, for samples recorded with `bot record --hold`. */
  behavior?: unknown;
};

export type LabelResult = {
  label: string; kind: "human" | "automation"; samples: number; pass: number; stepup: number; block: number; meanScore: number;
  /** Hold labels: passes on the behavior-only verdict; null for samples without a hold. */
  behaviorPass: number | null;
};

export type EvalResult = {
  weightsVersion: string;
  labels: LabelResult[];
  /** Step-up or block on the first attempt, among human samples; null without human samples. */
  humanFalsePositiveRate: number | null;
  torFalsePositiveRate: number | null;
  /** SC-001: no stock headless Playwright or Puppeteer sample passes; null without such samples. */
  sc001: boolean | null;
  /** SC-002: mainstream human ≥ 99 % and Tor Browser ≥ 95 % pass; null without human samples. */
  sc002: boolean | null;
  /** Spec 009 success criteria on the hold labels; each is null without its samples. */
  hold: {
    /** SC-001: ≥ 95 % of scripted pointer holds get no pass on the behavior-only verdict. */
    sc001: boolean | null;
    /** SC-002: ≥ 98 % of human pointer and touch holds pass, and every keyboard hold. */
    sc002: boolean | null;
    /** SC-003: no stealth-automation hold passes, on either verdict. */
    sc003: boolean | null;
  };
};

const LEVEL: Record<Sample["addressKind"], Level> = { tor: "medium", residential: "low", cloud: "low" };
const STOCK_AUTOMATION = /^(playwright-[a-z]+-headless|puppeteer-headless)$/;
/** Camoufox `humanize` is reported as a baseline, not a target (spec 009 research R5). */
const HOLD_BASELINE = "hold-camoufox-humanize";
const HOLD_STEALTH = "hold-stealth-ghost";
const HOLD_KEYBOARD = "hold-keyboard";

export function readSamples(dir: string): Sample[] {
  const samples: Sample[] = [];
  for (const label of readdirSync(dir).sort()) {
    const sub = join(dir, label);
    if (!statSync(sub).isDirectory()) continue;
    for (const file of readdirSync(sub).filter((f) => f.endsWith(".json")).sort()) {
      const value = JSON.parse(readFileSync(join(sub, file), "utf8")) as Sample;
      if (value.label !== label) throw new Error(`${label}/${file}: label ${value.label} differs from its directory`);
      if (value.kind !== "human" && value.kind !== "automation") throw new Error(`${label}/${file}: kind must be human or automation`);
      samples.push(value);
    }
  }
  return samples;
}

function evaluate(
  samples: Sample[], weights: Weights, policy: BotPolicy, zones: Zones, families: Awaited<ReturnType<typeof loadJa4Families>>, withDevice: boolean,
): EvalResult {
  const byLabel = new Map<string, LabelResult & { scoreSum: number }>();
  const enforce: BotPolicy = { ...policy, mode: "enforce" };
  for (const sample of samples) {
    const probe = checkProbe(sample.probe, "*");
    const hold = sample.behavior !== undefined;
    const behavior = hold ? checkBehavior(sample.behavior, "*") : null;
    const h = sample.headers;
    const codes = collectEvidence({
      kind: "pow",
      probe,
      request: {
        userAgent: h["user-agent"] ?? null,
        acceptLanguage: h["accept-language"] ?? null,
        secChUa: h["sec-ch-ua"] ?? null,
        secChUaPlatform: h["sec-ch-ua-platform"] ?? null,
        https: h.proto === "https",
        ja4: h["x-ja4"] ?? null,
      },
      country: sample.country ?? null,
      zones,
      families,
      returningDevice: withDevice,
      behavior,
      holdRequired: hold,
    });
    const verdict = scoreVerdict(LEVEL[sample.addressKind], codes, weights);
    const { action } = decideAction(verdict, enforce, false);
    const row = byLabel.get(sample.label) ??
      { label: sample.label, kind: sample.kind, samples: 0, pass: 0, stepup: 0, block: 0, meanScore: 0, behaviorPass: null, scoreSum: 0 };
    row.samples++;
    row[action satisfies BotAction]++;
    if (hold) {
      const only = new Set(behavior ? behaviorCodes(behavior) : ["behavior.missing" as const]);
      if (withDevice) only.add("attest.returning_device");
      const alone = decideAction(scoreVerdict(LEVEL[sample.addressKind], only, weights), enforce, false);
      row.behaviorPass = (row.behaviorPass ?? 0) + (alone.action === "pass" ? 1 : 0);
    }
    row.scoreSum += verdict.score;
    byLabel.set(sample.label, row);
  }
  const labels = [...byLabel.values()].map(({ scoreSum, ...row }) => ({ ...row, meanScore: Math.round((scoreSum / row.samples) * 100) / 100 }));
  const rate = (rows: LabelResult[]) => {
    const total = rows.reduce((s, r) => s + r.samples, 0);
    return total === 0 ? null : rows.reduce((s, r) => s + r.stepup + r.block, 0) / total;
  };
  const humans = labels.filter((l) => l.kind === "human");
  const tor = humans.filter((l) => l.label.startsWith("tor-browser"));
  const mainstream = humans.filter((l) => !l.label.startsWith("tor-browser"));
  const stock = labels.filter((l) => STOCK_AUTOMATION.test(l.label));
  const mainstreamRate = rate(mainstream);
  const torRate = rate(tor);
  const holds = labels.filter((l) => l.behaviorPass !== null);
  const scripted = holds.filter((l) => l.kind === "automation" && l.label !== HOLD_BASELINE && l.label !== "hold-key-script");
  const people = holds.filter((l) => l.kind === "human");
  const pointerPeople = people.filter((l) => l.label !== HOLD_KEYBOARD);
  const keyboard = people.filter((l) => l.label === HOLD_KEYBOARD);
  const stealth = holds.filter((l) => l.label === HOLD_STEALTH);
  const sum = (rows: LabelResult[], pick: (r: LabelResult) => number) => rows.reduce((s, r) => s + pick(r), 0);
  return {
    weightsVersion: weights.version,
    labels,
    humanFalsePositiveRate: rate(humans),
    torFalsePositiveRate: torRate,
    sc001: stock.length === 0 ? null : stock.every((l) => l.pass === 0),
    sc002: humans.length === 0 ? null : (mainstreamRate ?? 0) <= 0.01 && (torRate ?? 0) <= 0.05,
    hold: {
      sc001: scripted.length === 0 ? null : sum(scripted, (r) => r.behaviorPass ?? 0) <= 0.05 * sum(scripted, (r) => r.samples),
      sc002: people.length === 0 ? null :
        sum(pointerPeople, (r) => r.pass) >= 0.98 * sum(pointerPeople, (r) => r.samples) && keyboard.every((r) => r.pass === r.samples),
      sc003: stealth.length === 0 ? null : stealth.every((r) => r.pass === 0 && r.behaviorPass === 0),
    },
  };
}

export async function evaluateSamples(opts: {
  samplesDir: string;
  weightsFile: string;
  compareFile?: string | undefined;
  policy: BotPolicy;
  ja4FamiliesFile?: string | null | undefined;
  /** Every sample presents a valid returning-device token (spec 008 SC-004). */
  withDevice?: boolean;
}): Promise<{ result: EvalResult; compare: EvalResult | null }> {
  const samples = readSamples(opts.samplesDir);
  const zones = await loadZones();
  const families = await loadJa4Families(opts.ja4FamiliesFile ?? JA4_FAMILIES_FILE);
  const withDevice = opts.withDevice ?? false;
  const result = evaluate(samples, await loadWeights(opts.weightsFile), opts.policy, zones, families, withDevice);
  const compare = opts.compareFile ? evaluate(samples, await loadWeights(opts.compareFile), opts.policy, zones, families, withDevice) : null;
  return { result, compare };
}
