import { readSnapshot, type Db } from "../db/client";
import { resolveVersionAt } from "../db/versions";
import { toIpValue } from "../ip/parse";
import { gatherSignals } from "../lookup/signals";
import type { ScoringConfig } from "../model/types";
import { score } from "../scoring/score";
import { feedSourceOf, type LabelledAddress } from "./labels";
import { compare, levelRates, sourceCounts, type Comparison, type LabelResult, type LevelRates } from "./metrics";

export type ConfigReport = { configVersion: string; rates: LevelRates; results: LabelResult[] };

export type EvaluationReport = {
  dataVersion: string;
  at: string;
  labelSources: Record<string, number>;
  configs: ConfigReport[];
  comparison?: Comparison;
};

/**
 * Scores every labelled address from one consistent snapshot. When a label came from an
 * ingested feed, that feed's signals are left out for that address (FR-025a).
 * With two configs, the report also compares them (US3-2).
 */
export async function evaluate(
  sql: Db,
  opts: { labels: LabelledAddress[]; at?: Date; configs?: ScoringConfig[]; now?: Date },
): Promise<EvaluationReport> {
  const at = opts.at ?? new Date();
  const now = opts.now ?? new Date();
  return readSnapshot(sql, async (tx) => {
    const version = await resolveVersionAt(tx, at);
    if (!version) throw new Error(`no data version exists at or before ${at.toISOString()}`);
    const configs = opts.configs && opts.configs.length > 0 ? opts.configs : [version.config];

    const perConfig: LabelResult[][] = configs.map(() => []);
    for (const label of opts.labels) {
      const ip = toIpValue(label.ip);
      if ("error" in ip) throw new Error(`labelled address ${label.ip}: ${ip.error}`);
      const exclude = feedSourceOf(label);
      const { signals } = await gatherSignals(tx, ip, at, exclude ? [exclude] : []);
      configs.forEach((config, i) => {
        const result = score(signals, config, at, now);
        perConfig[i]!.push({ ip: label.ip, label: label.label, labelSource: label.labelSource, level: result.level, risk: result.risk });
      });
    }

    const report: EvaluationReport = {
      dataVersion: version.label,
      at: at.toISOString(),
      labelSources: sourceCounts(opts.labels),
      configs: configs.map((config, i) => ({ configVersion: config.version, rates: levelRates(perConfig[i]!), results: perConfig[i]! })),
    };
    if (configs.length === 2) report.comparison = compare(perConfig[0]!, perConfig[1]!);
    return report;
  });
}
