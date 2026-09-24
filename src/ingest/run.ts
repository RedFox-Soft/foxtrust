import { join } from "node:path";
import type { Db } from "../db/client";
import { getFeed } from "../feeds/registry";
import { FeedParseError, type FeedDefinition, type FeedFile, type ParseResult } from "../feeds/types";
import { applyEntries } from "./apply";
import { FeedFetchError, fetchFeed, limitsFor, loadArtifacts, saveArtifacts } from "./fetch";
import { shrinkGuard } from "./guards";
import { readLicence, type LicenceStatus } from "./licence-gate";

export const DEFAULT_ARTIFACT_ROOT = join(import.meta.dir, "..", "..", "var", "feeds");

export type RunStatus = "licence_missing" | "failed" | "held" | "unchanged" | "applied" | "skipped";

export type RunReport = {
  feed: string;
  runId: number | null;
  status: RunStatus;
  entryCount: number | null;
  previousEntryCount: number | null;
  invalidLines: number | null;
  licence: LicenceStatus;
  error: string | null;
  dataVersion: string | null;
};

export type RunOptions = {
  fromFiles?: string[];
  wikiRoot?: string;
  artifactRoot?: string;
  /** Test hooks: override the definition and the download URLs. */
  definition?: FeedDefinition;
  urls?: Record<string, string>;
  allowLoopbackHttp?: boolean;
};

type Failure = { code: string; message: string };

function describe(error: unknown): Failure {
  if (error instanceof FeedFetchError) return { code: error.code, message: error.message };
  if (error instanceof FeedParseError) return { code: "parse_error", message: error.message };
  return { code: "error", message: error instanceof Error ? error.message : String(error) };
}

async function finishRun(
  sql: Db,
  runId: number,
  fields: { status: RunStatus; error?: string | null; entryCount?: number | null; previousEntryCount?: number | null; invalidLines?: number | null; sha?: string | null; artifact?: string | null },
): Promise<void> {
  await sql`
    UPDATE feed_run SET status = ${fields.status}, finished_at = now(), error = ${fields.error ?? null},
      entry_count = ${fields.entryCount ?? null}, previous_entry_count = ${fields.previousEntryCount ?? null},
      invalid_lines = ${fields.invalidLines ?? null}, content_sha256 = ${fields.sha ?? null},
      artifact_path = ${fields.artifact ?? null}
    WHERE id = ${runId}`;
}

async function markStale(sql: Db, feedId: string, error: string): Promise<void> {
  await sql`UPDATE feed SET stale = true, last_error = ${error} WHERE id = ${feedId}`;
}

/** Applies parsed entries in one transaction and records a successful run (applied/unchanged). */
async function commitRun(
  sql: Db,
  def: FeedDefinition,
  runId: number,
  parsed: ParseResult,
  shippable: boolean,
  status: "applied" | "unchanged",
  extra: { sha: string | null; previousEntryCount: number | null; artifact: string | null; confirm?: boolean },
): Promise<string> {
  return (await sql.begin(async (tx) => {
    const { version } = await applyEntries(tx, def, runId, parsed.entries, shippable);
    await tx`
      UPDATE feed_run SET status = ${status}, finished_at = now(), committed_at = now(),
        data_version_id = ${version.id}, entry_count = ${parsed.entries.length},
        previous_entry_count = ${extra.previousEntryCount}, invalid_lines = ${parsed.invalidLines},
        content_sha256 = COALESCE(${extra.sha}, content_sha256), artifact_path = ${extra.artifact},
        error = NULL, confirmed_at = CASE WHEN ${extra.confirm === true} THEN now() ELSE confirmed_at END
      WHERE id = ${runId}`;
    await tx`
      UPDATE feed SET last_success_at = now(), entry_count = ${parsed.entries.length}, stale = false, last_error = NULL
      WHERE id = ${def.id}`;
    return version.label;
  })) as string;
}

/**
 * One ingestion attempt for one feed (data-model.md, feed_run state machine):
 * licence gate → advisory lock → fetch → parse → entry limit → shrink guard → apply.
 */
export async function runFeed(sql: Db, feedId: string, opts: RunOptions = {}): Promise<RunReport> {
  const def = opts.definition ?? getFeed(feedId);
  if (!def) throw new Error(`unknown feed "${feedId}"`);
  const report: RunReport = {
    feed: def.id, runId: null, status: "skipped", entryCount: null, previousEntryCount: null,
    invalidLines: null, licence: "missing", error: null, dataVersion: null,
  };

  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn`SELECT pg_try_advisory_lock(hashtext(${`feed:${def.id}`})) AS locked`;
    if (!locked) return { ...report, error: "another run of this feed is in progress" };

    try {
      const licence = await readLicence(def.id, opts.wikiRoot);
      report.licence = licence.status;
      await sql`
        INSERT INTO feed (id, licence_status, licence_checked, last_attempt_at)
        VALUES (${def.id}, ${licence.status}, ${licence.checked}, now())
        ON CONFLICT (id) DO UPDATE SET licence_status = EXCLUDED.licence_status,
          licence_checked = EXCLUDED.licence_checked, last_attempt_at = now()`;
      const [run] = await sql`
        INSERT INTO feed_run (feed_id, started_at, status) VALUES (${def.id}, now(), 'started') RETURNING id`;
      const runId = Number(run.id);
      report.runId = runId;

      if (licence.status === "missing") {
        const error = licence.problems.join("; ");
        await finishRun(sql, runId, { status: "licence_missing", error });
        return { ...report, status: "licence_missing", error };
      }

      const [feedRow] = await sql`SELECT entry_count FROM feed WHERE id = ${def.id}`;
      const previousEntryCount = feedRow?.entry_count === null || feedRow?.entry_count === undefined ? null : Number(feedRow.entry_count);
      report.previousEntryCount = previousEntryCount;

      let files: FeedFile[];
      let sha: string;
      let parsed: ParseResult;
      try {
        ({ files, sha256: sha } = await fetchFeed(def, {
          ...(opts.fromFiles ? { fromFiles: opts.fromFiles } : {}),
          ...(opts.urls ? { urls: opts.urls } : {}),
          ...(opts.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
        }));
        parsed = def.parse(files, new Date());
        const { maxEntries } = limitsFor(def);
        if (parsed.entries.length > maxEntries) {
          throw Object.assign(new Error(`${parsed.entries.length} entries exceed the limit of ${maxEntries}`), {
            code: "too_many_entries",
          });
        }
      } catch (error) {
        const failure = (error as { code?: string }).code === "too_many_entries"
          ? { code: "too_many_entries", message: (error as Error).message }
          : describe(error);
        const message = `${failure.code}: ${failure.message}`;
        await finishRun(sql, runId, { status: "failed", error: message, previousEntryCount });
        await markStale(sql, def.id, message);
        return { ...report, status: "failed", error: message };
      }

      report.entryCount = parsed.entries.length;
      report.invalidLines = parsed.invalidLines;
      const artifact = await saveArtifacts(opts.artifactRoot ?? DEFAULT_ARTIFACT_ROOT, def.id, runId, files);
      const [last] = await sql`
        SELECT content_sha256 FROM feed_run
        WHERE feed_id = ${def.id} AND status IN ('applied', 'unchanged') AND content_sha256 IS NOT NULL
        ORDER BY committed_at DESC, id DESC LIMIT 1`;
      const unchanged = last?.content_sha256 === sha;

      if (!unchanged && shrinkGuard(previousEntryCount, parsed.entries.length) === "hold") {
        const error = `held: ${parsed.entries.length} entries is under 50 % of the previous ${previousEntryCount}; confirm with \`foxtrust feeds confirm ${runId}\``;
        await finishRun(sql, runId, {
          status: "held", error, entryCount: parsed.entries.length, previousEntryCount,
          invalidLines: parsed.invalidLines, sha, artifact,
        });
        await markStale(sql, def.id, error);
        return { ...report, status: "held", error };
      }

      const status = unchanged ? "unchanged" : "applied";
      const dataVersion = await commitRun(sql, def, runId, parsed, licence.status === "shippable", status, {
        sha, previousEntryCount, artifact,
      });
      return { ...report, status, dataVersion };
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtext(${`feed:${def.id}`}))`;
    }
  } finally {
    conn.release();
  }
}

/** Applies a held run from its stored artifact; the same feed_run row becomes `applied`. */
export async function confirmHeldRun(sql: Db, runId: number, opts: { wikiRoot?: string } = {}): Promise<RunReport> {
  const [run] = await sql`SELECT id, feed_id, status, artifact_path, previous_entry_count FROM feed_run WHERE id = ${runId}`;
  if (!run) throw new Error(`feed run ${runId} does not exist`);
  if (run.status !== "held") throw new Error(`feed run ${runId} is ${run.status}, not held`);
  const def = getFeed(run.feed_id);
  if (!def) throw new Error(`unknown feed "${run.feed_id}"`);
  if (!run.artifact_path) throw new Error(`feed run ${runId} has no stored artifact`);

  const licence = await readLicence(def.id, opts.wikiRoot);
  if (licence.status === "missing") throw new Error(`licence record for ${def.id} is missing: ${licence.problems.join("; ")}`);
  const parsed = def.parse(await loadArtifacts(run.artifact_path, def), new Date());
  const previousEntryCount = run.previous_entry_count === null ? null : Number(run.previous_entry_count);
  const dataVersion = await commitRun(sql, def, runId, parsed, licence.status === "shippable", "applied", {
    sha: null, previousEntryCount, artifact: run.artifact_path, confirm: true,
  });
  return {
    feed: def.id, runId, status: "applied", entryCount: parsed.entries.length, previousEntryCount,
    invalidLines: parsed.invalidLines, licence: licence.status, error: null, dataVersion,
  };
}
