import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { openDb } from "../../db/client";
import { activateConfig, resolveVersionAt } from "../../db/versions";
import { FEEDS } from "../../feeds/registry";
import { checkSchedules, checkSources, readLicences, startScheduler } from "../../ingest/schedule";
import { ConfigError, loadConfig } from "../../scoring/config";
import { EXIT, printLine, rejectUnknown, takeOption, UsageError, warn, type Context } from "../util";

/**
 * Long-running: per-feed schedules plus nightly retention (research R10).
 * `--init-config <file>` activates that config only when none is active yet (first container
 * start); later changes go through `config activate` after an evaluation.
 * `--heartbeat <file>` is rewritten every minute for container healthchecks.
 */
export async function scheduleCommand(args: string[], _ctx: Context): Promise<number> {
  const [initConfig] = takeOption(args, "--init-config");
  const [heartbeatPath] = takeOption(args, "--heartbeat");
  rejectUnknown(args);
  const sql = openDb();

  let version = await resolveVersionAt(sql, new Date());
  if (!version && initConfig) {
    try {
      const activated = await activateConfig(sql, await loadConfig(initConfig));
      printLine(`No scoring configuration was active; activated ${initConfig} (${activated.label}).`);
    } catch (error) {
      await sql.close();
      if (error instanceof ConfigError) throw new UsageError(`${initConfig}: ${error.message}`);
      throw error;
    }
    version = await resolveVersionAt(sql, new Date());
  }
  if (!version) {
    warn("error: no scoring configuration is active; run `foxtrust config activate <file>` or pass --init-config");
    await sql.close();
    return EXIT.error;
  }
  const problems = [...checkSchedules(FEEDS, await readLicences(FEEDS)), ...checkSources(FEEDS, version.config)];
  if (problems.length > 0) {
    for (const p of problems) warn(`error: ${p}`);
    await sql.close();
    return EXIT.usage;
  }

  if (heartbeatPath) await mkdir(dirname(heartbeatPath), { recursive: true });
  const stop = startScheduler(sql, FEEDS, warn, heartbeatPath ? { heartbeatPath } : {});
  printLine(`Scheduler running for ${FEEDS.length} feeds and nightly retention (config ${version.config.version}).`);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  stop();
  await sql.close();
  return EXIT.ok;
}
