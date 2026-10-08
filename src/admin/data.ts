import type { SQL } from "bun";
import { listProblems, type ProblemRow } from "../alerts/store";
import { resolveVersionAt } from "../db/versions";
import { FEEDS } from "../feeds/registry";
import { listRequests, type OperatorRequest } from "./requests";

/** Read views of the admin panel (spec 011 research R6). Fixed SQL only; lists are paged at 50. */

export const PAGE_SIZE = 50;

export type ReleaseView = {
  version: string; kind: "full" | "delta"; status: string; builtAt: Date; releaseNote: string | null; error: string | null;
  regressions: string[]; problems: string[]; pending: OperatorRequest | null;
};

export type RunView = { id: number; status: string; startedAt: Date; entryCount: number | null; previousEntryCount: number | null; error: string | null };
export type FeedView = {
  id: string; lastSuccessAt: Date | null; stale: boolean; enabled: boolean; lastError: string | null;
  lastRun: RunView | null; pending: OperatorRequest | null;
};

type ReleaseRow = { version: string; kind: "full" | "delta"; status: string; built_at: Date; release_note: string | null; error: string | null; report_path: string | null };

async function heldDetails(row: ReleaseRow, alerts: ProblemRow[]): Promise<{ regressions: string[]; problems: string[] }> {
  if (row.status !== "held") return { regressions: [], problems: [] };
  const problems = row.error ? [row.error] : [];
  if (row.report_path) {
    try {
      const report = (await Bun.file(row.report_path).json()) as { regressions?: unknown };
      if (Array.isArray(report.regressions)) return { regressions: report.regressions.map(String), problems };
    } catch {
      // The report may be gone (retention) or unreadable; the alert keeps the same facts.
    }
  }
  const alert = alerts.find((a) => a.kind === "release" && a.details.version === row.version);
  return alert && alert.kind === "release"
    ? { regressions: alert.details.regressions, problems: [...problems, ...alert.details.problems] }
    : { regressions: [], problems };
}

export async function releases(sql: SQL, opts: { page?: number; now?: Date } = {}): Promise<ReleaseView[]> {
  const page = Math.max(0, opts.page ?? 0);
  const rows = (await sql`
    SELECT version, kind, status, built_at, release_note, error, report_path FROM snapshot_release
    ORDER BY built_at DESC, id DESC LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`) as ReleaseRow[];
  const alerts = await listProblems(sql, opts.now ?? new Date());
  const pending = (await listRequests(sql, { pendingOnly: true, limit: 200 })).filter((r) => r.kind === "release");
  return Promise.all(rows.map(async (r) => ({
    version: r.version, kind: r.kind, status: r.status, builtAt: r.built_at, releaseNote: r.release_note, error: r.error,
    ...(await heldDetails(r, alerts)),
    pending: pending.find((p) => p.target === r.version) ?? null,
  })));
}

export async function releaseOf(sql: SQL, version: string): Promise<ReleaseView | null> {
  const [row] = (await sql`
    SELECT version, kind, status, built_at, release_note, error, report_path FROM snapshot_release WHERE version = ${version}`) as ReleaseRow[];
  if (!row) return null;
  const pending = (await listRequests(sql, { pendingOnly: true, limit: 200 })).find((p) => p.kind === "release" && p.target === version) ?? null;
  return {
    version: row.version, kind: row.kind, status: row.status, builtAt: row.built_at, releaseNote: row.release_note, error: row.error,
    ...(await heldDetails(row, await listProblems(sql, new Date()))), pending,
  };
}

type RunRow = { id: string | number; feed_id: string; status: string; started_at: Date; entry_count: number | null; previous_entry_count: number | null; error: string | null };
const toRun = (r: RunRow): RunView => ({
  id: Number(r.id), status: r.status, startedAt: r.started_at, entryCount: r.entry_count, previousEntryCount: r.previous_entry_count, error: r.error,
});

export async function runOf(sql: SQL, id: number): Promise<(RunView & { feedId: string }) | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const [row] = (await sql`
    SELECT id, feed_id, status, started_at, entry_count, previous_entry_count, error FROM feed_run WHERE id = ${id}`) as RunRow[];
  return row ? { ...toRun(row), feedId: row.feed_id } : null;
}

/** One row per registered feed: the last run, staleness, and whether the active config enables it. */
export async function feeds(sql: SQL, now: Date = new Date()): Promise<FeedView[]> {
  const feedRows = (await sql`SELECT id, last_success_at, stale, last_error FROM feed`) as { id: string; last_success_at: Date | null; stale: boolean; last_error: string | null }[];
  const lastRuns = (await sql`
    SELECT DISTINCT ON (feed_id) id, feed_id, status, started_at, entry_count, previous_entry_count, error
    FROM feed_run ORDER BY feed_id, started_at DESC, id DESC`) as RunRow[];
  const version = await resolveVersionAt(sql, now);
  const pending = (await listRequests(sql, { pendingOnly: true, limit: 200 })).filter((r) => r.kind === "confirm_run");
  return FEEDS.map((def) => {
    const row = feedRows.find((f) => f.id === def.id);
    const run = lastRuns.find((r) => r.feed_id === def.id);
    return {
      id: def.id,
      lastSuccessAt: row?.last_success_at ?? null,
      stale: row?.stale ?? false,
      enabled: version ? version.config.sourceConfidence[def.id] !== undefined : false,
      lastError: row?.last_error ?? null,
      lastRun: run ? toRun(run) : null,
      pending: run ? (pending.find((p) => p.target === String(run.id)) ?? null) : null,
    };
  });
}

export type Overview = {
  alerts: ProblemRow[];
  heldRuns: (RunView & { feedId: string })[];
  staleFeeds: FeedView[];
  heldReleases: ReleaseView[];
  pending: OperatorRequest[];
};

export async function overview(sql: SQL, now: Date = new Date()): Promise<Overview> {
  const feedList = await feeds(sql, now);
  const recent = await releases(sql, { now });
  return {
    alerts: (await listProblems(sql, now)).filter((p) => p.state === "open"),
    heldRuns: feedList.filter((f) => f.lastRun?.status === "held").map((f) => ({ ...f.lastRun!, feedId: f.id })),
    staleFeeds: feedList.filter((f) => f.stale),
    heldReleases: recent.filter((r) => r.status === "held"),
    pending: await listRequests(sql, { pendingOnly: true, limit: 50 }),
  };
}
