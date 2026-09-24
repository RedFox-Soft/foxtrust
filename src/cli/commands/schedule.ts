import { openDb } from "../../db/client";
import { resolveVersionAt } from "../../db/versions";
import { FEEDS } from "../../feeds/registry";
import { checkSchedules, checkSources, readLicences, startScheduler } from "../../ingest/schedule";
import { EXIT, printLine, rejectUnknown, warn, type Context } from "../util";

/** Long-running: per-feed schedules plus nightly retention (research R10). */
export async function scheduleCommand(args: string[], _ctx: Context): Promise<number> {
  rejectUnknown(args);
  const sql = openDb();
  const version = await resolveVersionAt(sql, new Date());
  if (!version) {
    warn("error: no scoring configuration is active; run `foxtrust config activate <file>`");
    await sql.close();
    return EXIT.error;
  }
  const problems = [...checkSchedules(FEEDS, await readLicences(FEEDS)), ...checkSources(FEEDS, version.config)];
  if (problems.length > 0) {
    for (const p of problems) warn(`error: ${p}`);
    await sql.close();
    return EXIT.usage;
  }

  const stop = startScheduler(sql, FEEDS, warn);
  printLine(`Scheduler running for ${FEEDS.length} feeds and nightly retention. Press Ctrl+C to stop.`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  stop();
  await sql.close();
  return EXIT.ok;
}
