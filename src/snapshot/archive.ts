import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "../db/client";
import type { ScoringConfig } from "../model/types";
import { writeIndexes, type ReleaseOptions } from "./publish";

/** The one-year snapshot archive (spec 002 FR-011, US4). */

/** 365 days plus a 30-day grace period. */
export const ARCHIVE_RETENTION_DAYS = 395;
export const ARCHIVE_RETENTION_SCHEDULE = "15 4 * * *";

export type ArchivedFile = {
  version: string;
  kind: "full" | "delta";
  base: string | null;
  path: string;
  signaturePath: string;
  sha256: string;
  size: number;
  builtAt: string;
  validFrom: string;
  validTo: string | null;
  signingKeyId: string;
  algorithm: string;
  configSha256: string;
  config: ScoringConfig;
  reportPath: string | null;
  releaseNote: string | null;
};

const toFile = (r: Record<string, any>): ArchivedFile => ({
  version: r.version,
  kind: r.kind,
  base: r.base_version,
  path: r.file_path,
  signaturePath: `${r.file_path}.sig`,
  sha256: r.sha256,
  size: Number(r.size_bytes),
  builtAt: new Date(r.built_at).toISOString(),
  validFrom: new Date(r.valid_from).toISOString(),
  validTo: r.valid_to ? new Date(r.valid_to).toISOString() : null,
  signingKeyId: r.signing_key_id,
  algorithm: r.algorithm_version,
  configSha256: r.config_sha256,
  config: (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as ScoringConfig,
  reportPath: r.report_path,
  releaseNote: r.release_note,
});

/** The full snapshot and the delta that clients were served at `time` (US4-1). */
export async function snapshotAt(sql: Db, time: Date): Promise<{ full: ArchivedFile; delta: ArchivedFile | null } | null> {
  const rows = await sql`
    SELECT r.*, sc.body
    FROM snapshot_release r
    JOIN data_version dv ON dv.id = r.data_version_id
    JOIN scoring_config sc ON sc.id = dv.scoring_config_id
    WHERE r.status = 'published' AND r.valid_from <= ${time} AND (r.valid_to IS NULL OR r.valid_to > ${time})
    ORDER BY r.valid_from DESC`;
  const full = rows.find((r: Record<string, unknown>) => r.kind === "full");
  if (!full) return null;
  const delta = rows.find((r: Record<string, unknown>) => r.kind === "delta" && r.base_version === full.version);
  return { full: toFile(full), delta: delta ? toFile(delta) : null };
}

/**
 * Deletes published files that stopped being current more than 395 days before `now`, and
 * unpublished builds older than that, then rewrites the archive index (US4-3).
 */
export async function runSnapshotRetention(
  sql: Db,
  opts: Pick<ReleaseOptions, "dir" | "workDir" | "key" | "disputeUrl" | "wikiRoot">,
  now = new Date(),
): Promise<{ deleted: string[]; kept: number }> {
  const cutoff = new Date(now.getTime() - ARCHIVE_RETENTION_DAYS * 86_400_000);
  const rows = await sql`
    SELECT id, version, file_path, report_path FROM snapshot_release
    WHERE (status = 'published' AND valid_to IS NOT NULL AND valid_to < ${cutoff})
       OR (status <> 'published' AND built_at < ${cutoff})`;
  for (const r of rows) {
    const files = [r.file_path, r.file_path && `${r.file_path}.sig`, r.report_path?.startsWith("v1/") ? r.report_path : null]
      .filter(Boolean)
      .map((p: string) => join(opts.dir, p));
    const staged = ["mmdb", "ranges.gz", "json", "report.json"].map((ext) => join(opts.workDir, `${r.version}.${ext}`));
    for (const path of [...files, ...staged]) await rm(path, { force: true });
  }
  if (rows.length > 0) await sql`DELETE FROM snapshot_release WHERE id IN ${sql(rows.map((r: { id: string }) => r.id))}`;
  const [{ count }] = await sql`SELECT count(*)::int AS count FROM snapshot_release`;
  const [current] = await sql`SELECT 1 FROM snapshot_release WHERE kind = 'full' AND status = 'published' AND valid_to IS NULL`;
  if (rows.length > 0 && current) await writeIndexes(sql, opts, now);
  return { deleted: rows.map((r: { version: string }) => r.version), kept: count };
}
