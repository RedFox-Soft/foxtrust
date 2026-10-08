import type { SQL } from "bun";
import { confirmHeldRun } from "../ingest/run";
import { publishStaged, withSnapshotLock, type ReleaseOptions } from "../snapshot/publish";

/**
 * Operator requests (spec 011 research R4): the panel records them; the scheduler carries them out,
 * because it alone holds the signing key and the feed artifacts. One pending request per item.
 */

export type RequestKind = "release" | "confirm_run";
export type RequestState = "requested" | "done" | "failed";
export type OperatorRequest = {
  id: number; kind: RequestKind; target: string; note: string | null; requestedBy: string; requestedAt: Date;
  state: RequestState; result: string | null; doneAt: Date | null;
};
export type Who = { subject: string; name: string };

/** A request the panel refuses; its message is shown to the operator. */
export class RequestError extends Error {}

const VERSION = /^(f\d{8}|d\d{8}T\d{2})$/;

type Row = {
  id: string | number; kind: RequestKind; target: string; note: string | null; requested_by_name: string; requested_at: Date;
  state: RequestState; result: string | null; done_at: Date | null;
};
const toRequest = (r: Row): OperatorRequest => ({
  id: Number(r.id), kind: r.kind, target: r.target, note: r.note, requestedBy: r.requested_by_name, requestedAt: r.requested_at,
  state: r.state, result: r.result, doneAt: r.done_at,
});

async function insert(sql: SQL, kind: RequestKind, target: string, note: string | null, who: Who, at: Date): Promise<OperatorRequest> {
  try {
    const [row] = (await sql`
      INSERT INTO operator_request (kind, target, note, requested_by_subject, requested_by_name, requested_at)
      VALUES (${kind}, ${target}, ${note}, ${who.subject}, ${who.name}, ${at})
      RETURNING id, kind, target, note, requested_by_name, requested_at, state, result, done_at`) as Row[];
    return toRequest(row!);
  } catch (error) {
    if ((error as { errno?: string; code?: string }).errno === "23505" || String((error as Error).message).includes("operator_request_pending")) {
      throw new RequestError("a request for this item is already pending");
    }
    throw error;
  }
}

/** Records a release request for a held snapshot; the note is required (Principle VI). */
export async function requestRelease(sql: SQL, input: { version: string; note: string; who: Who }, at = new Date()): Promise<OperatorRequest> {
  const note = input.note.trim();
  if (note.length < 10 || note.length > 1000) throw new RequestError("the note must be 10–1000 characters");
  if (!VERSION.test(input.version)) throw new RequestError("no such release");
  const [release] = (await sql`SELECT status FROM snapshot_release WHERE version = ${input.version}`) as { status: string }[];
  if (!release) throw new RequestError("no such release");
  if (release.status !== "held") throw new RequestError(`release ${input.version} is ${release.status}, not held`);
  return insert(sql, "release", input.version, note, input.who, at);
}

/** Records a confirmation request for a held feed run. */
export async function requestRunConfirm(sql: SQL, input: { runId: number; note?: string | null; who: Who }, at = new Date()): Promise<OperatorRequest> {
  const note = input.note?.trim() || null;
  if (note && note.length > 1000) throw new RequestError("the note must be at most 1000 characters");
  if (!Number.isSafeInteger(input.runId) || input.runId < 1) throw new RequestError("no such run");
  const [run] = (await sql`SELECT status FROM feed_run WHERE id = ${input.runId}`) as { status: string }[];
  if (!run) throw new RequestError("no such run");
  if (run.status !== "held") throw new RequestError(`run ${input.runId} is ${run.status}, not held`);
  return insert(sql, "confirm_run", String(input.runId), note, input.who, at);
}

export async function listRequests(sql: SQL, opts: { pendingOnly?: boolean; limit?: number } = {}): Promise<OperatorRequest[]> {
  const rows = (await sql`
    SELECT id, kind, target, note, requested_by_name, requested_at, state, result, done_at FROM operator_request
    WHERE (${opts.pendingOnly ?? false} = false OR state = 'requested')
    ORDER BY requested_at DESC, id DESC LIMIT ${opts.limit ?? 50}`) as Row[];
  return rows.map(toRequest);
}

/**
 * The scheduler's pass (every minute): carries out pending requests, oldest first, as
 * `snapshot publish --release-note` and `feeds confirm` do. A busy snapshot lock, or no signing key
 * in this process, leaves a release request pending for the next pass.
 */
export async function runOperatorRequests(deps: {
  sql: SQL;
  release: ReleaseOptions | null;
  clock?: () => Date;
  log?: (line: string) => void;
}): Promise<OperatorRequest[]> {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const handled: OperatorRequest[] = [];
  const pending = (await deps.sql`
    SELECT id FROM operator_request WHERE state = 'requested' ORDER BY requested_at, id LIMIT 20`) as { id: string | number }[];
  for (const { id } of pending) {
    const outcome = await deps.sql.begin(async (tx) => {
      const [row] = (await tx`
        SELECT id, kind, target, note, requested_by_name, requested_at, state, result, done_at FROM operator_request
        WHERE id = ${id} AND state = 'requested' FOR UPDATE SKIP LOCKED`) as Row[];
      if (!row) return null;
      let state: RequestState;
      let result: string;
      try {
        if (row.kind === "release") {
          if (!deps.release) return null;
          const r = await withSnapshotLock(deps.sql, () => publishStaged(deps.sql, row.target, { ...deps.release!, releaseNote: row.note, now: clock() }));
          if (r === null) return null;
          [state, result] = r.status === "published" ? ["done", `published ${r.version} → ${r.path}`] : ["failed", `${r.status}: ${r.problems.join("; ")}`];
        } else {
          const r = await confirmHeldRun(deps.sql, Number(row.target));
          [state, result] = ["done", `run ${r.runId} ${r.status}, ${r.entryCount} entries`];
        }
      } catch (error) {
        [state, result] = ["failed", (error as Error).message];
      }
      result = result.slice(0, 2000);
      const doneAt = clock();
      await tx`UPDATE operator_request SET state = ${state}, result = ${result}, done_at = ${doneAt} WHERE id = ${row.id}`;
      return toRequest({ ...row, state, result, done_at: doneAt });
    });
    if (!outcome) continue;
    log(`request ${outcome.id} ${outcome.kind} ${outcome.target}: ${outcome.state} ${outcome.result ?? ""}`.slice(0, 300));
    handled.push(outcome);
  }
  return handled;
}
