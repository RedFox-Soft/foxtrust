import { openDb } from "../../db/client";
import { FEEDS, getFeed } from "../../feeds/registry";
import { matchLocalFiles } from "../../ingest/fetch";
import { runFeed, type RunReport } from "../../ingest/run";
import { EXIT, printJson, printTable, rejectUnknown, takeOption, UsageError, type Context } from "../util";

const PROBLEM_STATUSES = new Set(["failed", "held", "licence_missing", "skipped"]);

/** `--from-file <feed>=<path>`, repeatable per feed (contracts/cli.md). */
export function parseFromFiles(values: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const value of values) {
    const eq = value.indexOf("=");
    if (eq <= 0 || eq === value.length - 1) throw new UsageError(`--from-file expects <feed>=<path>, got "${value}"`);
    const feed = value.slice(0, eq);
    if (!getFeed(feed)) throw new UsageError(`unknown feed "${feed}" in --from-file`);
    out.set(feed, [...(out.get(feed) ?? []), value.slice(eq + 1)]);
  }
  return out;
}

export function printRuns(runs: RunReport[]): void {
  printTable(
    ["feed", "run", "status", "entries", "previous", "invalid", "licence", "data version", "error"],
    runs.map((r) => [r.feed, r.runId, r.status, r.entryCount, r.previousEntryCount, r.invalidLines, r.licence, r.dataVersion, r.error]),
  );
}

export async function ingestCommand(args: string[], ctx: Context): Promise<number> {
  const feedIds = takeOption(args, "--feed");
  const fromFiles = parseFromFiles(takeOption(args, "--from-file"));
  rejectUnknown(args);
  if (args.length > 0) throw new UsageError(`unexpected argument ${args[0]}`);
  for (const id of feedIds) if (!getFeed(id)) throw new UsageError(`unknown feed "${id}"`);

  // A wrong file set is an argument error (exit 2), checked before any run touches the database.
  for (const [id, paths] of fromFiles) {
    try {
      matchLocalFiles(getFeed(id)!, paths);
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
  }

  const selected =
    feedIds.length > 0 ? feedIds : fromFiles.size > 0 ? [...fromFiles.keys()] : FEEDS.map((f) => f.id);

  const sql = openDb();
  try {
    const runs: RunReport[] = [];
    for (const id of selected) {
      const files = fromFiles.get(id);
      runs.push(await runFeed(sql, id, files ? { fromFiles: files } : {}));
    }
    if (ctx.json) printJson({ runs });
    else printRuns(runs);
    return runs.some((r) => PROBLEM_STATUSES.has(r.status)) ? EXIT.problems : EXIT.ok;
  } finally {
    await sql.close();
  }
}
