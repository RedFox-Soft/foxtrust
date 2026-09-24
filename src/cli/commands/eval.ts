import { openDb } from "../../db/client";
import { DEFAULT_LABELS, LabelError, loadLabels } from "../../eval/labels";
import { evaluate, type EvaluationReport } from "../../eval/evaluate";
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

function printReport(report: EvaluationReport): void {
  printLine(`data version ${report.dataVersion}, evaluated at ${report.at}`);
  printLine();
  printTable(
    ["config", "level", "FP", "FP rate", "FN", "FN rate", "good", "bad"],
    report.configs.flatMap((c) =>
      (["medium", "high"] as const).map((level) => {
        const r = c.rates[level];
        return [c.configVersion, level, r.falsePositives, pct(r.fpRate), r.falseNegatives, pct(r.fnRate), r.goodTotal, r.badTotal];
      }),
    ),
  );
  printLine();
  printTable(["label source", "addresses"], Object.entries(report.labelSources));
  if (report.comparison) {
    const d = report.comparison.deltas;
    printLine();
    printLine(`Δ FP rate: medium ${pct(d.medium.fpRate)}, high ${pct(d.high.fpRate)}`);
    printLine(`Δ FN rate: medium ${pct(d.medium.fnRate)}, high ${pct(d.high.fnRate)}`);
    printLine();
    if (report.comparison.changed.length === 0) printLine("No address changed level.");
    else {
      printTable(
        ["ip", "label", "from", "to", "risk from", "risk to"],
        report.comparison.changed.map((c) => [c.ip, c.label, c.from, c.to, c.riskFrom, c.riskTo]),
      );
    }
  }
}

export async function evalCommand(args: string[], ctx: Context): Promise<number> {
  const [labelsPath = DEFAULT_LABELS] = takeOption(args, "--labels");
  const configPaths = takeOption(args, "--config");
  const [atText] = takeOption(args, "--at");
  const comparing = takeFlag(args, "--compare");
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
  const configs = await Promise.all(files.map(readConfigFile));
  let labels;
  try {
    labels = await loadLabels(labelsPath);
  } catch (error) {
    if (error instanceof LabelError) throw new UsageError(`${labelsPath}: ${error.message}`);
    throw error;
  }

  const sql = openDb();
  try {
    const report = await evaluate(sql, {
      labels,
      configs,
      ...(atText ? { at: parseDate(atText, "--at") } : {}),
    });
    if (ctx.json) {
      printJson(withResults ? report : { ...report, configs: report.configs.map(({ results: _r, ...c }) => c) });
    } else {
      printReport(report);
    }
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}
