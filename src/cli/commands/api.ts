import { SQL } from "bun";
import { createAccounts } from "../../api/accounts";
import { ApiConfigError, readApiConfig } from "../../api/config";
import { createKeySet } from "../../api/keyset";
import { createLimits } from "../../api/limits";
import { startApiServer } from "../../api/server";
import { importTrustedKeys } from "../../snapshot/sign";
import { createLoader } from "../../verify/loader";
import { EXIT, printLine, rejectUnknown, UsageError, warn, type Context } from "../util";

/**
 * `api serve`: the public API (spec 010), configured from the environment. Accounts and keys have no
 * command here: they are managed through `src/api/accounts.ts` by the admin panel and the site.
 */
export async function apiServe(args: string[], _ctx: Context): Promise<number> {
  rejectUnknown(args);
  let config;
  let trustedKeys;
  try {
    config = readApiConfig();
    trustedKeys = await importTrustedKeys(config.trustedKeys);
  } catch (error) {
    if (error instanceof ApiConfigError) throw new UsageError(error.message);
    throw new UsageError(`FOXTRUST_TRUSTED_KEYS: ${(error as Error).message}`);
  }

  const sql = new SQL(config.databaseUrl, { max: 4 });
  const accounts = createAccounts(sql, config.free);
  const keys = createKeySet({ load: () => accounts.activeKeys(), log: warn });
  const limits = createLimits({ store: accounts, log: warn });
  // Keys and today's counts must load before the first request: refuse to start otherwise.
  if (!(await keys.reload())) throw new Error(`cannot load API keys: ${keys.status().lastReloadError}`);
  await limits.seed();

  const loader = createLoader({ publicationUrl: config.publicationUrl, trustedKeys, maxAgeHours: config.maxAgeHours });
  const stopUpdates = loader.start(config.updateEvery);
  const stopKeys = keys.start();
  const stopFlush = limits.start();
  const server = startApiServer({ loader, keys, limits, port: config.port, log: warn });
  printLine(
    `API on port ${server.port}: publication ${config.publicationUrl}, ${trustedKeys.length} trusted key(s), ` +
      `${keys.size()} active API key(s), free tier ${config.free.dailyQuota}/day and ${config.free.burst}/s, updates "${config.updateEvery}".`,
  );

  await new Promise<void>((done) => {
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  stopUpdates();
  stopKeys();
  stopFlush();
  await server.stop();
  server.summarize();
  await limits.flush();
  await sql.close();
  return EXIT.ok;
}
