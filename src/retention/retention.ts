import { rm } from "node:fs/promises";
import { createAccounts } from "../api/accounts";
import type { Db } from "../db/client";
import { createDataVersion, resolveVersionAt } from "../db/versions";

export const ARTIFACT_RETENTION_DAYS = 30;
/** Daily API usage counters (spec 010 research R5): a year of billing and abuse history. */
export const API_USAGE_RETENTION_DAYS = 400;
/** Admin audit records (spec 011 research R5). */
export const ADMIN_AUDIT_RETENTION_DAYS = 400;
const DAY_MS = 86_400_000;

export type RetentionReport = {
  rawDeleted: number;
  episodesTrimmed: number;
  aggregatesDeleted: number;
  artifactsDeleted: number;
  apiUsageDeleted: number;
  adminSessionsDeleted: number;
  adminAuditDeleted: number;
  dataVersion: string;
};

/**
 * FR-029 and data-model.md retention: raw behavior rows older than `rawDays`, daily aggregates
 * older than `rawDays + aggregateDays`, fetched artifacts older than 30 days (held runs excepted),
 * API usage counters and admin audit records older than 400 days, and expired admin sessions.
 * Deleted aggregates cannot change a current verdict by more than rounding (FR-029a).
 */
export async function runRetention(sql: Db, now: Date = new Date()): Promise<RetentionReport> {
  const version = await resolveVersionAt(sql, now);
  if (!version) throw new Error("no scoring configuration is active; run `foxtrust config activate <file>`");
  const { rawDays, aggregateDays } = version.config.retention;
  const rawCutoff = new Date(now.getTime() - rawDays * DAY_MS);
  const aggregateCutoffDay = new Date(now.getTime() - (rawDays + aggregateDays) * DAY_MS).toISOString().slice(0, 10);
  const artifactCutoff = new Date(now.getTime() - ARTIFACT_RETENTION_DAYS * DAY_MS);

  const report = (await sql.begin(async (tx) => {
    const raw = await tx`DELETE FROM behavior_sighting WHERE last_seen < ${rawCutoff}`;
    const trimmed = await tx`UPDATE behavior_sighting SET first_seen = ${rawCutoff} WHERE first_seen < ${rawCutoff}`;
    const aggregates = await tx`DELETE FROM behavior_daily WHERE day < ${aggregateCutoffDay}::date`;
    const dv = await createDataVersion(tx, { cause: "retention" });
    return {
      rawDeleted: Number(raw.count ?? 0),
      episodesTrimmed: Number(trimmed.count ?? 0),
      aggregatesDeleted: Number(aggregates.count ?? 0),
      artifactsDeleted: 0,
      apiUsageDeleted: 0,
      adminSessionsDeleted: 0,
      adminAuditDeleted: 0,
      dataVersion: dv.label,
    };
  })) as RetentionReport;

  const expired = await sql`
    SELECT id, artifact_path FROM feed_run
    WHERE artifact_path IS NOT NULL AND started_at < ${artifactCutoff} AND status <> 'held'`;
  for (const row of expired) {
    await rm(row.artifact_path, { recursive: true, force: true });
    await sql`UPDATE feed_run SET artifact_path = NULL WHERE id = ${row.id}`;
    report.artifactsDeleted++;
  }
  report.apiUsageDeleted = await createAccounts(sql, undefined, () => now).pruneUsage(API_USAGE_RETENTION_DAYS);
  const sessions = await sql`DELETE FROM admin_session WHERE expires_at < ${now}`;
  report.adminSessionsDeleted = Number(sessions.count ?? 0);
  const audits = await sql`DELETE FROM admin_audit WHERE at < ${new Date(now.getTime() - ADMIN_AUDIT_RETENTION_DAYS * DAY_MS)}`;
  report.adminAuditDeleted = Number(audits.count ?? 0);
  return report;
}
