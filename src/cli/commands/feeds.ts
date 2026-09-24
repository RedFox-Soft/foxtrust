import { openDb } from "../../db/client";
import { FEEDS } from "../../feeds/registry";
import { confirmHeldRun } from "../../ingest/run";
import { EXIT, printJson, printTable, rejectUnknown, UsageError, type Context } from "../util";
import { printRuns } from "./ingest";

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** FR-020: one row per feed with licence, freshness and health. */
export async function feedsStatus(args: string[], ctx: Context): Promise<number> {
  rejectUnknown(args);
  const sql = openDb();
  try {
    const rows = await sql`
      SELECT id, licence_status, licence_checked::text AS licence_checked, last_success_at, last_attempt_at,
             entry_count, stale, last_error
      FROM feed`;
    const byId = new Map(rows.map((r: Record<string, unknown>) => [r.id as string, r]));
    const feeds = FEEDS.map((def) => {
      const r = byId.get(def.id) as Record<string, unknown> | undefined;
      return {
        feed: def.id,
        licence: (r?.licence_status as string | undefined) ?? "missing",
        shippable: r?.licence_status === "shippable",
        licenceChecked: (r?.licence_checked as string | null | undefined) ?? null,
        lastSuccessAt: iso(r?.last_success_at),
        lastAttemptAt: iso(r?.last_attempt_at),
        entryCount: r?.entry_count === null || r?.entry_count === undefined ? null : Number(r.entry_count),
        stale: r ? Boolean(r.stale) : false,
        lastError: (r?.last_error as string | null | undefined) ?? null,
      };
    });
    if (ctx.json) {
      printJson({ feeds });
    } else {
      printTable(
        ["feed", "licence", "checked", "last success", "last attempt", "entries", "stale", "last error"],
        feeds.map((f) => [f.feed, f.licence, f.licenceChecked, f.lastSuccessAt, f.lastAttemptAt, f.entryCount, f.stale ? "yes" : "no", f.lastError]),
      );
    }
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}

export async function feedsConfirm(args: string[], ctx: Context): Promise<number> {
  rejectUnknown(args);
  const runId = Number(args[0]);
  if (args.length !== 1 || !Number.isInteger(runId)) throw new UsageError("expected one feed run id");
  const sql = openDb();
  try {
    let report;
    try {
      report = await confirmHeldRun(sql, runId);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    if (ctx.json) printJson({ runs: [report] });
    else printRuns([report]);
    return EXIT.ok;
  } finally {
    await sql.close();
  }
}
