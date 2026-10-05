import type { SQL } from "bun";
import type { FeedDefinition } from "../feeds/types";
import { minimumGapMinutes } from "../ingest/schedule";
import type { DeriveContext, Deriver } from "./reconcile";
import type { Derived, Problem, ReleaseDetails } from "./store";

type FeedRow = {
  id: string;
  last_success_at: Date | null;
  last_error: string | null;
  run_id: string | null;
  run_status: string | null;
  entry_count: number | null;
  previous_entry_count: number | null;
  run_error: string | null;
};

/**
 * Research R5/R6: a feed is a problem while its latest finished run is held, or while its last
 * success (or the scheduler start, whichever is later) is older than twice its schedule gap.
 */
export function feedDeriver(feeds: FeedDefinition[]): Deriver {
  return async (tx: SQL, ctx: DeriveContext): Promise<Derived> => {
    const ids = feeds.map((f) => f.id);
    const rows = ids.length === 0 ? [] : await tx<FeedRow[]>`
      SELECT f.id, f.last_success_at, f.last_error,
             r.id AS run_id, r.status AS run_status, r.entry_count, r.previous_entry_count, r.error AS run_error
      FROM feed f
      LEFT JOIN LATERAL (
        SELECT id, status, entry_count, previous_entry_count, error FROM feed_run
        WHERE feed_id = f.id AND status <> 'started' ORDER BY id DESC LIMIT 1
      ) r ON true
      WHERE f.id IN ${tx(ids)}`;
    const byId = new Map(rows.map((r) => [r.id, r]));

    const problems: Problem[] = [];
    for (const def of feeds) {
      const row = byId.get(def.id);
      const lastSuccess = row?.last_success_at ? new Date(row.last_success_at) : null;
      const staleAfterMinutes = 2 * minimumGapMinutes(def.schedule);
      // A restart or a fresh deployment gets a full threshold before its feeds count as stale.
      const base = Math.max(lastSuccess?.getTime() ?? -Infinity, ctx.startedAt.getTime());
      const stale = ctx.now.getTime() - base > staleAfterMinutes * 60_000;
      const held = row?.run_status === "held" && row.run_id !== null;
      if (!stale && !held) continue;
      problems.push({
        kind: "feed",
        key: `feed:${def.id}`,
        subject: def.id,
        details: {
          heldRun: held ? { id: Number(row.run_id), entryCount: row.entry_count, previousEntryCount: row.previous_entry_count } : null,
          stale,
          lastSuccessAt: lastSuccess?.toISOString() ?? null,
          staleAfterMinutes,
          // For a held run the last error only repeats the held message. A run skipped for a missing
          // licence record leaves its error on the run only.
          lastError: held ? null : (row?.last_error ?? row?.run_error ?? null),
        },
      });
    }

    const known = new Set(ids);
    const open = await tx<{ key: string; subject: string }[]>`
      SELECT key, subject FROM alert_problem WHERE kind = 'feed' AND state = 'open'`;
    return { prefix: "feed:", problems, silentlyClosed: open.filter((p) => !known.has(p.subject)).map((p) => p.key) };
  };
}

type ReleaseRow = {
  kind: "full" | "delta";
  version: string;
  status: "held" | "rejected" | "published";
  built_at: Date;
  report_path: string | null;
  error: string | null;
};

async function reportRegressions(path: string | null): Promise<string[]> {
  if (!path) return [];
  try {
    const report: unknown = await Bun.file(path).json();
    const list = typeof report === "object" && report !== null ? (report as Record<string, unknown>).regressions : null;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Research R6: a release kind is a problem while its newest finished release is held or rejected. */
export const releaseDeriver: Deriver = async (tx: SQL): Promise<Derived> => {
  const rows = await tx<ReleaseRow[]>`
    SELECT DISTINCT ON (kind) kind, version, status, built_at, report_path, error
    FROM snapshot_release WHERE status IN ('held', 'rejected', 'published')
    ORDER BY kind, built_at DESC, id DESC`;
  const problems: Problem[] = [];
  const resolutions = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = `release:${row.kind}`;
    if (row.status === "published") {
      resolutions.set(key, { publishedVersion: row.version });
      continue;
    }
    const details: ReleaseDetails = {
      version: row.version,
      status: row.status,
      builtAt: new Date(row.built_at).toISOString(),
      regressions: row.status === "held" ? await reportRegressions(row.report_path) : [],
      problems: row.error ? row.error.split("\n").filter((l) => l.trim() !== "") : [],
      reportPath: row.report_path,
    };
    problems.push({ kind: "release", key, subject: row.kind, details });
  }
  return { prefix: "release:", problems, resolutions };
};
