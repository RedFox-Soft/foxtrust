import { join } from "node:path";
import type { Db } from "../db/client";
import { DEFAULT_LABELS, loadLabels, type LabelledAddress } from "../eval/labels";
import { compare, levelRates, sourceCounts, type LabelResult, type LevelRates } from "../eval/metrics";
import { toIpValue, type IpValue } from "../ip/parse";
import type { Level } from "../model/types";
import { openMmdb, overlay } from "../mmdb/reader";
import type { MmdbValue } from "../mmdb/writer";
import { configSha256 } from "../scoring/config";
import type { Build } from "./build";

/**
 * Release report and regression gate (research R11, constitution Principle VI). The labelled
 * set is looked up in the file customers get (base + delta for a delta), and compared with the
 * previous release of the same kind; the first delta of a day is compared with its full snapshot.
 */

/** A regression: FP at `high` up by more than 0.5 pp, or FN at `medium`/`high` up by more than 2 pp. */
export const MAX_FP_INCREASE_HIGH = 0.005;
export const MAX_FN_INCREASE = 0.02;

export type ReleaseReport = {
  version: string;
  kind: "full" | "delta";
  base: string | null;
  builtAt: string;
  dataVersion: string;
  algorithm: string;
  configSha256: string;
  method: string;
  labels: { file: string; count: number; sources: Record<string, number> };
  rates: LevelRates;
  previous: { version: string; rates: LevelRates } | null;
  deltas: Record<"medium" | "high", { fpRate: number; fnRate: number }> | null;
  changed: { ip: string; label: "good" | "bad"; from: Level; to: Level; riskFrom: number; riskTo: number }[];
  regressions: string[];
  releaseNote: string | null;
};

type Get = (ip: IpValue) => MmdbValue | null;

function results(get: Get, labels: LabelledAddress[]): LabelResult[] {
  return labels.map((label) => {
    const ip = toIpValue(label.ip);
    if ("error" in ip) throw new Error(`labelled address ${label.ip}: ${ip.error}`);
    const record = get(ip) as { level?: MmdbValue; risk?: MmdbValue } | null;
    const level = (typeof record?.level === "string" ? record.level : "low") as Level;
    return { ip: label.ip, label: label.label, labelSource: label.labelSource, level, risk: Number(record?.risk ?? 0) };
  });
}

const pp = (x: number) => `${(x * 100).toFixed(1)} pp`;

/** The release a build is compared with, as a lookup, or null for the very first release. */
async function previousRelease(sql: Db, dir: string, build: Build): Promise<{ version: string; get: Get } | null> {
  const read = async (path: string) => openMmdb(new Uint8Array(await Bun.file(join(dir, path)).arrayBuffer()));
  const [full] = await sql`
    SELECT version, file_path FROM snapshot_release
    WHERE kind = 'full' AND status = 'published' AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1`;
  if (build.kind === "full") return full ? { version: full.version, get: (await read(full.file_path)).get } : null;

  const base = full && full.version === build.base ? await read(full.file_path) : null;
  if (!base) return null;
  const [delta] = await sql`
    SELECT version, file_path FROM snapshot_release
    WHERE kind = 'delta' AND status = 'published' AND valid_to IS NULL AND base_version = ${build.base}
    ORDER BY valid_from DESC LIMIT 1`;
  if (!delta) return { version: full.version, get: base.get };
  return { version: delta.version, get: overlay(base, await read(delta.file_path)) };
}

export async function releaseReport(
  sql: Db,
  build: Build,
  opts: { dir: string; baseBytes?: Uint8Array | undefined; labelsFile?: string },
): Promise<ReleaseReport> {
  const labelsFile = opts.labelsFile ?? DEFAULT_LABELS;
  const labels = await loadLabels(labelsFile);
  const file = openMmdb(build.bytes);
  const get: Get = build.kind === "delta" ? overlay(openMmdb(opts.baseBytes!), file) : file.get;
  const current = results(get, labels);
  const prev = await previousRelease(sql, opts.dir, build);
  const prevResults = prev ? results(prev.get, labels) : null;
  const comparison = prevResults ? compare(prevResults, current) : null;

  const regressions: string[] = [];
  if (comparison) {
    const { medium, high } = comparison.deltas;
    if (high.fpRate > MAX_FP_INCREASE_HIGH) regressions.push(`FP rate at high rose by ${pp(high.fpRate)} (limit ${pp(MAX_FP_INCREASE_HIGH)})`);
    if (medium.fnRate > MAX_FN_INCREASE) regressions.push(`FN rate at medium rose by ${pp(medium.fnRate)} (limit ${pp(MAX_FN_INCREASE)})`);
    if (high.fnRate > MAX_FN_INCREASE) regressions.push(`FN rate at high rose by ${pp(high.fnRate)} (limit ${pp(MAX_FN_INCREASE)})`);
  }
  const config = build.dataVersion.config;
  return {
    version: build.version,
    kind: build.kind,
    base: build.base,
    builtAt: build.builtAt.toISOString(),
    dataVersion: build.dataVersion.label,
    algorithm: config.algorithm,
    configSha256: configSha256(config),
    method:
      "Each labelled address is looked up in the published customer view (base + delta for a delta). " +
      "Unlike `foxtrust eval`, a label's own feed is not left out, so rates are for comparing releases, not absolute accuracy.",
    labels: { file: labelsFile.replaceAll("\\", "/").split("/").slice(-3).join("/"), count: labels.length, sources: sourceCounts(labels) },
    rates: levelRates(current),
    previous: prev && prevResults ? { version: prev.version, rates: levelRates(prevResults) } : null,
    deltas: comparison?.deltas ?? null,
    changed: comparison?.changed ?? [],
    regressions,
    releaseNote: null,
  };
}
