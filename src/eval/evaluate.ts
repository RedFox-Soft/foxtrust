import type { SQL } from "bun";
import { readSnapshot, type Db } from "../db/client";
import { resolveVersionAt } from "../db/versions";
import { toIpValue } from "../ip/parse";
import { gatherSignals } from "../lookup/signals";
import type { ScoringConfig } from "../model/types";
import { score } from "../scoring/score";
import type { KnownGood, ReferenceVersion } from "./known-good";
import {
  compareFn,
  compareFp,
  fnLevelRates,
  fpLevelRates,
  type ByLevel,
  type Changed,
  type FnRates,
  type FpRates,
  type Scored,
} from "./metrics";
import { feedContribution, type FeedContribution } from "./contribution";
import { drawSample, type SampledAddress, type SampleSummary } from "./sample";
import { assertMeasurable, EarlyDetectionRefused, findNewAddresses, internalEarlyDetection, type EarlyDetectionByFeed } from "./early-detection";

export type SampledResult = SampledAddress & Scored;

export type ConfigReport = {
  configVersion: string;
  falsePositives: ByLevel<FpRates>;
  knownBad: { rates: ByLevel<FnRates>; byFeed: Record<string, ByLevel<FnRates>> };
  /** Internal early detection at `at − window`, absent when the moment was refused. */
  earlyDetection?: EarlyDetectionByFeed;
  /** Per-feed contribution, with `contribution` set (US4). */
  contribution?: FeedContribution[];
  goodResults: Scored[];
  badResults: SampledResult[];
};

export type EvaluationReport = {
  dataVersion: string;
  at: string;
  reference: ReferenceVersion;
  sample: SampleSummary;
  /** Set when early detection could not be measured (FR-013); the other sections are still filled. */
  earlyDetectionRefused?: { reason: string; validMoment: string };
  configs: ConfigReport[];
  comparison?: {
    falsePositives: { deltas: ByLevel<{ fpRate: number }>; changed: Changed[] };
    knownBad: { deltas: ByLevel<{ fnRate: number }>; changed: Changed[] };
  };
};

export type EvaluateOptions = {
  knownGood: KnownGood;
  at?: Date;
  configs?: ScoringConfig[];
  windowDays?: number;
  perFeed?: number;
  /** Entries per feed for the contribution section; the section is skipped when absent. */
  contribution?: { perFeed: number };
  now?: Date;
};

/** Scores one address at `at` for every config, leaving out `exclude` sources. */
async function scoreAll(tx: SQL, ip: string, at: Date, configs: ScoringConfig[], now: Date, exclude: string[]): Promise<Scored[]> {
  const value = toIpValue(ip);
  if ("error" in value) throw new Error(`address ${ip}: ${value.error}`);
  const { signals } = await gatherSignals(tx, value, at, exclude);
  return configs.map((config) => {
    const result = score(signals, config, at, now);
    return { ip, level: result.level, risk: result.risk };
  });
}

/**
 * Accuracy evaluation (spec 003): false positives on the known-good reference, and false negatives
 * on a fresh known-bad sample, each sampled address scored without the feed it came from. Every
 * section reads one consistent snapshot; with two configs both use the same sample.
 */
export async function evaluate(sql: Db, opts: EvaluateOptions): Promise<EvaluationReport> {
  const at = opts.at ?? new Date();
  const now = opts.now ?? new Date();
  return readSnapshot(sql, async (tx) => {
    const version = await resolveVersionAt(tx, at);
    if (!version) throw new Error(`no data version exists at or before ${at.toISOString()}`);
    const configs = opts.configs && opts.configs.length > 0 ? opts.configs : [version.config];

    const windowDays = opts.windowDays ?? 7;
    const good: Scored[][] = configs.map(() => []);
    for (const entry of opts.knownGood.entries) {
      (await scoreAll(tx, entry.ip, at, configs, now, [])).forEach((r, i) => good[i]!.push(r));
    }

    const { addresses, summary } = await drawSample(tx, {
      at,
      windowDays,
      perFeed: opts.perFeed ?? 100,
      dataVersionLabel: version.label,
      knownGood: opts.knownGood.entries,
    });
    const bad: SampledResult[][] = configs.map(() => []);
    for (const address of addresses) {
      (await scoreAll(tx, address.ip, at, configs, now, [address.feed])).forEach((r, i) => bad[i]!.push({ ...address, ...r }));
    }

    // Early detection: addresses first reported in the window that ends at `at` (research R4).
    const moment = new Date(at.getTime() - windowDays * 86_400_000);
    let early: EarlyDetectionByFeed[] | null = null;
    let refused: { reason: string; validMoment: string } | null = null;
    try {
      assertMeasurable(moment, windowDays, now, version.config.retention.rawDays);
      const found = await findNewAddresses(tx, { moment, windowDays });
      early = [];
      for (const config of configs) early.push(await internalEarlyDetection(tx, found, { moment, windowDays, config, now }));
    } catch (error) {
      if (!(error instanceof EarlyDetectionRefused)) throw error;
      refused = { reason: error.message, validMoment: error.validMoment.toISOString() };
    }

    const contribution = opts.contribution
      ? await feedContribution(tx, { at, windowDays, perFeed: opts.contribution.perFeed, dataVersionLabel: version.label, configs, now })
      : null;

    const byFeed = (results: SampledResult[]) => {
      const out: Record<string, ByLevel<FnRates>> = {};
      for (const feed of Object.keys(summary.byFeed)) {
        const rows = results.filter((r) => r.feed === feed);
        if (rows.length > 0) out[feed] = fnLevelRates(rows);
      }
      return out;
    };

    const report: EvaluationReport = {
      dataVersion: version.label,
      at: at.toISOString(),
      reference: opts.knownGood.reference,
      sample: summary,
      ...(refused ? { earlyDetectionRefused: refused } : {}),
      configs: configs.map((config, i) => ({
        configVersion: config.version,
        falsePositives: fpLevelRates(good[i]!),
        knownBad: { rates: fnLevelRates(bad[i]!), byFeed: byFeed(bad[i]!) },
        ...(early ? { earlyDetection: early[i]! } : {}),
        ...(contribution ? { contribution: contribution[i]! } : {}),
        goodResults: good[i]!,
        badResults: bad[i]!,
      })),
    };
    if (configs.length === 2) {
      // A prefix sampled from two feeds appears twice; key the comparison by feed and address.
      const keyed = (rows: SampledResult[]) => rows.map((r) => ({ ...r, ip: `${r.feed}:${r.ip}` }));
      report.comparison = {
        falsePositives: compareFp(good[0]!, good[1]!),
        knownBad: compareFn(keyed(bad[0]!), keyed(bad[1]!)),
      };
    }
    return report;
  });
}
