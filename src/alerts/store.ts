import type { SQL } from "bun";

export type FeedDetails = {
  heldRun: { id: number; entryCount: number | null; previousEntryCount: number | null } | null;
  stale: boolean;
  lastSuccessAt: string | null;
  staleAfterMinutes: number;
  lastError: string | null;
};
export type ReleaseDetails = {
  version: string;
  status: "held" | "rejected";
  builtAt: string;
  regressions: string[];
  problems: string[];
  reportPath: string | null;
  /** Set when the problem closes: the release of the same kind that was published. */
  publishedVersion?: string;
};
export type JobDetails = { error: string; failedAt: string };

/** A problem as derived or recorded now (research R6). */
export type Problem =
  | { kind: "feed"; key: string; subject: string; details: FeedDetails }
  | { kind: "release"; key: string; subject: string; details: ReleaseDetails }
  | { kind: "job"; key: string; subject: string; details: JobDetails };

export type ProblemState = "open" | "closed";
export type NotifiedState = "none" | ProblemState;

/** A stored problem (data-model.md). */
export type ProblemRow = Problem & {
  state: ProblemState;
  openedAt: Date;
  changedAt: Date;
  closedAt: Date | null;
  notifiedState: NotifiedState;
  notifiedAt: Date | null;
};

/** What one deriver found: the open problems under `prefix`, and how closed ones resolved. */
export type Derived = {
  prefix: string;
  problems: Problem[];
  /** Facts merged into a problem's details when it closes (e.g. the published version). */
  resolutions?: Map<string, Record<string, unknown>>;
  /** Keys to close without a message (a feed removed from the registry). */
  silentlyClosed?: string[];
};

type DbRow = {
  key: string;
  kind: Problem["kind"];
  subject: string;
  state: ProblemState;
  opened_at: Date;
  changed_at: Date;
  closed_at: Date | null;
  details: unknown;
  notified_state: NotifiedState;
  notified_at: Date | null;
};

const REMINDER_MS = 24 * 3_600_000;
const KEEP_CLOSED_MS = 30 * 86_400_000;

// Bun.sql binds a JS object as a JSON object (a JSON.stringify'd string would become a JSON string).
function toRow(r: DbRow): ProblemRow {
  const details = (typeof r.details === "string" ? JSON.parse(r.details) : r.details) as Problem["details"];
  return {
    key: r.key,
    kind: r.kind,
    subject: r.subject,
    details,
    state: r.state,
    openedAt: new Date(r.opened_at),
    changedAt: new Date(r.changed_at),
    closedAt: r.closed_at === null ? null : new Date(r.closed_at),
    notifiedState: r.notified_state,
    notifiedAt: r.notified_at === null ? null : new Date(r.notified_at),
  } as ProblemRow;
}

/** Opens a problem, reopens a closed one, or refreshes the details of an open one. */
export async function openProblem(sql: SQL, problem: Problem, now: Date): Promise<void> {
  await sql`
    INSERT INTO alert_problem (key, kind, subject, state, opened_at, changed_at, details)
    VALUES (${problem.key}, ${problem.kind}, ${problem.subject}, 'open', ${now}, ${now}, ${problem.details}::jsonb)
    ON CONFLICT (key) DO UPDATE SET
      details = EXCLUDED.details,
      opened_at = CASE WHEN alert_problem.state = 'closed' THEN EXCLUDED.opened_at ELSE alert_problem.opened_at END,
      changed_at = CASE WHEN alert_problem.state = 'closed' THEN EXCLUDED.changed_at ELSE alert_problem.changed_at END,
      closed_at = NULL,
      state = 'open'`;
}

/** Closes an open problem; `patch` adds facts for the recovery line. */
export async function closeProblem(sql: SQL, key: string, now: Date, patch: Record<string, unknown> = {}): Promise<void> {
  await sql`
    UPDATE alert_problem SET state = 'closed', closed_at = ${now}, changed_at = ${now}, details = details || ${patch}::jsonb
    WHERE key = ${key} AND state = 'open'`;
}

/** Applies one deriver's result: opens what it found and closes the rest under its prefix. */
export async function syncProblems(tx: SQL, derived: Derived, now: Date): Promise<void> {
  const silent = new Set(derived.silentlyClosed ?? []);
  if (silent.size > 0) {
    await tx`
      UPDATE alert_problem SET state = 'closed', closed_at = COALESCE(closed_at, ${now}), notified_state = 'closed'
      WHERE key IN ${tx([...silent])}`;
  }
  const found = new Set(derived.problems.map((p) => p.key));
  for (const problem of derived.problems) await openProblem(tx, problem, now);
  const open = await tx<{ key: string }[]>`
    SELECT key FROM alert_problem WHERE state = 'open' AND starts_with(key, ${derived.prefix})`;
  for (const { key } of open) {
    if (!found.has(key) && !silent.has(key)) await closeProblem(tx, key, now, derived.resolutions?.get(key) ?? {});
  }
}

export type ChangeType = "opened" | "reminder" | "recovered" | "resolved-unseen";
export type Change = { type: ChangeType; row: ProblemRow };

export function changeType(row: ProblemRow, now: Date): ChangeType | null {
  if (row.state === "open") {
    if (row.notifiedState !== "open") return "opened";
    return row.notifiedAt !== null && now.getTime() - row.notifiedAt.getTime() >= REMINDER_MS ? "reminder" : null;
  }
  if (row.notifiedState === "open") return "recovered";
  if (row.notifiedState === "none") return "resolved-unseen";
  return null;
}

/** Rows the operator has not been told about yet, or whose reminder is due, oldest change first. */
export async function pendingChanges(sql: SQL, now: Date): Promise<Change[]> {
  const rows = await sql<DbRow[]>`
    SELECT * FROM alert_problem
    WHERE state <> notified_state
       OR (state = 'open' AND notified_state = 'open' AND notified_at <= ${new Date(now.getTime() - REMINDER_MS)})
    ORDER BY changed_at, key`;
  const changes: Change[] = [];
  for (const r of rows) {
    const row = toRow(r);
    const type = changeType(row, now);
    if (type) changes.push({ type, row });
  }
  return changes;
}

/** Marks rendered rows as told, unless their state changed since they were read. */
export async function markNotified(sql: SQL, changes: Change[], now: Date): Promise<void> {
  for (const { row } of changes) {
    await sql`
      UPDATE alert_problem SET notified_state = state, notified_at = ${now}
      WHERE key = ${row.key} AND state = ${row.state}`;
  }
}

/** Deletes closed problems the operator was told about more than 30 days ago. */
export async function pruneClosed(sql: SQL, now: Date): Promise<void> {
  await sql`
    DELETE FROM alert_problem
    WHERE state = 'closed' AND notified_state = 'closed' AND closed_at < ${new Date(now.getTime() - KEEP_CLOSED_MS)}`;
}

/** Open problems and problems closed in the last 24 hours (`foxtrust alerts list`). */
export async function listProblems(sql: SQL, now: Date): Promise<ProblemRow[]> {
  const rows = await sql<DbRow[]>`
    SELECT * FROM alert_problem
    WHERE state = 'open' OR closed_at > ${new Date(now.getTime() - REMINDER_MS)}
    ORDER BY opened_at, key`;
  return rows.map(toRow);
}
