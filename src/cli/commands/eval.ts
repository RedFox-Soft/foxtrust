import { openDb } from "../../db/client";
import { evaluate, type EvaluationReport } from "../../eval/evaluate";
import { DEFAULT_KNOWN_GOOD, KnownGoodError, loadKnownGood } from "../../eval/known-good";
import type { ScoringConfig } from "../../model/types";
import { ConfigError, loadConfig } from "../../scoring/config";
import {
  EXIT,
  parseDate,
  printJson,
  printLine,
  printTable,
  rejectUnknown,
  takeFlag,
  takeOption,
  UsageError,
  warn,
  type Context,
} from "../util";

const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

async function readConfigFile(path: string): Promise<ScoringConfig> {
  try {
    return await loadConfig(path);
  } catch (error) {
    if (error instanceof ConfigError) throw new UsageError(`${path}: ${error.message}`);
    throw new UsageError(`cannot read ${path}: ${(error as Error).message}`);
  }
}

function positiveInt(text: string | undefined, name: string, fallback: number): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${name} must be a positive integer`);
  return n;
}

function printReport(report: EvaluationReport): void {
  printLine(`data version ${report.dataVersion}, evaluated at ${report.at}`);
  printLine();
  printLine(`False positives: known-good reference ${report.reference.file} (${report.reference.count} addresses, sha256 ${report.reference.sha256.slice(0, 12)}…)`);
  printTable(
    ["config", "level", "FP", "FP rate", "known-good"],
    report.configs.flatMap((c) =>
      (["medium", "high"] as const).map((level) => {
        const r = c.falsePositives[level];
        return [c.configVersion, level, r.falsePositives, pct(r.fpRate), r.goodTotal];
      }),
    ),
  );
  printLine();
  const s = report.sample;
  printLine(`Known-bad sample: last ${s.windowDays} days, up to ${s.perFeed} per behavior feed, each scored without its own feed`);
  printTable(
    ["feed", "sampled"],
    Object.entries(s.byFeed).map(([feed, b]) => [feed, b.noSample ? "no sample" : b.size]),
  );
  printTable(
    ["config", "feed", "level", "FN", "FN rate", "sampled"],
    report.configs.flatMap((c) =>
      [["all", c.knownBad.rates] as const, ...Object.entries(c.knownBad.byFeed)].flatMap(([feed, rates]) =>
        (["medium", "high"] as const).map((level) => {
          const r = rates[level];
          return [c.configVersion, feed, level, r.falseNegatives, pct(r.fnRate), r.badTotal];
        }),
      ),
    ),
  );
  if (s.conflicts.length > 0) {
    printLine(`Left out: ${s.conflicts.map((c) => `${c.prefix} (${c.feed}) covers known-good ${c.knownGood.join(", ")}`).join("; ")}`);
  }
  printLine();
  if (report.earlyDetectionRefused) printLine(`Early detection: not measured. ${report.earlyDetectionRefused.reason}`);
  else {
    const first = report.configs[0]!.earlyDetection!;
    printLine(`Early detection: addresses first reported in the ${first.windowDays} days after ${first.moment}, rated at that moment`);
    printTable(
      ["config", "feed", "found", "medium+", "share", "high", "share"],
      report.configs.flatMap((c) => {
        const e = c.earlyDetection!;
        const rows = [["all", e] as const, ...Object.entries(e.byFeed)];
        return rows.map(([feed, r]) => [c.configVersion, feed, r.found, r.medium.count, pct(r.medium.share), r.high.count, pct(r.high.share)]);
      }),
    );
  }
  if (report.configs[0]!.contribution) {
    printLine();
    printLine("Feed contribution: sampled active entries scored with and without the feed");
    printTable(
      ["config", "feed", "kind", "active", "sampled", "keep medium+", "keep high", "drop below medium"],
      report.configs.flatMap((c) =>
        c.contribution!.map((r) => [c.configVersion, r.feed, r.kind, r.active, r.sampled, r.keepMedium, r.keepHigh, r.dropBelowMedium]),
      ),
    );
  }
  if (report.comparison) {
    const fp = report.comparison.falsePositives;
    const fn = report.comparison.knownBad;
    printLine();
    printLine(`Δ FP rate: medium ${pct(fp.deltas.medium.fpRate)}, high ${pct(fp.deltas.high.fpRate)}`);
    printLine(`Δ FN rate: medium ${pct(fn.deltas.medium.fnRate)}, high ${pct(fn.deltas.high.fnRate)}`);
    const changed = [...fp.changed.map((c) => ["known-good", c] as const), ...fn.changed.map((c) => ["sample", c] as const)];
    printLine();
    if (changed.length === 0) printLine("No address changed level.");
    else printTable(["set", "address", "from", "to", "risk from", "risk to"], changed.map(([set, c]) => [set, c.ip, c.from, c.to, c.riskFrom, c.riskTo]));
  }
}

/** Drops per-address results unless `--results` is given. */
function withoutResults(report: EvaluationReport): unknown {
  return { ...report, configs: report.configs.map(({ goodResults: _g, badResults: _b, ...c }) => c) };
}

export async function evalCommand(args: string[], ctx: Context): Promise<number> {
  const [knownGoodPath = DEFAULT_KNOWN_GOOD] = takeOption(args, "--known-good");
  const configPaths = takeOption(args, "--config");
  const [atText] = takeOption(args, "--at");
  const [windowText] = takeOption(args, "--window");
  const [sampleText] = takeOption(args, "--sample");
  const [contributionSampleText] = takeOption(args, "--contribution-sample");
  const comparing = takeFlag(args, "--compare");
  const withContribution = takeFlag(args, "--contribution");
  const withResults = takeFlag(args, "--results");
  rejectUnknown(args);

  let files = configPaths;
  if (comparing) {
    if (args.length !== 2) throw new UsageError("--compare needs two config files");
    files = args.splice(0, 2);
  } else if (args.length > 0) {
    throw new UsageError(`unexpected argument ${args[0]}`);
  }
  if (files.length > 2) throw new UsageError("at most two configs can be evaluated");
  const windowDays = positiveInt(windowText, "--window", 7);
  const perFeed = positiveInt(sampleText, "--sample", 100);
  if (contributionSampleText !== undefined && !withContribution) throw new UsageError("--contribution-sample needs --contribution");
  const contributionPerFeed = positiveInt(contributionSampleText, "--contribution-sample", 1000);
  const configs = await Promise.all(files.map(readConfigFile));
  let knownGood;
  try {
    knownGood = await loadKnownGood(knownGoodPath);
  } catch (error) {
    if (error instanceof KnownGoodError) throw new UsageError(error.message);
    throw error;
  }

  const sql = openDb();
  try {
    const report = await evaluate(sql, {
      knownGood,
      configs,
      windowDays,
      perFeed,
      ...(withContribution ? { contribution: { perFeed: contributionPerFeed } } : {}),
      ...(atText ? { at: parseDate(atText, "--at") } : {}),
    });
    if (ctx.json) printJson(withResults ? report : withoutResults(report));
    else printReport(report);
    if (report.earlyDetectionRefused) {
      warn(report.earlyDetectionRefused.reason);
      return EXIT.problems;
    }
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}
